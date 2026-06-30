// Inline AudioWorklet processors, shipped as Blob URLs so the whole extension stays
// bundleable by the Blocks CLI (no separate worklet file has to be served — Airtable
// serves a single JS bundle from its own origin, and addModule(blobURL) works inside
// the extension iframe just like in a normal page).
//
// CAPTURE  — buffers raw mic Float32 frames into 1024-sample chunks (16 kHz) and posts
//            them to the main thread, which gates + PCM16-encodes them for Gemini.
// PLAYBACK — a tiny jitter-buffer: queues decoded 24 kHz Float32 chunks from the model
//            and streams them to the speaker gap-free; "stop" flushes it on a barge-in.

export const CAPTURE_WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.size=1024; this.buf=new Float32Array(this.size); this.i=0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let n=0;n<ch.length;n++){ this.buf[this.i++]=ch[n];
      if (this.i>=this.size){ this.port.postMessage(this.buf.slice()); this.i=0; } }
    return true;
  }
}
registerProcessor("cap", Cap);`;

export const PLAYBACK_WORKLET = `
class Play extends AudioWorkletProcessor {
  constructor(){ super(); this.q=[]; this.off=0;
    this.port.onmessage=(e)=>{ if(e.data==="stop"){this.q=[];this.off=0;} else this.q.push(e.data); }; }
  process(_,outputs){
    const out=outputs[0][0]; if(!out) return true; let i=0;
    while(i<out.length && this.q.length){ const b=this.q[0]; const cp=Math.min(out.length-i, b.length-this.off);
      for(let k=0;k<cp;k++) out[i++]=b[this.off++];
      if(this.off>=b.length){ this.q.shift(); this.off=0; } }
    while(i<out.length) out[i++]=0;
    return true;
  }
}
registerProcessor("play", Play);`;

export const blobURL = (code) =>
    URL.createObjectURL(new Blob([code], { type: "application/javascript" }));

// base64 <-> binary helpers used by the PCM16 send / 24 kHz playback paths.
export function b64FromBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
export function f32FromB64Pcm16(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    return f32;
}
