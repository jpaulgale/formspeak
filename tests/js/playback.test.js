// Playback pipeline tests: the real worklet file driven in 128-sample render
// quanta with network-realistic chunk arrival jitter (the exact conditions
// that produced audible popping on phones — see worklet-host.js). The chunk
// path mirrors production: 24 kHz model audio → main-thread Resampler →
// device-rate worklet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim, QUANTUM, countClicks, countDropouts, makeTone, jitteredChunks, mulberry32 } from "./worklet-host.js";
import { Resampler } from "../../public/js/resample.js";

const WORKLET = new URL("../../public/worklets/playback.js", import.meta.url).pathname;
const IN_RATE = 24000;
const CTX_RATE = 48000; // iOS hardware rate in play-and-record mode
const CARRIER = 317;
const maxSlopeAt = (rate) => 3 * ((2 * Math.PI * CARRIER) / rate) * 0.8;

// Production chunk path: slice the 24 kHz source into jittered arrivals, then
// resample each chunk through one continuous Resampler, like audio.js does.
function jitteredResampledEvents(tone, opts) {
  const rs = new Resampler(IN_RATE, CTX_RATE);
  return jitteredChunks(tone, IN_RATE, opts).map((ev) => ({ t: ev.t, data: rs.process(ev.data) }));
}

test("mobile jitter: zero clicks, zero mid-speech dropouts", () => {
  // The jitter model that made the OLD worklet drop out 2-5 times per
  // utterance (avg, 20 seeds) — the popping the user heard on iPhone.
  for (let seed = 1; seed <= 20; seed++) {
    const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
    const events = jitteredResampledEvents(makeTone(8, IN_RATE), {
      chunkMs: 500, jitterMs: 20, spikeP: 0.3, spikeMs: 90, rand: mulberry32(seed),
    });
    const out = sim.run(events, 10);
    assert.equal(countClicks(out, maxSlopeAt(CTX_RATE)), 0, `seed ${seed}: hard clicks`);
    assert.equal(countDropouts(out, CTX_RATE, 0.5), 0, `seed ${seed}: dropouts`);
  }
});

test("a latency spike beyond the jitter buffer degrades to a smooth pause, never a click", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
    const events = jitteredResampledEvents(makeTone(6, IN_RATE), {
      chunkMs: 400, jitterMs: 30, spikeP: 0.4, spikeMs: 350, rand: mulberry32(seed),
    });
    const out = sim.run(events, 9);
    assert.equal(countClicks(out, maxSlopeAt(CTX_RATE)), 0, `seed ${seed}`);
  }
});

test("silence in, silence out", () => {
  const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
  const out = sim.run([], 3);
  assert.ok(out.every((s) => s === 0));
});

test("chunk arriving mid-fade cannot step-jump the output (old worklet bug)", () => {
  const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
  const rs = new Resampler(IN_RATE, CTX_RATE);
  const tone = makeTone(1.2, IN_RATE);
  const cut = Math.round(0.1 * IN_RATE);
  const events = [
    { t: 0.01, data: rs.process(tone.slice(0, cut)) },
    // lands ~1.5ms after the first chunk drains, mid-fade in the old code
    { t: 0.01 + 0.08 + 0.1 + 0.0015, data: rs.process(tone.slice(cut)) },
  ];
  const out = sim.run(events, 1.6);
  assert.equal(countClicks(out, maxSlopeAt(CTX_RATE)), 0);
});

test('"stop" (barge-in) flushes within the 3ms ramp and posts "stopped"', () => {
  const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
  const rs = new Resampler(IN_RATE, CTX_RATE);
  const events = [
    { t: 0.01, data: rs.process(makeTone(2, IN_RATE)) },
    { t: 0.5, data: "stop" },
  ];
  const out = sim.run(events, 1.0);
  // after the stop + fade (3ms) + one quantum of slack, output is dead silent
  const silentFrom = Math.ceil((0.5 + 0.003) * CTX_RATE) + QUANTUM;
  assert.ok(out.slice(silentFrom).every((s) => s === 0), "audio kept playing after barge-in");
  assert.equal(countClicks(out, maxSlopeAt(CTX_RATE)), 0);
  assert.ok(sim.messages.some((m) => m.data === "stopped"));
});

test("a lone short tail chunk still plays, one jitter-lead later", () => {
  const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
  const rs = new Resampler(IN_RATE, CTX_RATE);
  // 40ms chunk, nothing after it — must not be held hostage waiting for more
  const events = [{ t: 0.05, data: rs.process(makeTone(0.04, IN_RATE)) }];
  const out = sim.run(events, 0.5);
  const first = out.findIndex((s) => s !== 0);
  assert.ok(first >= 0, "tail chunk never played");
  const startMs = (first / CTX_RATE) * 1000;
  assert.ok(startMs < 50 + 120 + 10, `tail chunk held too long (${startMs.toFixed(1)}ms)`);
});

test("echo-gate contract: every emitted sample is covered by live/idle reports", () => {
  // The reason the first jitter buffer was reverted (1f28697): buffered audio
  // kept playing after the arrival-time estimate expired, the mic gate
  // reopened, and the model heard itself. The worklet now self-reports; check
  // sound only ever leaves the speaker inside a reported-live window (plus
  // the 3ms fade tail, well inside audio.js's 250ms ECHO_TAIL_MS).
  const sim = new Sim(WORKLET, { sampleRate: CTX_RATE });
  const events = jitteredResampledEvents(makeTone(6, IN_RATE), {
    chunkMs: 400, jitterMs: 30, spikeP: 0.4, spikeMs: 200, rand: mulberry32(7),
  });
  const out = sim.run(events, 8);
  // rebuild live windows from the messages (stamped at quantum starts)
  let live = false, liveEnd = -1;
  const windows = [];
  for (const m of sim.messages) {
    if (m.data === "live" && !live) { live = true; windows.push({ start: m.t, end: Infinity }); }
    else if ((m.data === "idle" || m.data === "stopped") && live) { live = false; windows.at(-1).end = m.t; }
  }
  const FADE_TAIL = 0.003 + (2 * QUANTUM) / CTX_RATE; // ramp + message-stamping slack
  for (let i = 0; i < out.length; i++) {
    if (out[i] === 0) continue;
    const t = i / CTX_RATE;
    const covered = windows.some((w) => t >= w.start - (2 * QUANTUM) / CTX_RATE && t <= w.end + FADE_TAIL);
    assert.ok(covered, `sample at ${t.toFixed(4)}s emitted outside any reported-live window`);
  }
  assert.ok(windows.length >= 1);
});

test("resampler: continuous across chunk boundaries, no boundary clicks", () => {
  const rs = new Resampler(IN_RATE, CTX_RATE);
  const tone = makeTone(2, IN_RATE);
  const parts = [];
  // ragged chunk sizes to stress the fractional-cursor carry
  for (let off = 0; off < tone.length; ) {
    const n = Math.min(997 + (off % 13), tone.length - off);
    parts.push(rs.process(tone.slice(off, off + n)));
    off += n;
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const joined = new Float32Array(total);
  for (let off = 0, i = 0; i < parts.length; i++) { joined.set(parts[i], off); off += parts[i].length; }
  assert.ok(Math.abs(total - tone.length * (CTX_RATE / IN_RATE)) < 8, `length drifted: ${total}`);
  assert.equal(countClicks(joined, maxSlopeAt(CTX_RATE)), 0);
  // identity fast-path
  const same = new Resampler(24000, 24000);
  assert.equal(same.process(tone), tone);
});
