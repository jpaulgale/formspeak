// The hero question card (the field currently "up"), its segmented progress,
// the typed-in value reveal, and the live conversation caption + mini-bar text.

import { FIELDS, TAP } from "./config.js";
import { state } from "./state.js";
import { $, escapeHTML } from "./dom.js";
import { isFilled, activeIndex } from "./form-state.js";
import { denoiseTranscript } from "./validators.js";

// Which field the hero card is actually showing. Normally the first unfilled field,
// but during a reveal we pin it on the just-answered field while its value types in
// (state.pinKey) — so the card lingers there instead of jumping ahead immediately.
export function displayedIndex() {
  // Hold the card on a field the user is manually editing, so it doesn't skip to the next
  // field the instant what they've typed counts as "filled" — it advances when they leave.
  if (state.focusKey != null) {
    const i = FIELDS.findIndex((f) => f.key === state.focusKey);
    if (i !== -1) return i;
  }
  if (state.pinKey != null) {
    const i = FIELDS.findIndex((f) => f.key === state.pinKey);
    if (i !== -1) return i;
  }
  return activeIndex();
}

/* ------------------------------------------------------------------
   Value reveal — pin the card on a just-answered field and "type" its
   value in, then hold so the viewer sees it land before the card
   advances. Bounded so a fast, multi-field ramble can't snowball: only
   the field currently on screen reveals (others fill silently), and
   typing is capped to ~500ms regardless of value length.
   ------------------------------------------------------------------ */
const REVEAL_HOLD_MS = 650;
// The address resolves to a longer, multi-part line (street, borough, ZIP) that takes
// longer to read than a name or a number, so it lingers ~2s before advancing.
function holdFor(key) { return key === "address" ? 2000 : REVEAL_HOLD_MS; }
function endReveal() {
  clearInterval(state.revealTimer); state.revealTimer = null;
  state.pinKey = null; state.revealN = 0;
  renderCard(); // unpinned → advances to the next active field with the normal slide-in
}
export function revealField(key, doType) {
  const raw = state.values[key] || "";
  clearInterval(state.revealTimer); // supersede any in-flight reveal
  state.pinKey = key; state.revealN = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doType || reduce || raw.length <= 1) {
    // No per-character motion: show the whole value, then just hold.
    state.revealN = raw.length; renderCard();
    state.revealTimer = setTimeout(endReveal, holdFor(key));
    return;
  }
  const TYPE_MS = 500, TICK = 24;
  const perTick = Math.max(1, Math.ceil(raw.length / (TYPE_MS / TICK)));
  renderCard(); // start empty (caret only)
  state.revealTimer = setInterval(() => {
    state.revealN = Math.min(raw.length, state.revealN + perTick);
    renderCard();
    if (state.revealN >= raw.length) {
      clearInterval(state.revealTimer);
      state.revealTimer = setTimeout(endReveal, holdFor(key)); // typed out → hold, then advance
    }
  }, TICK);
}

// Placeholder shown in the hero card when the active field has no value yet.
// The "listening" + blinking caret only appears when we're ACTUALLY listening;
// otherwise it reflects the real state (mic off, thinking, or assistant speaking).
function emptyAnswerHTML() {
  if (!state.micOn) return '<div class="answer empty muted">' + TAP + ' the microphone to start</div>';
  if (state.phase === "speaking") return '<div class="answer empty muted">FormSpeak is speaking…</div>';
  if (state.phase === "thinking") return '<div class="answer empty muted">thinking…</div>';
  // genuinely listening for the user's answer — label matches the dock's "Listening…"
  return '<div class="answer empty"><span class="caret"></span>Listening…</div>';
}

// Segmented progress shown inside the hero card, in place of a "Question N of N"
// counter. One segment per field; they fill in ANY order as the user rambles —
// which is the point: a linear "step 1 of 7" would contradict the out-of-order UX.
//   green (done)  = value present AND valid (isFilled)
//   red   (bad)   = value present but NOT valid yet (e.g. address unresolved,
//                   phone not confirmed, DOB out of range) — "answered but wrong"
//   blue  (active)= the field currently up, still empty
//   gray          = untouched
function progressHTML(ai) {
  const segs = FIELDS.map((f, i) => {
    let cls = "seg";
    if (isFilled(f)) cls += " done";
    // Address verification is an async API round-trip. While it's in flight the value
    // is present but not yet "ok" — don't flash it red ("disqualified") in that window;
    // show a neutral pulsing "checking" instead. Red is reserved for a genuine failure
    // (addrStatus "none": geosearch couldn't resolve it and needs the user to pick/retry).
    else if (f.key === "address" && (state.values.address || "").trim() && state.addrStatus !== "none") cls += " checking";
    else if ((state.values[f.key] || "").trim()) cls += " bad";
    else if (i === ai) cls += " active";
    return '<div class="' + cls + '"><i></i></div>';
  }).join("");
  // Keep the count available to screen readers even though it's no longer on screen.
  const done = FIELDS.filter(isFilled).length;
  const label = ai === -1
    ? "Review — " + done + " of " + FIELDS.length + " complete"
    : "Question " + (ai + 1) + " of " + FIELDS.length;
  return '<div class="progress qprogress" role="img" aria-label="' + label + '">' + segs + "</div>";
}

// The review screen's question, included alongside FIELDS when measuring the
// tallest header (it's the one card not backed by a FIELDS entry).
const REVIEW_QHEAD = { q: "Does everything look right?", hint: "Say “yes” to submit, or just tell me what to change." };

// Pin the question card to one constant height so it never resizes as questions of
// different lengths roll by (which used to bounce the whole form below it). Rather
// than hardcode a height — the tallest question wraps to a different line count at
// each viewport width and once the display font finishes loading — measure every
// question's header (qtext + qhint) at the live card's content width, take the
// tallest, and add it to the card's fixed overhead (progress + answer + padding).
// The result is published as the --qcard-h floor every card honours. Re-run on
// resize and after the display font loads, since both change the wrap.
export function syncCardHeight() {
  const card = $("qcard");
  if (!card || !card.clientWidth) return;
  // We read the card's non-header overhead (progress + answer + padding) off the
  // live card, so we need a normal field card on screen — not the answer-less review
  // screen, and not the address field while its inline verify message is up (that's
  // the documented exception that's allowed to grow past the floor).
  const head = card.querySelector(".qhead");
  if (!head || !card.querySelector(".answer") || card.querySelector(".addr-status")) return;
  const cs = getComputedStyle(card);
  const w = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (w <= 0) return;

  // Tallest header (qtext + qhint) across every question at this width.
  const m = document.createElement("div");
  m.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;width:" + w + "px;";
  document.body.appendChild(m);
  let maxHead = 0;
  for (const v of [...FIELDS, REVIEW_QHEAD]) {
    m.innerHTML = '<div class="qtext">' + v.q + "</div>" + (v.hint ? '<div class="qhint">' + v.hint + "</div>" : "");
    maxHead = Math.max(maxHead, m.getBoundingClientRect().height);
  }
  m.remove();

  // Read the overhead from the card's *natural* height, not its current floored
  // height — otherwise each run would measure the floor we set last time and ratchet
  // it upward. Drop the floor to 0, read, then commit the new one (all synchronous,
  // so the 0 never paints).
  const rs = document.documentElement.style;
  rs.setProperty("--qcard-h", "0px");
  const overhead = card.getBoundingClientRect().height - head.getBoundingClientRect().height;
  rs.setProperty("--qcard-h", Math.ceil(overhead + maxHead) + "px");
}

export function renderCard() {
  const card = $("qcard");
  if (!card) return; // question card removed — the live form is the primary view
  const ai = displayedIndex();

  // Keep the card elevated for the whole live session — on as long as the mic is
  // active (listening/thinking/speaking), off only when paused. The persistent
  // depth reads as "this card is live," which the transcript turning over shouldn't
  // interrupt.
  card.classList.toggle("active", state.micOn);

  // Keep the overlay mini-bar in sync (phase · field, the field hint, + listening
  // tint on its mic). The transcript line is updated separately in renderCaption.
  const ms = $("miniStatus"), mm = $("miniMic"), mh = $("miniHint");
  if (ms && mm) {
    const ph = !state.micOn ? "Paused" : state.phase === "speaking" ? "Speaking" : state.phase === "thinking" ? "Thinking" : "Listening";
    const fieldTxt = ai === -1 ? "Review" : escapeHTML(FIELDS[ai].label);
    ms.innerHTML = "<b>" + ph + '</b><span class="dock-dot">·</span>' + fieldTxt;
    if (mh) mh.textContent = ai === -1 ? "" : (FIELDS[ai].hint || "");
    mm.classList.toggle("listening", state.micOn && state.phase === "listening");
    mm.setAttribute("aria-label", state.micOn ? "Pause microphone" : "Start microphone");
  }

  if (ai === -1) {
    // review / confirm screen
    // The editable form below already lists every value — don't duplicate it here.
    card.innerHTML =
      progressHTML(ai) +
      '<div class="qhead">' +
        '<div class="qtext">Does everything look right?</div>' +
        '<div class="qhint">Say “yes” to submit, or just tell me what to change.</div>' +
      '</div>';
    bumpAnim(card);
    return;
  }

  const f = FIELDS[ai];
  const val = state.values[f.key];
  const aMsg = f.key === "address" && val ? addrInlineMsg() : "";
  const addrLine = aMsg ? '<div class="addr-status">' + aMsg + "</div>" : ""; // no empty spacer when verified
  // While this field is pinned for its reveal, show the value typing in: the first
  // revealN characters, with a caret trailing until it's fully typed. Otherwise show
  // the whole value (or the listening placeholder when empty).
  let answerHTML;
  if (state.focusKey === f.key) {
    // The user is typing this field in directly on the form. Hold the card here, but DON'T
    // mirror the keystrokes — the value lives in the input below, and echoing it (with a
    // caret) made the card read like a second place to type. Voice fills still animate in
    // via pinKey above.
    answerHTML = '<div class="answer empty muted">Editing below…</div>';
  } else if (val && state.pinKey === f.key) {
    const typed = escapeHTML(val.slice(0, state.revealN));
    const stillTyping = state.revealN < val.length;
    answerHTML = '<div class="answer">' + typed + (stillTyping ? '<span class="caret"></span>' : "") + "</div>";
  } else if (val) {
    answerHTML = '<div class="answer">' + escapeHTML(val) + "</div>";
  } else {
    answerHTML = emptyAnswerHTML();
  }
  card.innerHTML =
    progressHTML(ai) +
    '<div class="qhead">' +
      '<div class="qtext">' + f.q + "</div>" +
      (f.hint ? '<div class="qhint">' + f.hint + "</div>" : "") +
    "</div>" +
    answerHTML +
    addrLine;
  bumpAnim(card);
}

// The field key whose card was last rendered — setField() uses it to decide
// whether a landing value should animate in on the card the viewer is looking at.
// A live binding (export let): only this module assigns it.
export let lastCardKey = null;
let cardAnimReady = false; // Suppress the slide-in on the very first paint: it otherwise
                           // fires alone, after the page is already drawn, and reads as a
                           // glitch. Field-to-field transitions still animate normally.
function bumpAnim(card) {
  const ai = displayedIndex();
  const key = ai === -1 ? "review" : FIELDS[ai].key;
  if (key === lastCardKey) return;
  lastCardKey = key;
  if (!cardAnimReady) { cardAnimReady = true; return; } // first render → appear in place
  card.classList.remove("anim"); void card.offsetWidth; card.classList.add("anim");
}

// NYC DS "Inline message" feedback component — the prominent, eye-drawing version
// of the address-confirmation status, shown in the hero card while the address
// field is active. (The compact .vbadge lives in form.js for tight rail rows.)
function addrInlineMsg() {
  // The finished (verified) state shows NOTHING here on purpose — the typed address, the
  // green progress segment, and the rail's "✓ Verified" chip (which tooltips the exact
  // confirmed building) already convey it. A success box made the card too busy to read.
  // We only surface the in-progress and failure states, where the message is actionable.
  const map = {
    checking: { mod: "info",    icon: '<span class="spin sm"></span>', html: "Checking this address with NYC GeoSearch…" },
    none:     { mod: "error",   icon: "⚠", html: "We couldn't confirm this address. Add a valid city or NYC borough." },
  };
  const m = map[state.addrStatus];
  if (!m) return "";
  return (
    '<div class="nyc-inlinemessage nyc-inlinemessage--' + m.mod + '">' +
      (m.icon ? '<span class="nyc-inlinemessage__icon" aria-hidden="true">' + m.icon + "</span>" : "") +
      '<span class="nyc-inlinemessage__text">' + m.html + "</span>" +
    "</div>"
  );
}

/* ------------------------------------------------------------------
   Live conversation caption (under the mic) + the mini-bar transcript.
   ------------------------------------------------------------------ */
export function renderCaption() {
  const u = denoiseTranscript(state.userBuf || state.lastUser || "");
  const a = denoiseTranscript(state.asstBuf || state.lastAsst || "");
  // Chronological order: your speech first, then FormSpeak's reply under it (a turn
  // arrives as your speech, then its reply) — matching the mini-bar below.
  // Each turn is its own block line (.cap-line) rather than <br>-joined inline text,
  // so the live transcript window (#formScreen.started .caption) can stack and clip
  // them as flex rows without reflowing the card below.
  $("caption").innerHTML =
    (u ? '<span class="cap-line you"><strong>You:</strong> ' + escapeHTML(u) + "</span>" : "") +
    (a ? '<span class="cap-line"><b>FormSpeak:</b> ' + escapeHTML(a) + "</span>" : "");

  // Mini-bar transcript: show the last exchange in chronological order — your reply
  // first, then FormSpeak's line after it (a turn arrives as your speech, then its
  // reply). Falls back to lastUser/lastAsst so it persists between turns and is only
  // replaced when the next turn completes. Two lines max.
  const mc = $("miniCap");
  if (mc) {
    mc.innerHTML =
      (u ? '<span class="cap-line">You: ' + escapeHTML(u) + "</span>" : "") +
      (a ? '<span class="cap-line"><b>FormSpeak:</b> ' + escapeHTML(a) + "</span>" : "");
  }
}
