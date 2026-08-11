// Deterministic form-completion logic: which fields count as done, which field
// is "up" next, and the snapshot telemetry uses to record how far a session got.
// This is the gate that doesn't depend on the model reading anything back.

import { FIELDS } from "./config.js";
import { state } from "./state.js";
import { phoneConfirmed, dobInfo, hhSizeInfo, incomeInfo } from "./validators.js";

// A field counts as complete only when it has a value — and, for the address,
// only once NYC geosearch has CONFIRMED it (which guarantees a city/borough).
export function isFilled(f) {
  if (!state.values[f.key]) return false;
  if (f.key === "address") return state.addrStatus === "ok";
  if (f.key === "phone") return phoneConfirmed(state.values.phone);            // 10 digits / +country code
  if (f.key === "date_of_birth") return dobInfo(state.values.date_of_birth).ok; // 1900–2026
  if (f.key === "household_size") return hhSizeInfo(state.values.household_size).ok;       // 1–8+
  if (f.key === "household_income") return incomeInfo(state.values.household_income).ok;   // a dollar amount
  return true;
}

export function activeIndex() {
  const i = FIELDS.findIndex((f) => !isFilled(f));
  return i; // -1 means all filled → review mode
}

// How far an (often abandoned) session got, without replaying the transcript.
export const fieldsSnapshot = () => ({
  filled: FIELDS.filter(isFilled).map((f) => f.key),
  present: FIELDS.filter((f) => (state.values[f.key] || "").trim()).map((f) => f.key),
  addr_status: state.addrStatus,
  addr_unit: state.addrUnit || "",
  submitted: !!state.submitted,
});
