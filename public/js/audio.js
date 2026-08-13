// Audio I/O: 16 kHz PCM16 capture (with noise gate + acoustic echo suppression)
// and 24 kHz playback. The worklets are real files under /worklets/.

import { state } from "./state.js";
import { setLevel, renderStatus } from "./status.js";
import { Resampler } from "./resample.js";

const GATE_HANGOVER_MS = 400; // keep streaming briefly after speech dips
// --- acoustic echo suppression ---
// Some phones on loudspeaker have a browser AEC that doesn't cancel our Web Audio
// (AudioWorklet) playback, so the assistant's own voice bleeds into the mic and gets
// transcribed as "user" speech. While the speaker is actually emitting audio we learn
// the level of that bleed and let only input well above it through — a deliberate
// barge-in still interrupts, but the assistant never loops back on itself. With
// headphones there's no bleed, the estimate stays ~0, and full duplex is preserved.
const ECHO_TAIL_MS = 250; // keep suppressing briefly after playback ends (room reverb +
                          // chunk-scheduling jitter; 120ms was too short and leaked tails)
const ECHO_EMA = 0.05;    // how fast the echo-level estimate tracks (low = stable)
const ECHO_MARGIN = 3.0;  // mic RMS must exceed this × the echo level to count as the
                          // user barging in; anything below is treated as echo → dropped
const ECHO_SEED_FRAMES = 5; // calibrate the echo level over the first ~5 frames (~320ms)
                          // of each utterance instead of latching the first one — see below
const ECHO_SEED_GUARD_MS = 80; // don't seed until the speaker has been emitting this long:
                          // the playback worklet holds a jitter buffer before sound starts,
                          // so early "echoing" frames are just room ambience — seeding the
                          // floor from those would let the real bleed through as barge-in
// While the assistant is speaking, a real barge-in must SUSTAIN for this many frames
// before we forward it. A single echo/noise spike that sneaks past the floor isn't
// enough to crush the reply — only ~190ms of continuous above-floor audio (1024-sample
// frames @ 16kHz ≈ 64ms each) counts as "the user is actually talking over it."
const BARGE_FRAMES = 3;

export async function startMic() {
  // Don't request/force 16 kHz: Firefox honors neither reliably and a mic/context rate
  // mismatch makes createMediaStreamSource throw. Capture at the device's native rate and
  // let the worklet resample to the 16 kHz Gemini expects.
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.capCtx = new (window.AudioContext || window.webkitAudioContext)();
  await state.capCtx.audioWorklet.addModule("worklets/capture.js");
  state.capNode = new AudioWorkletNode(state.capCtx, "cap", {
    processorOptions: { inRate: state.capCtx.sampleRate },
  });
  state.capNode.port.onmessage = (e) => {
    if (!state.micOn) return;
    // Test-mode clip injection owns the stream while it plays — mic frames would
    // double-feed the model with the speaker's echo of the same clip.
    if (state.injecting) return;
    const f32 = e.data;
    // frame energy (RMS)
    let sum = 0; for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);

    const g = state.gate;
    const now = performance.now();

    // --- echo floor: while the speaker is actually emitting (and a short reverb tail
    // after), the mic is mostly hearing our own playback. Learn that bleed level and
    // require input to beat it by ECHO_MARGIN to pass. Seed fast on the first frame,
    // then only learn from sub-threshold frames so a real barge-in spike doesn't drag
    // the estimate up and start gating the user out. ---
    const ec = state.echo;
    // The speaker is a threat while the playback worklet reports it live
    // (state.speakerLive — actual emission, jitter buffer and all) or within
    // the reverb tail after the last emission/arrival estimate.
    const echoing = state.speakerLive || now < state.playUntil + ECHO_TAIL_MS;
    // Only learn the bleed from frames captured while sound was provably
    // leaving the speaker; with the jitter buffer, "echoing" starts before
    // emission does, and those early frames are just room ambience.
    const emitting = state.speakerLive && now - state.liveSince > ECHO_SEED_GUARD_MS;
    if (echoing) {
      if (ec.seedN < ECHO_SEED_FRAMES && emitting) {
        // Calibration window. The first frames after playback starts are captured while
        // the browser AEC is still converging, so the very first one is a loud, barely
        // cancelled peak. Latching the floor to that single frame (the old behavior)
        // pinned the gate high for the whole greeting — you couldn't barge in. Instead
        // take the MIN across the first few frames: as the AEC converges the bleed falls,
        // so the running min is the best estimate of the steady-state bleed and the floor
        // stays low enough to barge in meanwhile. Headphones/quiet → min ~0 (unchanged);
        // phone-on-speaker → min lands on the real converged bleed (protection preserved).
        ec.seedMin = ec.seedMin > 0 ? Math.min(ec.seedMin, rms) : rms;
        ec.seedN++;
        ec.level = ec.seedMin;
      } else if (rms < ec.level * ECHO_MARGIN) {
        ec.level += ECHO_EMA * (rms - ec.level); // track the bleed up/down once calibrated
      }
    } else {
      ec.level = 0; ec.seedMin = 0; ec.seedN = 0; // assistant silent → re-calibrate next utterance, full duplex resumes
    }
    const echoFloor = echoing ? ec.level * ECHO_MARGIN : 0;

    // --- noise gate: drop frames below the user-set floor or the echo floor ---
    const floor = Math.max(g.floor, echoFloor);
    const above = floor <= 0 || rms > floor;     // this frame clears the floor
    if (above) g.openUntil = now + GATE_HANGOVER_MS;
    g.aboveRun = above ? g.aboveRun + 1 : 0;     // consecutive clearing frames
    const open = now < g.openUntil;
    setLevel(rms, open); // always show the real level so the user can tune the slider

    if (!open) return; // gate closed → ignore background noise / our own echo entirely

    // While FormSpeak is speaking, only a SUSTAINED barge-in reaches the server. A lone
    // echo/noise spike that clears the floor isn't enough — without this, the model hears
    // its own bleed (or a stray sound) and interrupts itself, crushing the reply. A real
    // barge-in holds above the floor for BARGE_FRAMES (~190ms) and still cuts it off; the
    // moment it does, the server sends `interrupted`, phase flips to listening, and the
    // rest of the utterance flows normally (this guard no longer applies).
    if (state.phase === "speaking" && g.aboveRun < BARGE_FRAMES) return;

    // PCM16 → base64
    const pcm = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); pcm[i] = s * 0x7fff; }
    sendAudio(b64(pcm.buffer));
  };
  state.capCtx.createMediaStreamSource(state.micStream).connect(state.capNode);
  state.micOn = true;
  renderStatus();
}

export function setMicOn(on) {
  state.micOn = on;
  if (state.micStream) state.micStream.getAudioTracks().forEach((t) => (t.enabled = on));
  if (on) {
    state.pauseMsg = ""; // resuming → drop any auto-pause notice
    state.phase = "listening";
  } else {
    // PTT-style commit on pause. We've just stopped sending frames (micOn=false), so if
    // the user tapped pause within the 700ms VAD silence window their turn would never
    // commit and FormSpeak would sit silent. audioStreamEnd flushes the cached audio so
    // the model treats it as end-of-turn and replies — playback works while muted.
    // GUARD: skip it while FormSpeak is speaking. There's no pending user turn to end,
    // and flushing any leaked echo there could be read as a barge-in.
    if (state.phase !== "speaking") sendAudioStreamEnd();
    setLevel(0); clearTimeout(state.thinkTimer);
  }
  renderStatus();
}

// Fully release the mic device — not just mute it. A paused track (enabled=false)
// still holds the microphone, so the OS keeps showing the "in use" indicator and
// the tab counts as recording. Stopping the tracks + closing the capture context
// hands the device back. The ws session is left intact; resume re-acquires via
// startMic(). Idempotent and safe to call when nothing is acquired.
export function releaseMic() {
  if (state.micStream) { state.micStream.getTracks().forEach((t) => t.stop()); state.micStream = null; }
  if (state.capCtx) { state.capCtx.close().catch(() => {}); state.capCtx = null; state.capNode = null; }
  state.micOn = false;
  clearTimeout(state.thinkTimer);
  setLevel(0);
  renderStatus();
}

export function sendAudio(base64) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64 } } }));
}

// Tell Gemini the audio stream ended (mic paused) so it finalizes the current turn and
// replies, instead of waiting for trailing silence it will never receive. Valid with
// automatic VAD enabled; resuming (sending audio again) reopens the stream automatically.
export function sendAudioStreamEnd() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
}

let playRs = null; // 24 kHz → device-rate resampler (created with the context)

export async function playAudio(base64) {
  if (!state.playInit) {
    // Single guarded init: chunks arrive back-to-back, and the old create-on-
    // first-call pattern let chunk 2 race chunk 1's awaits (playCtx already
    // set, playNode still undefined) and get dropped with a TypeError.
    state.playInit = (async () => {
      // Deliberately NOT { sampleRate: 24000 }: on iOS the hardware session
      // runs at its own rate (48 kHz in play-and-record), and a context at any
      // other rate goes through the OS resampler — a periodic-crackle-prone
      // path that iOS updates keep re-breaking. Run at the device rate and
      // resample ourselves (resample.js) so the OS never has to.
      state.playCtx = new (window.AudioContext || window.webkitAudioContext)();
      await state.playCtx.audioWorklet.addModule("worklets/playback.js");
      state.playNode = new AudioWorkletNode(state.playCtx, "play");
      // The worklet reports ACTUAL emission ("live"/"idle"/"stopped"), which
      // is what the mic's echo gate keys on — its jitter buffer makes real
      // sound lag chunk arrival, so arrival math alone under-covers the tail.
      state.playNode.port.onmessage = (e) => {
        if (e.data === "live") {
          state.speakerLive = true; state.liveSince = performance.now();
        } else {
          state.speakerLive = false;
          // Natural drain ("idle"): emission truly ended NOW — run the echo
          // tail from here, not from the (earlier) arrival estimate. After a
          // barge-in ("stopped") gating must end immediately instead, so
          // leave playUntil where stopPlayback zeroed it.
          if (e.data === "idle") state.playUntil = Math.max(state.playUntil, performance.now());
        }
      };
      state.playNode.connect(state.playCtx.destination);
      playRs = new Resampler(24000, state.playCtx.sampleRate);
    })();
  }
  await state.playInit;
  if (state.playCtx.state === "suspended") await state.playCtx.resume();
  const bin = atob(base64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer), f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  state.playNode.port.postMessage(playRs.process(f32));
  // Mark how long the speaker will keep emitting so the mic gate can suppress the echo
  // of this playback (see capture handler). Chunks play back-to-back, so extend the tail
  // from whichever is later — the previous end or now. This arrival-based estimate covers
  // the FRONT of the utterance (suppression starts before the jitter buffer releases
  // sound); the worklet's "live"/"idle" reports cover the back.
  const durMs = (f32.length / 24000) * 1000;
  state.playUntil = Math.max(state.playUntil, performance.now()) + durMs;
}

export function stopPlayback() {
  if (state.playNode) state.playNode.port.postMessage("stop");
  if (playRs) playRs.reset(); // next utterance must not interpolate from the flushed tail
  state.speakerLive = false;
  state.playUntil = 0; // speaker silenced (barge-in / interrupt) → stop gating immediately
}

export function b64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
