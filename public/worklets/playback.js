// Assistant-audio playback worklet: a FIFO of Float32 chunks (already at the
// context's device rate — audio.js resamples 24 kHz → device rate on the way
// in) drained into the output. "stop" flushes the queue instantly — that's
// what makes barge-in cut the assistant off mid-sentence instead of letting
// the buffered tail play out.
//
// JITTER BUFFER: chunks arrive over a WebSocket at roughly realtime pace, so
// on a jittery mobile connection each chunk can land a few ms after the
// previous one drained. Played the instant they arrive (the old behavior),
// every late chunk was a mid-vowel dropout — an audible pop roughly once per
// chunk. Instead, playback (re)starts PRE_MS after audio reaches an empty
// queue — a TIME delay, not a fill threshold: the stream arrives at realtime
// pace, so only starting late creates a lasting lead over the arrival
// schedule (a fill threshold is met instantly by one big chunk and buys no
// lead at all). Every arrival can then be up to PRE_MS later than realtime
// before the output feels it. An earlier jitter buffer was removed (1f28697)
// because the mic's echo gate estimated speaker activity from chunk ARRIVAL
// times, and buffering made real emission outlast the estimate; now the
// worklet reports actual emission over the port ("live" / "idle" /
// "stopped") and audio.js gates on that, so buffering is safe.
//
// MICRO-RAMPS de-click whatever dropouts remain (jitter beyond the buffer):
// jumping from the waveform to 0 is a pop, so the last sample fades to zero
// over ~3 ms and audio ramps back in over ~3 ms when it resumes (also on
// "stop", which de-clicks barge-in). Playback never restarts mid-fade — the
// fade finishes first — so resume can't step-jump the output.
const PRE_MS = 120; // jitter lead: how long after first data playback (re)starts —
                    // sized to absorb typical mobile radio latency spikes (~100ms);
                    // costs once-per-utterance latency, never barge-in latency
                    // (the "stop" flush bypasses the buffer entirely)
const RAMP_MS = 3;

class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ramp = Math.max(1, Math.round((sampleRate * RAMP_MS) / 1000));
    this.pre = Math.round((sampleRate * PRE_MS) / 1000);
    this.q = []; this.off = 0;
    this.buffered = 0;  // queued samples not yet played
    this.playing = false; this.waited = 0;
    this.gain = 0;      // ramp-in progress: climbs 0 → 1 over `ramp` samples on resume
    this.tail = 0;      // last emitted sample — the fade-out starts from here
    this.tailN = 0;     // fade-out samples remaining
    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.q = []; this.off = 0; this.buffered = 0;
        this.waited = 0;
        // If a fade is already running, let it finish — restarting it would
        // jump the envelope back up. Only a playing stream needs a new fade.
        if (this.playing) { this.playing = false; this.fadeOut(); this.port.postMessage("stopped"); }
      } else {
        this.q.push(e.data); this.buffered += e.data.length;
      }
    };
  }
  fadeOut() {
    this.tailN = this.ramp; // fade out from the sample we were at
  }
  process(_, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    // Port messages only land between render quanta, so the buffer can't grow
    // mid-quantum — decide once per quantum whether to (re)start playback.
    // `waited` counts up from the first chunk into an empty queue; playback
    // starts PRE_MS later, and that delay is the jitter lead.
    if (!this.playing && this.buffered > 0 && this.tailN === 0) {
      this.waited += out.length;
      if (this.waited >= this.pre) {
        this.playing = true; this.gain = 0; this.waited = 0;
        this.port.postMessage("live");
      }
    }
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.q.length) {
        const b = this.q[0];
        let s = b[this.off++]; this.buffered--;
        if (this.gain < 1) { this.gain = Math.min(1, this.gain + 1 / this.ramp); s *= this.gain; }
        out[i] = s; this.tail = s;
        if (this.off >= b.length) { this.q.shift(); this.off = 0; }
      } else {
        if (this.playing) { // ran dry mid-quantum → fade, re-buffer, tell the gate
          this.playing = false; this.fadeOut();
          this.port.postMessage("idle");
        }
        out[i] = this.tailN > 0 ? this.tail * (--this.tailN / this.ramp) : 0;
      }
    }
    return true;
  }
}
registerProcessor("play", Play);
