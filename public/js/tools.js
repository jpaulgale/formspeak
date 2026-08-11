// Tool dispatch — the model drives the UI through exactly two tools
// (set_field, submit_form), and every response string here is part of the
// prompt contract: the model is told the validation verdict and what to do
// next. tests/formspeak_env.py keeps a line-for-line port of this module so
// the headless evals reproduce these responses byte-for-byte.

import { FIELDS, NYC_BOROUGHS, TAP } from "./config.js";
import { state } from "./state.js";
import { announce } from "./dom.js";
import { splitUnit, withUnit, phoneInfo, phoneConfirmed, dobInfo, hhSizeInfo, incomeInfo } from "./validators.js";
import { isFilled } from "./form-state.js";
import { setField, renderRail } from "./form.js";
import { renderCard } from "./card.js";
import { showDone } from "./done.js";

export async function dispatchTool(name, args) {
  if (name === "set_field") {
    if (typeof args.value !== "string") return "ok";
    // The optional "feedback" field lives outside FIELDS (it's only added to the tool
    // enum), so handle it here — otherwise the FIELDS.find below misses it, we bail
    // with "ok", and the model wrongly believes the bug/suggestion/compliment landed.
    if (args.field === "feedback") {
      setField("feedback", args.value);
      return "Saved to the optional demo-feedback field. Briefly acknowledge it and continue.";
    }
    const f = FIELDS.find((x) => x.key === args.field);
    if (!f) return "ok";
    // Anticipate the geosearch round-trip: mark the address "checking" BEFORE the first
    // paint so its progress segment shows the neutral pulsing state, never a one-frame
    // red flash, on the way to confirmation. verifyAddress re-sets this (no-op).
    if (f.key === "address") state.addrStatus = "checking";
    setField(f.key, args.value);          // show it live immediately
    if (f.key === "address") {
      // Confirm against NYC geosearch; the canonical full address replaces what's shown.
      const j = await verifyAddress(args.value);
      if (!j) return "ok";                 // a newer correction superseded this lookup
      if (j.status === "confirmed") {
        if (j.degraded)
          // Geosearch was unreachable — we accepted the address without verifying it.
          // Still have the model read it back so the user can catch any error.
          return "Address accepted as: " + j.full +
            " (the address lookup is temporarily unavailable, so it wasn't independently verified). " +
            "Read this address back to the user, INCLUDING the borough/city, and ask them to confirm it.";
        return "Address confirmed by NYC geosearch as: " + j.full +
          ". Read this exact full address back to the user, INCLUDING the borough/city, and ask them to confirm it.";
      }
      if (state.addrChoices.length) {
        // Couldn't auto-confirm, but we have candidates — they're now on screen as
        // lettered buttons (A–D). The same letters work by voice.
        const opts = state.addrChoices.map((c) => c.letter + ") " + c.full).join("; ");
        const letters = state.addrChoices.map((c) => c.letter).join(", ");
        const split = j.reason === "multiple_boroughs"
          ? "That street exists in more than one borough."
          : "I couldn't pin that address down exactly, so here are the closest matches.";
        return split + " The options are now shown on screen as lettered buttons: " + opts +
          ". Read them out briefly and ask the user to pick — they can tap a button or just say the letter (" +
          letters + "). When they choose, call set_field for the address with that option's full address. " +
          "If none of them is right, ask them to repeat the street number, street, and borough. Do not move on until the address is confirmed.";
      }
      return "Could not find that address at all. A city or borough is REQUIRED — ask the user to repeat the street number, street, and city/borough, then confirm again.";
    }
    if (f.key === "phone") {
      const pi = phoneInfo(args.value);
      if (!pi.ok) {
        if (pi.reason === "short")
          return "The phone number is NOT confirmed: only " + pi.n + " digit" + (pi.n === 1 ? "" : "s") +
            " so far. A US number needs 10 digits (a leading 1 country code is fine). Ask the user for the rest of the digits.";
        if (pi.reason === "needsplus")
          return "The phone number is NOT confirmed: more digits than a US number but no country code. " +
            "If it's international, set it again starting with '+' and the country code; otherwise ask the user to repeat just their 10-digit number.";
        if (pi.reason === "long")
          return "The phone number is NOT confirmed: too many digits. Ask the user to repeat their number.";
        return "The phone number is NOT confirmed. Ask the user to repeat their phone number.";
      }
      return "Phone number confirmed (" + pi.n + " digits). Read it back so the user can catch any mistake.";
    }
    if (f.key === "date_of_birth") {
      // Not confirmed unless the year is in [1900, 2026].
      const info = dobInfo(args.value);
      if (!info.ok) {
        if (info.reason === "too_early")
          return "The date of birth is NOT confirmed: " + info.year + " is before 1900, which isn't allowed. " +
            "Ask the user to double-check and repeat their date of birth, then confirm it.";
        if (info.reason === "too_late")
          return "The date of birth is NOT confirmed: " + info.year + " is after 2026, which isn't allowed. " +
            "Ask the user to double-check and repeat their date of birth, then confirm it.";
        return "The date of birth is NOT confirmed — I couldn't read a valid year from it. Ask the user to " +
          "repeat their date of birth as month, day, and year, then confirm it. Do NOT call submit_form until it's valid.";
      }
      return "Date of birth confirmed (" + info.year + "). Read it back as 'Month D, YYYY' so the user can confirm.";
    }
    if (f.key === "household_size") {
      // A single-select count of people: 1 through 8+.
      const info = hhSizeInfo(args.value);
      if (!info.ok)
        return "The household size is NOT confirmed — I need a whole number of people from 1 to 8 or more. " +
          "Ask the user how many people live and eat together in their home, then read the number back.";
      return "Household size confirmed (" + (info.n === 8 ? "8 or more" : info.n) + " " +
        (info.n === 1 ? "person" : "people") + "). Read it back so the user can confirm.";
    }
    if (f.key === "household_income") {
      // Monthly household income in dollars — $0 is allowed (no income).
      const info = incomeInfo(args.value);
      if (!info.ok)
        return "The monthly household income is NOT confirmed — I need a dollar amount (say zero if there's no income). " +
          "Ask the user roughly how much the household earns each month before taxes, then read it back.";
      return "Monthly household income confirmed. Read the amount back so the user can confirm.";
    }
    if (f.key === "preferred_language") {
      return "Preferred language set to " + args.value + ". Briefly confirm it and continue.";
    }
    return "ok";
  }
  if (name === "submit_form") {
    if (FIELDS.every(isFilled)) { showDone(); return "submitted"; }
    // Spell out exactly which fields are present but UNCONFIRMED so the model can fix them.
    const problems = [];
    if (state.values.address && state.addrStatus !== "ok")
      problems.push("the address is not confirmed (it needs a valid NYC city/borough)");
    if (state.values.phone && !phoneConfirmed(state.values.phone))
      problems.push("the phone number is not confirmed (10 digits, or a country code with +)");
    if (state.values.date_of_birth && !dobInfo(state.values.date_of_birth).ok)
      problems.push("the date of birth is not confirmed (the year must be between 1900 and 2026)");
    if (state.values.household_size && !hhSizeInfo(state.values.household_size).ok)
      problems.push("the household size is not confirmed (1 to 8 or more people)");
    if (state.values.household_income && !incomeInfo(state.values.household_income).ok)
      problems.push("the monthly household income is not confirmed (it needs a dollar amount)");
    if (problems.length)
      return "Cannot submit yet: " + problems.join("; ") +
        ". Fix each with set_field and re-confirm with the user before calling submit_form again.";
    return "not all fields are filled yet";
  }
  return "unknown tool";
}

// Confirm a spoken address against NYC geosearch and swap in the official full
// address (always borough-qualified). A sequence guard keeps only the latest lookup.
export async function verifyAddress(value) {
  const seq = ++state.addrSeq;
  // Peel off any apartment/unit BEFORE geosearch. Picking an on-screen A–D candidate
  // re-sends a unit-less address — keep the unit we already captured in that case;
  // any other unit-less input is a fresh address, so clear a stale unit.
  const isPick = state.addrChoices.some((c) => c.full === value);
  const { base, unit } = splitUnit(value);
  if (unit) state.addrUnit = unit;
  else if (!isPick) state.addrUnit = "";
  state.addrStatus = "checking"; state.addrBorough = ""; state.addrChoices = [];
  renderRail(null); renderCard();
  try {
    const r = await fetch("/api/geosearch?text=" + encodeURIComponent(base));
    const j = await r.json();
    if (seq !== state.addrSeq) return null;            // a newer correction superseded this lookup
    if (j && j.status === "confirmed" && j.full) {
      state.addrStatus = "ok"; state.addrBorough = j.borough || ""; state.addrChoices = [];
      state.addrVerified = j.full;                     // the building geosearch actually confirmed (no unit)
      j.full = withUnit(j.full, state.addrUnit);       // re-attach the unit geosearch can't resolve
      setField("address", j.full);                     // display the canonical full address (+ unit)
      return j;
    }
    // ambiguous / not_found / error → leave the address UNCONFIRMED (blocks completion).
    // Whenever we couldn't auto-confirm but DID get candidates back, surface the
    // top 4 as A/B/C/D choices the user can tap or say — regardless of the reason.
    state.addrStatus = "none";
    state.addrChoices = (j && j.candidates ? j.candidates : []).slice(0, 4).map((c, i) => ({
      letter: "ABCD"[i], full: c.full, borough: c.borough,
    }));
    renderRail(null); renderCard();
    if (state.addrChoices.length) {
      announce(
        "Couldn't confirm that address. " + state.addrChoices.length +
        " options to choose from: " +
        state.addrChoices.map((c) => c.letter + ", " + (c.full || c.borough)).join("; ") +
        ". " + TAP + " one or say its letter.",
      );
    } else {
      announce("Couldn't confirm that address. Please repeat the street number, street, and borough.");
    }
    return j || { status: "not_found" };
  } catch (e) {
    console.error(e);
    if (seq === state.addrSeq) { state.addrStatus = "none"; renderRail(null); renderCard(); }
    return { status: "error" };
  }
}

// Commit a chosen address (from a tap or a spoken letter) and confirm it locally.
export function chooseAddress(full) {
  if (!full) return;
  state.addrVerified = full;                         // the building that was confirmed (no unit)
  full = withUnit(full, state.addrUnit);             // carry the apartment/unit onto the picked building
  state.addrSeq++;                                   // cancel any in-flight lookup
  state.addrChoices = [];
  state.addrStatus = "ok";
  state.addrBorough = NYC_BOROUGHS.find((b) => full.includes(b)) || "";
  setField("address", full);                         // fill + re-render (badge shows ✓ borough)
  // Tell the model what was picked so it acknowledges and moves to the next field.
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Use this address: " + full }] }],
        turnComplete: true,
      },
    }));
}

// Debounced confirmation for the MANUAL typing path, so typed addresses are held
// to the same standard as spoken ones (must resolve to a real NYC address w/ borough).
let addrVerifyTimer = null;
export function scheduleAddrVerify(value) {
  clearTimeout(addrVerifyTimer);
  if (!value || !value.trim()) return;
  addrVerifyTimer = setTimeout(() => verifyAddress(value.trim()), 600);
}
