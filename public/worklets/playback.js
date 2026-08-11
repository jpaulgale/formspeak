// Assistant-audio playback worklet: a FIFO of Float32 chunks (24 kHz) drained
// into the output. "stop" flushes the queue instantly — that's what makes
// barge-in cut the assistant off mid-sentence instead of letting the buffered
// tail play out.
//
// MICRO-RAMPS de-click chunk-boundary underruns: when the queue runs dry (a
// chunk arrived late), jumping straight from the waveform to 0 is an audible
// pop — on jittery mobile connections, a crackle of them. Instead the last
// sample fades to zero over ~3 ms and audio ramps back in over ~3 ms when it
// resumes (also on "stop", which de-clicks barge-in). Too short to hear as a
// fade; long enough to kill the pop.
//
// DELIBERATELY NO JITTER BUFFER: chunks must play the moment they arrive.
// The acoustic echo suppressor (audio.js) estimates when the speaker is
// emitting from chunk ARRIVAL times (state.playUntil); holding audio back to
// re-buffer makes real emission lag that estimate, the mic gate reopens while
// the assistant is still talking, and the model hears its own voice and
// interrupts itself — the exact failure the suppressor exists to prevent.
const RAMP = 72; // samples ≈ 3 ms @ 24 kHz

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0;
    this.gain = 0; // ramp-in progress: climbs 0 → 1 over RAMP samples on resume
    this.tail = 0; // last emitted sample — the fade-out starts from here
    this.tailN = 0; // fade-out samples remaining
    this.port.onmessage = (e) => {
      if (e.data === "stop") { this.q = []; this.off = 0; this.fadeOut(); }
      else this.q.push(e.data);
    };
  }
  fadeOut() {
    this.tailN = RAMP; // fade out from the sample we were at
    this.gain = 0;     // next audio ramps back in
  }
  process(_, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (this.q.length) {
        const b = this.q[0];
        let s = b[this.off++];
        if (this.gain < 1) { this.gain = Math.min(1, this.gain + 1 / RAMP); s *= this.gain; }
        out[i++] = s; this.tail = s; this.tailN = 0;
        if (this.off >= b.length) { this.q.shift(); this.off = 0; }
      } else {
        if (this.tailN === 0 && this.gain === 1) this.fadeOut(); // just ran dry → start the fade
        out[i++] = this.tailN > 0 ? this.tail * (--this.tailN / RAMP) : 0;
      }
    }
    return true;
  }
}
registerProcessor("play", Play);
