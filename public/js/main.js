// Boot flow and page-level wiring: first paint of the form + hero card, the
// mic button's connect/pause/resume behavior, lifecycle events (tab hidden,
// page gone), and the overlay mini-bar.

import { FIELDS, TAP, tap } from "./config.js";
import { state } from "./state.js";
import { $, announce } from "./dom.js";
import { tlog, logEvent } from "./telemetry.js";
import { isFilled, fieldsSnapshot } from "./form-state.js";
import { startMic, setMicOn, releaseMic } from "./audio.js";
import { getToken, connect, armSessionLimits } from "./live.js";
import { buildForm, renderRail } from "./form.js";
import { renderCard, renderCaption, syncCardHeight } from "./card.js";
import { initTestMode } from "./test-mode.js";

async function begin() {
  state.pauseMsg = ""; // clear any auto-pause notice so the label resets on resume
  const btn = $("micBtn"), sub = $("startSub");
  btn.disabled = true; btn.classList.remove("idle-pulse");
  $("startErr").textContent = "";
  if (!tlog.startSent) {
    tlog.startSent = true;
    logEvent("session_start", {
      resume: FIELDS.some(isFilled),
      prefilled: FIELDS.filter(isFilled).map((f) => f.key),
      referrer: document.referrer || "",
      lang: navigator.language || "",
      tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "",
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    });
  }
  try {
    sub.textContent = "Getting ready…";
    const token = await getToken();
    // Bring the mic up concurrently with the socket so the AudioContext / browser AEC
    // start adapting during the connect + greeting-TTS latency — before the greeting
    // plays out the speaker. Without this the mic comes up cold exactly as the (loud,
    // longest) greeting hits the speaker, and the echo floor below seeds to that
    // uncancelled peak, pinning the gate high for the whole first message so you can't
    // barge in. sendAudio() is guarded on ws OPEN, so frames captured before the socket
    // is ready just no-op. Promise.all consumes both rejections (no unhandled reject).
    await Promise.all([connect(token), startMic()]);
    armSessionLimits();
    sub.textContent = "";
    btn.disabled = false;
    // Latch the live layout: from here the transcript window reserves a fixed height
    // (see #formScreen.started .caption) so the first transcript line doesn't shove
    // the card down. Stays on through pauses so resume doesn't re-introduce the jump.
    $("formScreen").classList.add("started");
    renderRail(null); renderCard(); renderCaption();
  } catch (err) {
    console.error(err);
    // name distinguishes a denied mic (NotAllowedError) from a token/ws failure.
    logEvent("error", { where: "begin", name: err?.name || "", message: String(err?.message || err) });
    $("startErr").textContent = err.message || String(err);
    announce("Couldn't start the microphone. " + (err.message || "") + " " + TAP + " to retry.");
    btn.disabled = false; btn.classList.add("idle-pulse");
    sub.textContent = tap + " to retry";
  }
}

// First tap connects + starts the mic; later taps pause/resume.
// Resume after the device was released (tab was hidden) re-acquires via startMic();
// a normal pause/resume just toggles the existing track.
$("micBtn").addEventListener("click", () => {
  if (state.connected) {
    if (!state.micOn && !state.micStream) startMic().catch((err) => { console.error(err); announce("Couldn't reopen the microphone."); });
    else setMicOn(!state.micOn);
  } else if (!$("micBtn").disabled) begin();
});

// Leaving the tab (switching apps, locking the phone, opening another tab) should
// hand the microphone back — don't keep holding it open in the background, even
// when paused. We fully release on hide; the user taps the mic to resume, which
// re-acquires. Note: a muted/paused track still counts as recording to the OS, so
// pausing alone isn't enough — releaseMic() stops the tracks outright.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.micStream) releaseMic();
    tlog.flush(true); // backgrounding may precede a close — get what we have out now
  }
});

// Final beacon when the page is going away: records how far an abandoned session
// got. pagehide is the reliable one on mobile (beforeunload often doesn't fire).
window.addEventListener("pagehide", () => {
  logEvent("session_end", fieldsSnapshot());
  tlog.flush(true);
});
$("restartBtn").addEventListener("click", () => location.reload());

// Pointer-aware initial mic prompt ("Tap"/"Click to start").
$("micLabel").textContent = TAP + " to start";
// Pointer-aware hero verb ("click" on desktop, "tap" on touch).
const heroVerb = document.getElementById("heroVerb");
if (heroVerb) heroVerb.textContent = tap;

// Show the editable form + hero focused card right away, before any connection.
buildForm(); renderRail(null); renderCard();

// Lock the question card to its tallest height so it never resizes between
// questions. Measure now, again once the display font swaps in (it changes the
// wrap), and on resize (debounced — the breakpoint and width both shift the wrap).
syncCardHeight();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncCardHeight);
let cardHeightTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(cardHeightTimer);
  cardHeightTimer = setTimeout(syncCardHeight, 150);
});

// Overlay mini-bar: slide it in once the full mic dock scrolls out of the top of
// the viewport, and out again when it returns. Driven by an IntersectionObserver on
// the dock (no scroll math, no layout reads) — and because the bar is position:
// fixed, toggling it overlays the page instead of reflowing it, so there's no
// scroll jump. Runs on every width: observing the viewport (root: null) works for
// both the mobile phone column (where .app is the scroller) and the desktop floating
// card (where the window scrolls and .app isn't a scroller) — on desktop the bar
// aligns to the card column via CSS.
(() => {
  const minibar = $("minibar");
  const dock = document.querySelector(".dock");
  if (!minibar || !dock) return;
  // .inert tracks visibility: when the bar is off-screen it must not be focusable or
  // exposed to assistive tech (that's why we don't aria-hide the container — it holds
  // the focusable mic). show ⇒ interactive; hidden ⇒ inert.
  const setShown = (shown) => { minibar.classList.toggle("show", shown); minibar.inert = !shown; };
  const io = new IntersectionObserver(
    ([e]) => setShown(!e.isIntersecting),
    { root: null, threshold: 0 }
  );
  io.observe(dock);
  // The mini mic is just a proxy for the real control (connect / pause / resume).
  $("miniMic").addEventListener("click", () => $("micBtn").click());
})();

initTestMode();
