// Microphone capture worklet: device-rate Float32 in → 16 kHz Float32 frames out.
//
// Gemini wants 16 kHz PCM. We can't just run the capture AudioContext at 16 kHz —
// Firefox refuses to createMediaStreamSource when the mic track's native rate (usually
// 44.1/48 kHz) differs from the context rate. So the context runs at the device rate and
// we resample to 16 kHz here (linear interpolation; fine for speech after the browser AEC).
class Cap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.step = ((o && o.processorOptions && o.processorOptions.inRate) || sampleRate) / 16000;
    this.pos = 0; this.prev = 0;             // fractional read cursor + last sample of prev block
    this.size = 1024; this.buf = new Float32Array(this.size); this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const n = ch.length; let pos = this.pos;
    while (pos < n) {
      const i0 = Math.floor(pos), f = pos - i0;
      const a = i0 < 0 ? this.prev : ch[i0];
      if (i0 + 1 >= n) break;                // next sample is in the following block — carry over
      this.buf[this.i++] = a + (ch[i0 + 1] - a) * f;
      if (this.i >= this.size) { this.port.postMessage(this.buf.slice()); this.i = 0; }
      pos += this.step;
    }
    this.prev = ch[n - 1]; this.pos = pos - n; // rebase the cursor onto the next block
    return true;
  }
}
registerProcessor("cap", Cap);
