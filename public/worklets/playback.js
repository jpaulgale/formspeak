// Assistant-audio playback worklet: a FIFO of Float32 chunks (24 kHz) drained
// into the output. "stop" flushes the queue instantly — that's what makes
// barge-in cut the assistant off mid-sentence instead of letting the buffered
// tail play out.
//
// Two smoothing mechanisms keep chunk-boundary artifacts inaudible:
//
// - MICRO-RAMPS: when the queue runs dry mid-utterance (a chunk arrived late),
//   jumping straight from the waveform to 0 is an instantaneous discontinuity —
//   an audible click, and on jittery mobile connections a whole crackle of
//   them. Instead the last sample fades to zero over ~3 ms, and audio ramps
//   back in over ~3 ms when it resumes (also on "stop", which de-clicks
//   barge-in). Too short to hear as a fade; long enough to kill the pop.
//
// - JITTER BUFFER: after running dry, playback holds until ~120 ms is queued
//   again, so one late chunk becomes a single clean pause instead of a rapid
//   stutter of tiny gaps. Replies usually open with a chunk bigger than this,
//   so in practice it adds no perceptible latency to turn starts.
const RAMP = 72; // samples ≈ 3 ms @ 24 kHz
const PREBUFFER = 2880; // samples ≈ 120 ms @ 24 kHz

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0;
    this.queued = 0;      // samples currently buffered across the queue
    this.starving = true; // waiting for PREBUFFER to fill (start, underrun, or stop)
    this.gain = 0;        // ramp-in progress: climbs 0 → 1 over RAMP samples on resume
    this.tail = 0;        // last emitted sample — the fade-out starts from here
    this.tailN = 0;       // fade-out samples remaining
    this.port.onmessage = (e) => {
      if (e.data === "stop") { this.q = []; this.off = 0; this.queued = 0; this.starve(); }
      else { this.q.push(e.data); this.queued += e.data.length; }
    };
  }
  starve() {
    if (!this.starving) this.tailN = RAMP; // fade out from the sample we were at
    this.starving = true;
    this.gain = 0; // next resume ramps back in
  }
  process(_, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (this.starving && this.queued >= PREBUFFER) this.starving = false;
      if (!this.starving && this.q.length) {
        const b = this.q[0];
        let s = b[this.off++]; this.queued--;
        if (this.gain < 1) { this.gain = Math.min(1, this.gain + 1 / RAMP); s *= this.gain; }
        out[i++] = s; this.tail = s;
        if (this.off >= b.length) { this.q.shift(); this.off = 0; }
      } else {
        if (!this.starving) this.starve(); // ran dry mid-utterance → underrun
        out[i++] = this.tailN > 0 ? this.tail * (--this.tailN / RAMP) : 0;
      }
    }
    return true;
  }
}
registerProcessor("play", Play);
