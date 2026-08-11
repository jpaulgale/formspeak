// Test mode (?test=1) — telemetry flagged is_test + local clip injector.
// The injector streams a pre-generated TTS corpus clip (tests/audio/, served
// by serve.py under /tests/) into the SAME send path the mic uses, and plays
// it on the speakers so a demo audience hears the "user". Deployed site:
// the flag still applies, the injector just hides (no local corpus).

import { state } from "./state.js";
import { IS_TEST, logEvent } from "./telemetry.js";
import { sendAudio, b64 } from "./audio.js";

export async function initTestMode() {
  if (!IS_TEST) return;
  state.injecting = false;

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:9999;background:rgba(10,14,20,.88);color:#fff;" +
    "font:11px/1.5 ui-monospace,monospace;padding:8px 10px;border-radius:10px;max-width:300px;" +
    "backdrop-filter:blur(6px);max-height:60vh;overflow:auto";
  panel.innerHTML = "<b>TEST MODE</b> · session flagged <code>is_test</code><br/>";
  document.body.appendChild(panel);

  let manifest = null;
  try { manifest = await (await fetch("/tests/manifest.json")).json(); } catch {}
  if (!manifest) { panel.innerHTML += "<i>no local corpus — clip injector off</i>"; return; }

  // Parse a corpus WAV (PCM16 mono 16 kHz from make_corpus.py) → Int16Array.
  const wavPCM = (buf) => {
    const dv = new DataView(buf);
    let off = 12; // skip RIFF header
    while (off + 8 <= dv.byteLength) {
      const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
      const size = dv.getUint32(off + 4, true);
      if (id === "data") return new Int16Array(buf, off + 8, size / 2);
      off += 8 + size + (size % 2);
    }
    return new Int16Array(0);
  };

  async function injectClip(file, btn) {
    if (state.injecting) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) { btn.textContent = "⚠ start the session first"; return; }
    state.injecting = true;
    btn.style.opacity = "0.5";
    logEvent("test_clip", { file });
    try {
      const pcm = wavPCM(await (await fetch("/tests/audio/" + file)).arrayBuffer());
      // Speaker playback for the audience (16 kHz buffer; browser resamples).
      try {
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const ab = actx.createBuffer(1, pcm.length, 16000);
        const ch = ab.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
        const src = actx.createBufferSource();
        src.buffer = ab; src.connect(actx.destination); src.start();
        src.onended = () => actx.close().catch(() => {});
      } catch {}
      // Stream into the model at real-time pace via the mic's own send path,
      // then ~1.2s of silence so the 700ms server VAD closes the turn.
      const step = 2048; // samples per 128ms chunk at 16 kHz
      for (let i = 0; i < pcm.length; i += step) {
        sendAudio(b64(pcm.slice(i, i + step).buffer));
        await new Promise((r) => setTimeout(r, 128));
      }
      const silence = new Int16Array(step);
      for (let k = 0; k < 10; k++) {
        sendAudio(b64(silence.buffer));
        await new Promise((r) => setTimeout(r, 128));
      }
    } finally {
      // Small tail so the speaker echo of the clip never leaks through the mic.
      setTimeout(() => { state.injecting = false; }, 400);
      btn.style.opacity = "";
    }
  }

  const byScenario = {};
  for (const m of Object.values(manifest)) {
    const sc = m.file.split("/")[0];
    (byScenario[sc] ||= []).push(m);
  }
  const sel = document.createElement("select");
  sel.style.cssText = "width:100%;margin:6px 0;background:#222;color:#fff;border-radius:6px;padding:2px";
  for (const sc of Object.keys(byScenario)) sel.append(new Option(sc, sc));
  const list = document.createElement("div");
  const render = () => {
    list.innerHTML = "";
    for (const m of byScenario[sel.value]) {
      const btn = document.createElement("button");
      btn.style.cssText =
        "display:block;width:100%;text-align:left;margin:2px 0;padding:3px 6px;background:#1c2733;" +
        "color:#dfe9f3;border:0;border-radius:6px;cursor:pointer;font:inherit";
      btn.textContent = "▶ " + m.text.slice(0, 42) + (m.text.length > 42 ? "…" : "");
      btn.title = m.text;
      btn.onclick = () => injectClip(m.file, btn);
      list.appendChild(btn);
    }
  };
  sel.onchange = render;
  panel.append(sel, list);
  render();
}
