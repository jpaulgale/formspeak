// Assistant-audio playback worklet: a FIFO of Float32 chunks (24 kHz) drained into
// the output. "stop" flushes the queue instantly — that's what makes barge-in cut
// the assistant off mid-sentence instead of letting the buffered tail play out.
class Play extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.off = 0;
    this.port.onmessage = (e) => { if (e.data === "stop") { this.q = []; this.off = 0; } else this.q.push(e.data); };
  }
  process(_, outputs) {
    const out = outputs[0][0]; if (!out) return true; let i = 0;
    while (i < out.length && this.q.length) {
      const b = this.q[0]; const cp = Math.min(out.length - i, b.length - this.off);
      for (let k = 0; k < cp; k++) out[i++] = b[this.off++];
      if (this.off >= b.length) { this.q.shift(); this.off = 0; }
    }
    while (i < out.length) out[i++] = 0;
    return true;
  }
}
registerProcessor("play", Play);
