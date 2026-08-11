// The completion screen: read-back card, focus management for assistive tech,
// and the actual save to D1 (POST /api/submit).

import { FIELDS } from "./config.js";
import { state } from "./state.js";
import { $, announce } from "./dom.js";
import { isFilled } from "./form-state.js";
import { rowHTML } from "./form.js";
import { setMicOn } from "./audio.js";
import { clearSessionLimits } from "./live.js";
import { logEvent, tlog, SESSION_ID } from "./telemetry.js";

export async function showDone() {
  state.submitted = true;
  clearSessionLimits();
  setMicOn(false);
  $("finalCard").innerHTML = FIELDS.map((f) => rowHTML(f)).join("");
  $("formScreen").classList.add("hidden");
  $("doneScreen").classList.remove("hidden");
  // Move focus to the confirmation heading so screen-reader / keyboard users are
  // carried to the new view instead of being stranded on the now-hidden form.
  const heading = $("doneHeading");
  if (heading && heading.focus) heading.focus();
  announce("All set. Your details were captured and confirmed. Saving…");
  // Carry the optional demo feedback into the email button's prefilled body.
  const feedback = (document.getElementById("feedbackInput")?.value || "").trim();
  const emailBtn = $("emailBtn");
  if (emailBtn) emailBtn.href = "mailto:jpaulgale@gmail.com?subject=" + encodeURIComponent("FormSpeak") +
    (feedback ? "&body=" + encodeURIComponent(feedback) : "");
  // persist confirmed submission to D1
  const save = $("saveStatus");
  save.innerHTML = '<span class="spin" aria-hidden="true"></span>Saving…'; save.className = "mic-sub"; save.style.color = "";
  try {
    const payload = {}; FIELDS.forEach((f) => (payload[f.key] = state.values[f.key] || ""));
    payload.feedback = feedback;
    payload.session_id = SESSION_ID;     // stamp the row so it joins back to its telemetry session
    const r = await fetch("/api/submit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "save failed");
    save.textContent = "✓ Saved"; save.style.color = "var(--ok-text)";
    announce("Your form was saved.");
    logEvent("submit_saved", { fields: FIELDS.filter(isFilled).map((f) => f.key) });
    tlog.flush();
  } catch (err) {
    console.error(err);
    logEvent("error", { where: "save", message: String(err?.message || err) });
    save.textContent = "⚠ Couldn't save: " + (err.message || err); save.style.color = "var(--warn-text)";
    announce("Something went wrong saving your form. " + (err.message || ""));
  }
}
