// Linear-interpolation resampler, continuous across chunks — the playback
// mirror of the capture worklet's device-rate → 16 kHz downsampler.
//
// Why resample ourselves instead of forcing the playback AudioContext to
// 24 kHz (the model's output rate): on iOS the hardware session runs at its
// own rate (48 kHz in play-and-record mode, i.e. whenever the mic is live),
// and a context at any other rate is resampled by WebKit/CoreAudio — a path
// with a history of periodic crackle, and one an iOS update can regress at
// any time. Running the context at the device's native rate keeps the OS
// resampler out of the signal path entirely; linear interpolation is
// transparent for 24 kHz speech.
export class Resampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.pos = 0;   // fractional read cursor into the current chunk
    this.prev = 0;  // last sample of the previous chunk (boundary interpolation)
  }
  reset() { this.pos = 0; this.prev = 0; }
  // 24 kHz Float32 chunk in → device-rate Float32 chunk out. Sample counts
  // per chunk vary by ±1; the fractional cursor carries across calls so the
  // output stream is gapless and click-free at chunk boundaries.
  process(ch) {
    if (this.step === 1) return ch;
    const n = ch.length;
    const out = new Float32Array(Math.ceil((n - this.pos) / this.step) + 2);
    let i = 0, pos = this.pos;
    while (pos < n) {
      const i0 = Math.floor(pos), f = pos - i0;
      const a = i0 < 0 ? this.prev : ch[i0];
      if (i0 + 1 >= n) break; // next source sample is in the following chunk — carry over
      out[i++] = a + (ch[i0 + 1] - a) * f;
      pos += this.step;
    }
    this.prev = ch[n - 1]; this.pos = pos - n; // rebase the cursor onto the next chunk
    return out.slice(0, i);
  }
}
