// Mic-dock status UI + the phase machine: listening (your turn) → thinking
// (you paused, model is working) → speaking (model replying).

import { tap } from "./config.js";
import { state } from "./state.js";
import { $, escapeHTML, announce } from "./dom.js";
import { renderCard } from "./card.js";

const STATUS = {
  listening: { glyph: "",     text: "Listening… " + tap + " to pause", aria: "Stop listening",       say: "Listening." },
  thinking:  { glyph: "dots", text: "Thinking…",                       aria: "Microphone on, thinking", say: "Thinking." },
  speaking:  { glyph: "bars", text: "FormSpeak is speaking…",             aria: "Microphone on, assistant speaking", say: "" },
};

let lastSaidPhase = null;
export function renderStatus() {
  const micBtn = $("micBtn");
  if (!state.micOn) {
    micBtn.classList.remove("listening", "busy");
    micBtn.setAttribute("aria-pressed", "false");
    micBtn.setAttribute("aria-label", "Start microphone");
    $("micLabel").innerHTML = "<span>" + (state.pauseMsg ? escapeHTML(state.pauseMsg) : "Paused — " + tap + " to talk") + "</span>";
    if (lastSaidPhase !== "paused") { announce("Microphone paused."); lastSaidPhase = "paused"; }
    renderCard(); // keep the hero card's placeholder in sync (not "listening" when paused)
    return;
  }
  const s = STATUS[state.phase] || STATUS.listening;
  const live = state.phase === "listening";
  micBtn.classList.toggle("listening", live);
  micBtn.classList.toggle("busy", !live);
  micBtn.setAttribute("aria-pressed", "true");
  micBtn.setAttribute("aria-label", s.aria);
  const glyph =
    s.glyph === "dots" ? '<span class="tdots"><i></i><i></i><i></i></span>' :
    s.glyph === "bars" ? '<span class="sbars"><i></i><i></i><i></i><i></i></span>' : "";
  $("micLabel").innerHTML = glyph + "<span>" + s.text + "</span>";
  // Announce phase changes, but only "listening"/"thinking" (assistant speech is
  // already audible, so announcing it would talk over the reply).
  if (state.phase !== lastSaidPhase && s.say) { announce(s.say); }
  lastSaidPhase = state.phase;
  renderCard(); // reflect listening / thinking / speaking in the hero card placeholder
}

export function setPhase(p) {
  if (p === "listening") clearTimeout(state.thinkTimer);
  if (state.phase === p) return;
  state.phase = p;
  renderStatus();
}

export function scheduleThinking() {
  clearTimeout(state.thinkTimer);
  state.thinkTimer = setTimeout(() => {
    // user went quiet and the model hasn't started replying yet → show we're working on it
    if (state.micOn && state.phase === "listening") setPhase("thinking");
  }, 650);
}

// Mic-level ring, driven per audio frame from the capture worklet.
let ringOpen = null;
export function setLevel(rms, open) {
  const r = $("ring"); if (!r) return;
  // transform is the only property that changes every audio frame.
  r.style.transform = "scale(" + (0.6 + Math.min(1.6, rms * 9)) + ")";
  // background/opacity only flip with the gate — write them on the transition, not
  // every frame (vivid when audio passes through, dim grey when gated out).
  if (open !== ringOpen) {
    ringOpen = open;
    r.style.background = open ? "var(--accent)" : "#777777";
    r.style.opacity = open ? ".30" : ".13";
  }
}
