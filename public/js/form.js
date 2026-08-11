// The editable form: built once, then two-way bound —
//   voice  → setField() → renderRail() syncs inputs (+ flash)
//   typing → input listener → state.values + renderCard()
// Plus the NYC DS error summary and the manual-edit notifications that keep the
// voice model aware of what the user types.

import { FIELDS, TAP } from "./config.js";
import { state } from "./state.js";
import { $, escapeHTML, announce, spokenValue } from "./dom.js";
import {
  formatPhone, phoneInfo, phoneConfirmed, phoneReason,
  dobInfo, dobReasonText, dobToISO, isoToDOB, DOB_MIN, DOB_MAX,
  hhSizeInfo, incomeInfo, selectOptionFor,
} from "./validators.js";
import { isFilled } from "./form-state.js";
import { renderCard, revealField, lastCardKey } from "./card.js";
import { chooseAddress, scheduleAddrVerify } from "./tools.js";
import { showDone } from "./done.js";
import { logEvent } from "./telemetry.js";

export function setField(key, value) {
  // Optional demo-feedback field: lives outside the required-field flow, so it
  // only updates the textarea — no progress/validation/review impact.
  if (key === "feedback") {
    const ta = document.getElementById("feedbackInput");
    if (ta) {
      // The model re-sends its COMPLETE running collection every time, so we can't just
      // overwrite — that would wipe anything the user TYPED into the box. Instead swap the
      // model's *previous* contribution for its new one in place, leaving typed text around
      // it untouched. Replacement uses a function so '$'-sequences in feedback (e.g. "$5")
      // aren't treated as regex backreferences.
      const prev = state.feedbackModel;
      let next;
      if (prev && ta.value.includes(prev)) next = ta.value.replace(prev, () => value);
      else if (ta.value.trim()) next = ta.value.replace(/\s*$/, "") + "\n" + value; // typed text present → append below
      else next = value;
      state.feedbackModel = value;
      if (ta.value !== next) {
        ta.value = next;
        announce("Saved your demo feedback.");
      }
    }
    return;
  }
  // Phone: normalize whatever the model emits to our display format so the voice
  // and typing paths show the number identically.
  if (key === "phone") value = formatPhone(value);
  // The field the card is actually showing right now — lastCardKey (what was last
  // rendered), not activeIndex(), because a field can flip to "filled" before this
  // write (e.g. address: addrStatus goes "ok" first, then the canonical value lands),
  // which would advance activeIndex past it. We want a reveal when the value lands on
  // the card the viewer is looking at; out-of-order fills of other fields just store.
  const shownKey = state.pinKey != null ? state.pinKey : lastCardKey;
  const prevVal = state.values[key] || "";
  const changed = state.values[key] !== value;
  state.values[key] = value;
  renderRail(changed ? key : null);
  const f = FIELDS.find((x) => x.key === key);
  // If this newly-valid value belongs to the field on screen, type it in and hold
  // before advancing (revealField re-renders the card itself). Otherwise render now.
  // Only type per-character when the card was empty (placeholder → value); a value→value
  // swap (e.g. the address being replaced by its canonical form) just lands, no retype.
  if (changed && f && key === shownKey && state.pinKey !== key && isFilled(f)) {
    revealField(key, !prevVal);
  } else {
    renderCard();
  }
  if (changed && f) announce(f.label + ": " + spokenValue(f, value));
}

/* ------------------------------------------------------------------
   Field badges (validation state shown on each rail row)
   ------------------------------------------------------------------ */
export function addrBadge() {
  if (state.addrStatus === "checking") return '<span class="vbadge checking"><span class="spin sm"></span>confirming…</span>';
  if (state.addrStatus === "ok") {
    // Hovering ✓ Verified reveals the exact building geosearch confirmed (the unit isn't
    // part of what was verified, so the tooltip shows the building on its own).
    const t = state.addrVerified ? ' title="Verified building: ' + escapeHTML(state.addrVerified) + '"' : "";
    return '<span class="vbadge ok"' + t + ">✓ Verified with NYC GeoSearch</span>";
  }
  if (state.addrStatus === "none") return '<span class="vbadge warn">⚠ unconfirmed</span>';
  return "";
}

// One badge for any field: address keeps its geosearch chip; phone and DOB show a
// ✓ when confirmed or a ⚠ reason when not; everything else just gets a ✓ when filled.
export function fieldBadge(f, v) {
  if (!v) return "";
  if (f.key === "address") return addrBadge();
  if (f.key === "phone") {
    const pi = phoneInfo(v);
    return pi.ok ? '<span class="ff-check">✓</span>' : '<span class="vbadge warn">⚠ ' + phoneReason(pi.reason) + "</span>";
  }
  if (f.key === "date_of_birth") {
    const info = dobInfo(v);
    return info.ok ? '<span class="ff-check">✓</span>' : '<span class="vbadge warn">⚠ ' + dobReasonText(info.reason) + "</span>";
  }
  if (f.key === "household_size")
    return hhSizeInfo(v).ok ? '<span class="ff-check">✓</span>' : '<span class="vbadge warn">⚠ 1–8+ people</span>';
  if (f.key === "household_income")
    return incomeInfo(v).ok ? '<span class="ff-check">✓</span>' : '<span class="vbadge warn">⚠ enter an amount</span>';
  return '<span class="ff-check">✓</span>';
}

export function rowHTML(f) {
  const v = state.values[f.key];
  const filled = !!v;
  const shown = v || "—";
  const isAddr = f.key === "address";
  // Show a confirmation badge for the validated fields.
  const validated = isAddr || f.key === "phone" || f.key === "date_of_birth" || f.key === "household_size" || f.key === "household_income";
  const badge = v && validated ? fieldBadge(f, v) : "";
  return (
    '<div class="row ' + (filled ? "filled" : "") + (isAddr ? " addr" : "") + '" data-key="' + f.key + '">' +
      '<span class="ic"></span>' +
      '<span class="lab">' + f.label + "</span>" +
      '<span class="val ' + (filled ? "" : "placeholder") + '">' + escapeHTML(shown) + "</span>" +
      badge +
    "</div>"
  );
}

// The voice model can't see the screen, so a value the user types in by hand is invisible
// to it — left unaware, it keeps asking for fields that are already filled. After a manual
// edit settles (on blur), push a one-line note over the same socket as the user's turns.
// turnComplete:false means it's appended to the model's context WITHOUT prompting it to
// speak — so it silently updates the model's priors, folded into its next real turn.
function notifyModelManualEdit(f) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const v = state.values[f.key];
  const note = v
    ? 'The user just filled "' + f.label + '" themselves, directly on the form. It now reads "' + v +
      '". Treat it as already provided — do not ask for it again; only revisit it if they raise it or it needs correcting.'
    : 'The user just cleared "' + f.label + '" on the form. It is empty again and still needs to be collected.';
  state.ws.send(JSON.stringify({
    clientContent: { turns: [{ role: "user", parts: [{ text: "[form update] " + note }] }], turnComplete: false },
  }));
  logEvent("manual_edit", { key: f.key, value: v || "" });
}

// Build the editable form ONCE. Later updates only touch input .value / badges,
// so the user's cursor & focus survive while they type.
export function buildForm() {
  const form = $("liveForm");
  if (!form || form.dataset.built) return;

  form.innerHTML =
    // NYC DS "Error summary" feedback component: lists every problem at once with
    // links that jump focus to the offending field. Hidden until submit finds errors.
    '<div class="nyc-errorsummary" id="errorSummary" role="alert" tabindex="-1" hidden></div>' +
    FIELDS.map((f) => {
      // `nyc-*` = NYC DS component class hooks. Our token-based CSS styles them now;
      // once @nycds/core's CSS is installed it overrides them with the canonical look.
      const ac = ' autocomplete="' + (f.ac || "off") + '"';
      const ctl = f.key === "address"
        ? '<textarea class="ff-input nyc-textarea" rows="2" inputmode="text"' + ac + "></textarea>"
        : f.key === "date_of_birth"
        ? '<input class="ff-input nyc-dateinput" type="date" min="' + DOB_MIN + '" max="' + DOB_MAX + '"' + ac + " />"
        : f.select
        ? '<select class="ff-input ff-select nyc-select"' + ac + '><option value="">' + escapeHTML(f.ph || "Select…") + "</option>" +
          f.select.map((o) => '<option value="' + escapeHTML(o) + '">' + escapeHTML(o) + "</option>").join("") +
          "</select>"
        : f.tel
        ? '<input class="ff-input nyc-textinput" type="tel" inputmode="tel" placeholder="(212) 555-1234"' + ac + " />"
        : '<input class="ff-input nyc-textinput" type="text"' + ac + " />";
      // The visual validation badge is aria-hidden because screen readers receive
      // the same info via #srAnnounce.
      return (
        '<label class="ff" data-key="' + f.key + '">' +
          '<span class="ff-top"><span class="ff-lab">' + f.label + '</span><span class="ff-badge" aria-hidden="true"></span></span>' +
          '<span class="ff-inputwrap">' + ctl + "</span>" +
        "</label>"
      );
    }).join("") +
    // Optional, type-only feedback field — outside the voice FIELDS flow, so it
    // isn't validated/required and the model never tries to fill it.
    '<label class="ff ff-feedback">' +
      '<span class="ff-top"><span class="ff-lab">Any thoughts on this demo?</span><span class="ff-lab-opt">Optional</span></span>' +
      '<span class="ff-inputwrap"><textarea class="ff-input nyc-textarea" id="feedbackInput" rows="2" placeholder="Found a bug? Have a suggestion? Tell me what you think…"></textarea></span>' +
    "</label>" +
    '<button type="submit" class="ff-submit nyc-button nyc-button--primary" id="formSubmit">Submit form</button>';

  // typing → state (no flash, no setField → no loop)
  FIELDS.forEach((f) => {
    const input = form.querySelector('.ff[data-key="' + f.key + '"] .ff-input');
    const onEdit = () => {
      if (f.tel) {
        // Format as the user types, then restore the caret to the same digit offset
        // so separators we insert don't make it jump to the end.
        const before = (input.value.slice(0, input.selectionStart || 0).match(/\d/g) || []).length;
        const formatted = formatPhone(input.value);
        input.value = formatted;
        let pos = 0, seen = 0;
        while (pos < formatted.length && seen < before) { if (/\d/.test(formatted[pos])) seen++; pos++; }
        try { input.setSelectionRange(pos, pos); } catch {}
        state.values[f.key] = formatted;
      } else {
        // The date picker speaks ISO; store the readable "Month D, YYYY" everything else uses.
        state.values[f.key] = f.key === "date_of_birth" ? isoToDOB(input.value) : input.value;
      }
      if (f.key === "address") {
        state.addrStatus = "idle"; // manual edit clears prior geosearch badge…
        scheduleAddrVerify(input.value); // …then re-confirm the typed address (needs a city/borough)
      }
      const wrap = input.closest(".ff");
      wrap.classList.toggle("filled", !!input.value);
      const badge = wrap.querySelector(".ff-badge");
      if (badge) badge.innerHTML = f.key === "address"
        ? addrBadge() // addrStatus is now "idle" → clears the old ✓ borough chip
        // Phone: don't nag "needs 10 digits" mid-typing — show ✓ once valid, but hold the
        // ⚠ reason until the user leaves the field (the blur handler surfaces it).
        : (f.key === "phone" && !phoneConfirmed(state.values.phone)) ? ""
        : fieldBadge(f, state.values[f.key]); // ✓ or a ⚠ reason for date_of_birth etc.
      wrap.classList.remove("invalid"); // editing clears this field's error mark
      // If the summary is showing, refresh it live as problems get fixed.
      if (!$("errorSummary").hidden) {
        const errs = collectErrors();
        renderErrorSummary(errs, false); // update content but keep focus in the field
      }
      renderCard();
    };
    input.addEventListener("input", onEdit);
    if (f.select) input.addEventListener("change", onEdit); // selects: cover older browsers too

    // Hold the hero card on whatever field has focus (see displayedIndex), so manual typing
    // doesn't make the card skip ahead the moment a field is non-empty. Remember the value on
    // the way in so we can tell, on the way out, whether the user actually changed anything.
    let focusVal = "";
    input.addEventListener("focus", () => {
      focusVal = state.values[f.key] || "";
      state.focusKey = f.key;
      renderCard();
    });
    input.addEventListener("blur", () => {
      if (state.focusKey === f.key) state.focusKey = null; // hand the card back to the active-field flow
      // Phone validation is held back while typing; surface the ⚠ reason (or ✓) on the way out.
      if (f.key === "phone") {
        const badge = input.closest(".ff")?.querySelector(".ff-badge");
        if (badge) badge.innerHTML = state.values.phone ? fieldBadge(f, state.values.phone) : "";
      }
      // If they actually edited it by hand, let the voice model know so it stops re-asking.
      if ((state.values[f.key] || "") !== focusVal) notifyModelManualEdit(f);
      renderCard();
    });
  });

  // real submit button (voice "yes" path still works via submit_form → showDone)
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const feedback = (document.getElementById("feedbackInput")?.value || "").trim();
    const errors = collectErrors();
    // Escape hatch: if the user wrote feedback (e.g. a bug report), let them submit
    // even with the rest incomplete — so a blocker can always be reported.
    if (errors.length && !feedback) {
      renderErrorSummary(errors);
      return;
    }
    renderErrorSummary([]); // clear
    showDone();
  });

  // Clicking an error-summary link jumps focus to the offending field.
  $("errorSummary").addEventListener("click", (e) => {
    const link = e.target.closest("[data-target]");
    if (!link) return;
    e.preventDefault();
    focusField(link.dataset.target);
  });

  form.dataset.built = "1";
}

// Walk every field and gather all problems at once (one message per field), in
// form order — the order the Error Summary lists them and focus jumps through.
function collectErrors() {
  const out = [];
  FIELDS.forEach((f) => {
    const v = state.values[f.key];
    if (f.key === "address") {
      if (!v) out.push({ key: f.key, label: f.label, msg: "Enter your home address." });
      else if (state.addrStatus !== "ok")
        out.push({ key: f.key, label: f.label, msg: state.addrStatus === "checking"
          ? "Still confirming the address — give it a moment."
          : "We couldn't confirm that address. Include a valid city or NYC borough." });
      return;
    }
    if (f.key === "phone") {
      if (!v) out.push({ key: f.key, label: f.label, msg: "Enter your phone number." });
      else if (!phoneConfirmed(v)) out.push({ key: f.key, label: f.label, msg: "Enter a valid phone number — 10 digits, or a country code starting with +." });
      return;
    }
    if (f.key === "date_of_birth") {
      if (!v) out.push({ key: f.key, label: f.label, msg: "Enter your date of birth." });
      else if (!dobInfo(v).ok) out.push({ key: f.key, label: f.label, msg: "Enter a valid date of birth between 1900 and 2026." });
      return;
    }
    if (!isFilled(f)) out.push({ key: f.key, label: f.label, msg: "Enter your " + f.label.toLowerCase() + "." });
  });
  return out;
}

// Render (or clear) the NYC DS Error Summary, mark the listed fields invalid,
// then move focus to the summary and announce the count for screen-reader users.
function renderErrorSummary(errors, refocus = true) {
  const box = $("errorSummary");
  if (!box) return;
  // Reset prior invalid marks.
  const form = $("liveForm");
  form.querySelectorAll('.ff.invalid').forEach((el) => el.classList.remove("invalid"));
  if (!errors.length) { box.hidden = true; box.innerHTML = ""; return; }
  const n = errors.length;
  box.innerHTML =
    '<h2 class="nyc-errorsummary__title">' +
      'There ' + (n === 1 ? "is 1 problem" : "are " + n + " problems") + " to fix" +
    "</h2>" +
    '<ul class="nyc-errorsummary__list">' +
    errors.map((er) =>
      '<li><a href="#" data-target="' + er.key + '">' + escapeHTML(er.msg) + "</a></li>",
    ).join("") +
    "</ul>";
  errors.forEach((er) => {
    const wrap = form.querySelector('.ff[data-key="' + er.key + '"]');
    if (wrap) wrap.classList.add("invalid");
  });
  box.hidden = false;
  if (refocus) {
    box.focus();
    announce((n === 1 ? "There is 1 problem" : "There are " + n + " problems") + " to fix on the form.");
  }
}

// Focus a field by key and bring it into view (used by the error-summary links).
function focusField(key) {
  const form = $("liveForm");
  const el = form && form.querySelector('.ff[data-key="' + key + '"] .ff-input');
  if (!el) return;
  // JS-requested smooth scroll overrides the CSS reduced-motion guard, so honour
  // the preference explicitly here: jump instantly for reduced-motion users.
  if (el.scrollIntoView) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }
  el.focus();
}

// Sync the form inputs from state (called everywhere state changes land).
export function renderRail(flashKey) {
  const form = $("liveForm");
  if (!form) return;
  if (!form.dataset.built) buildForm();
  FIELDS.forEach((f) => {
    const wrap = form.querySelector('.ff[data-key="' + f.key + '"]');
    if (!wrap) return;
    const input = wrap.querySelector(".ff-input");
    const v = state.values[f.key] || "";
    // The date picker needs ISO; the dropdown needs one of its exact <option> values
    // (voice might say "5" → snap it to the "5" option). Text fields use v as-is.
    const inputVal = f.key === "date_of_birth" ? dobToISO(v)
      : f.select ? selectOptionFor(f, v)
      : v;
    // don't clobber the field the user is actively typing in
    if (document.activeElement !== input && input.value !== inputVal) input.value = inputVal;
    wrap.classList.toggle("filled", !!v);
    const badge = wrap.querySelector(".ff-badge");
    if (badge) badge.innerHTML = fieldBadge(f, v);
  });
  renderAddrChoices(form);
  if (flashKey) {
    const wrap = form.querySelector('.ff[data-key="' + flashKey + '"]');
    if (wrap) { wrap.classList.add("flash"); setTimeout(() => wrap.classList.remove("flash"), 900); }
  }
}

// Render the A–D address picker under the address field (tap to choose). Voice
// "A/B/C/D" is handled by the model; both paths land in chooseAddress().
function renderAddrChoices(form) {
  const wrap = form.querySelector('.ff[data-key="address"]');
  if (!wrap) return;
  let box = wrap.querySelector(".addr-choices");
  if (!state.addrChoices.length) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement("div"); box.className = "addr-choices"; wrap.appendChild(box); }
  box.innerHTML =
    '<div class="ac-q">Did you mean one of these? ' + TAP + ' or say the letter.</div>' +
    state.addrChoices.map((c) => {
      // Split "171 EAST 2 STREET, Manhattan, NY 10009" → primary street + the rest,
      // so options read clearly whether they differ by borough or by house number.
      const parts = (c.full || "").split(",");
      const primary = (parts.shift() || c.borough || "").trim();
      const secondary = parts.join(",").trim();
      return (
        '<button type="button" class="ac-opt" data-full="' + escapeHTML(c.full) + '">' +
          '<span class="ac-letter">' + c.letter + "</span>" +
          '<span class="ac-text"><b>' + escapeHTML(primary) + "</b>" +
            (secondary ? '<span class="ac-sub">' + escapeHTML(secondary) + "</span>" : "") +
          "</span>" +
        "</button>"
      );
    }).join("");
  box.querySelectorAll(".ac-opt").forEach((b) =>
    b.addEventListener("click", () => chooseAddress(b.dataset.full)));
}
