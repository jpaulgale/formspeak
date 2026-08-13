// Minimal AudioWorklet host for Node: loads a real worklet file from
// public/worklets/ and drives its process() in 128-sample render quanta
// against a virtual clock, delivering port messages between quanta exactly
// like a browser does. Lets CI reproduce timing bugs (underruns, clicks,
// barge-in flush latency) that only show up under network jitter.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export const QUANTUM = 128;

// Load a worklet source file and return its registered processor class,
// instantiated the way a browser would (with a port and a sampleRate global).
export function loadWorklet(path, { sampleRate, processorOptions } = {}) {
  const registry = {};
  const outbox = []; // messages the worklet posts back (collected with timestamps by Sim)
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (data) => outbox.push(data),
      };
    }
  }
  const ctx = vm.createContext({
    AudioWorkletProcessor,
    registerProcessor: (name, cls) => (registry[name] = cls),
    sampleRate: sampleRate || 48000,
    Math, Float32Array,
  });
  vm.runInContext(readFileSync(path, "utf8"), ctx, { filename: path });
  const name = Object.keys(registry)[0];
  const node = new registry[name]({ processorOptions });
  return { node, outbox, name };
}

// Drive a worklet in virtual real time. `events` is a list of
// { t: seconds, data: Float32Array | "stop" } delivered to the worklet's
// port before the first quantum whose start time is >= t — the same
// "messages land between render quanta" contract as the browser.
export class Sim {
  constructor(path, { sampleRate = 48000, processorOptions } = {}) {
    this.rate = sampleRate;
    const w = loadWorklet(path, { sampleRate, processorOptions });
    this.node = w.node;
    this.outboxRaw = w.outbox;
    this.messages = []; // { t, data } the worklet posted, stamped at quantum end
    this.t = 0;
  }
  // events: [{ t: seconds, data }] sorted or not; renders `seconds` of output.
  run(events, seconds) {
    const evs = [...events].sort((a, b) => a.t - b.t);
    const total = Math.ceil((seconds * this.rate) / QUANTUM) * QUANTUM;
    const out = new Float32Array(total);
    let e = 0;
    for (let start = 0; start < total; start += QUANTUM) {
      const now = start / this.rate;
      while (e < evs.length && evs[e].t <= now) {
        this.node.port.onmessage({ data: evs[e].data });
        e++;
      }
      const block = new Float32Array(QUANTUM);
      this.node.process([], [[block]]);
      out.set(block, start);
      while (this.outboxRaw.length) this.messages.push({ t: now, data: this.outboxRaw.shift() });
      this.t = now + QUANTUM / this.rate;
    }
    return out;
  }
}

// --- analysis helpers ---

// Hard discontinuities: sample-to-sample jumps far beyond what the source
// signal can produce. `maxSlope` is the largest legitimate per-sample delta.
export function countClicks(samples, maxSlope) {
  let clicks = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i] - samples[i - 1]) > maxSlope) clicks++;
  }
  return clicks;
}

// Dropout episodes: runs of (near-)silence of at least minMs strictly between
// the first and last non-silent sample — i.e. the audio cut out mid-utterance.
export function countDropouts(samples, rate, minMs = 2, eps = 1e-4) {
  let first = -1, last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > eps) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return 0;
  const minRun = Math.ceil((minMs / 1000) * rate);
  let n = 0, run = 0;
  for (let i = first; i <= last; i++) {
    if (Math.abs(samples[i]) <= eps) {
      run++;
    } else {
      if (run >= minRun) n++;
      run = 0;
    }
  }
  return n;
}

// Deterministic PRNG so jitter patterns are reproducible in CI.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A speech-like test tone: ~317 Hz carrier with slow AM, amplitude 0.8.
// Pure enough that any discontinuity is detectable; the carrier deliberately
// doesn't divide typical chunk lengths, so chunk boundaries never land on a
// zero crossing (where a cut would be inaudible and undetectable).
export function makeTone(seconds, rate = 24000, carrier = 317, am = 2.7) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] = 0.8 * (0.75 + 0.25 * Math.sin(2 * Math.PI * am * t)) * Math.sin(2 * Math.PI * carrier * t);
  }
  return out;
}

// Slice a source signal into chunks of `chunkMs`, arriving at a realtime pace
// with per-chunk network jitter: a base U(0, jitterMs) plus occasional radio
// latency spikes (spikeP chance of an extra U(spikeMs/3, spikeMs)). This is
// the shape of Gemini Live audio over a mobile connection — WiFi power-save
// and cellular radio state transitions batch/delay WebSocket frames.
export function jitteredChunks(src, rate, { chunkMs = 500, jitterMs = 20, spikeP = 0, spikeMs = 0, startT = 0.05, rand = mulberry32(1) } = {}) {
  const chunk = Math.round((chunkMs / 1000) * rate);
  const events = [];
  for (let off = 0, i = 0; off < src.length; off += chunk, i++) {
    const data = src.slice(off, Math.min(off + chunk, src.length));
    let j = rand() * jitterMs;
    if (spikeP && rand() < spikeP) j += spikeMs / 3 + (rand() * spikeMs * 2) / 3;
    events.push({ t: startT + (i * chunkMs) / 1000 + j / 1000, data });
  }
  return events;
}

// 16-bit PCM mono WAV, so a human can listen to what the sim rendered.
export function wavBytes(samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}
