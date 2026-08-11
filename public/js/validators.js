// Pure validation, formatting, and parsing. No DOM, no state — every function
// here is deterministic on its inputs, which is what makes this module directly
// unit-testable (tests/js/) and portable to the Python eval harness
// (tests/formspeak_env.py keeps a line-for-line port; tests/fixtures/ holds the
// shared cases both sides must pass).

/* ------------------------------------------------------------------
   Phone — a number is "confirmed" once its digit count is valid: a US
   number is 10 digits (an optional leading "1" country code — e.g.
   "1 212 555 1234" → 11 digits — is fine), or an international number
   that starts with "+" and carries 8–15 digits (E.164). Formatting is
   cosmetic; only the digit count decides validity.
   ------------------------------------------------------------------ */
export function phoneDigits(v) { return (v || "").replace(/\D/g, ""); }
export function phoneInfo(v) {
  const raw = (v || "").trim();
  const plus = raw.startsWith("+");
  const d = phoneDigits(raw);
  if (!d.length) return { ok: false, reason: "empty", n: 0 };
  if (plus) {
    if (d.length < 8) return { ok: false, reason: "short", n: d.length };
    if (d.length > 15) return { ok: false, reason: "long", n: d.length };
    return { ok: true, intl: true, n: d.length };
  }
  if (d.length === 10) return { ok: true, n: 10 };                 // US national
  if (d.length === 11 && d[0] === "1") return { ok: true, n: 11 }; // 1 + 10 → US
  if (d.length < 10) return { ok: false, reason: "short", n: d.length };
  return { ok: false, reason: "needsplus", n: d.length };          // 11+ and not 1-led
}
export function phoneConfirmed(v) { return phoneInfo(v).ok; }
export function phoneReason(r) {
  return r === "short" ? "needs at least 10 digits"
    : r === "long" ? "too many digits"
    : r === "needsplus" ? "add + and a country code"
    : "enter a phone number";
}
// Cosmetic as-you-type / on-set formatter. A US number → (212) 555-1234 (with a
// "+1 " prefix when a country code is present); international → "+" w/ light grouping.
export function formatUSPhone(d, withCC) {
  let out;
  if (d.length > 6) out = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6, 10);
  else if (d.length > 3) out = "(" + d.slice(0, 3) + ") " + d.slice(3);
  else if (d.length > 0) out = "(" + d;
  else out = "";
  return withCC ? ("+1 " + out).trimEnd() : out;
}
export function groupIntlPhone(d) {
  if (d.length <= 2) return d;
  const rest = d.slice(2);
  return d.slice(0, 2) + (rest ? " " + (rest.match(/.{1,3}/g) || []).join(" ") : "");
}
export function formatPhone(v) {
  const raw = (v || "").trim();
  const plus = raw.startsWith("+");
  const d = phoneDigits(raw);
  if (!plus) {
    if (d.length <= 10) return formatUSPhone(d, false);
    if (d.length === 11 && d[0] === "1") return formatUSPhone(d.slice(1), true);
    return "+" + groupIntlPhone(d);
  }
  if (d[0] === "1" && d.length <= 11) return formatUSPhone(d.slice(1), true);
  return "+" + groupIntlPhone(d);
}

/* ------------------------------------------------------------------
   Date of birth — only valid if it resolves to a year in [1900, 2026].
   ------------------------------------------------------------------ */
export function dobInfo(v) {
  if (!v || !String(v).trim()) return { ok: false, reason: "empty" };
  const m = String(v).match(/\b(\d{4})\b/);          // pull the 4-digit year
  if (!m) return { ok: false, reason: "no_year" };
  const year = parseInt(m[1], 10);
  if (year < 1900) return { ok: false, reason: "too_early", year };
  if (year > 2026) return { ok: false, reason: "too_late", year };
  return { ok: true, year };
}
export function dobReasonText(reason) {
  if (reason === "too_early") return "before 1900";
  if (reason === "too_late") return "after 2026";
  return "invalid date";
}

// The DOB field uses a native <input type="date"> (value = "YYYY-MM-DD"), but the
// rest of the app — voice model, review list, saved payload — speaks the readable
// "Month D, YYYY" form. These convert between the two; dobInfo() accepts either.
export const DOB_MONTHS = ["January","February","March","April","May","June",
  "July","August","September","October","November","December"];
export const DOB_MIN = "1900-01-01";
export const DOB_MAX = "2026-12-31";
export function dobToISO(v) {                  // display string → YYYY-MM-DD for the picker
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; // already ISO
  const d = new Date(v);                       // parse "Month D, YYYY" in local time
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
export function isoToDOB(iso) {                 // picker value → "Month D, YYYY" for everything else
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  return DOB_MONTHS[+m[2] - 1] + " " + (+m[3]) + ", " + (+m[1]);
}

/* ------------------------------------------------------------------
   Household size — a single-select: a whole number of people, 1 through
   8+. "8 or more" (or anything ≥ 8) lands in the 8+ bucket.
   ------------------------------------------------------------------ */
export function hhSizeInfo(v) {
  if (v == null || !String(v).trim()) return { ok: false, reason: "empty" };
  const m = String(v).match(/\d+/);
  if (!m) return { ok: false, reason: "no_number" };
  let n = parseInt(m[0], 10);
  if (n < 1) return { ok: false, reason: "too_small", n };
  if (n > 8) n = 8;                                   // 8+ bucket
  return { ok: true, n };
}

// Map an arbitrary value (e.g. a voice-provided "5" or "eight") onto one of a
// select field's exact option strings, so the dropdown always reflects state.
export function selectOptionFor(f, v) {
  if (!v) return "";
  if (f.select.includes(v)) return v;                 // already an exact option
  if (f.key === "household_size") {                   // snap a raw count to its option ("8 or more" at 8+)
    const info = hhSizeInfo(v);
    if (info.ok) return info.n >= 8 ? "8 or more" : String(info.n);
  }
  return "";
}

/* ------------------------------------------------------------------
   Monthly household income — any dollar amount, including $0 (no income).
   ------------------------------------------------------------------ */
export function incomeInfo(v) {
  if (v == null || !String(v).trim()) return { ok: false, reason: "empty" };
  const digits = String(v).replace(/[^0-9.]/g, "");
  if (!digits) return { ok: false, reason: "no_number" };
  const amt = parseFloat(digits);
  if (isNaN(amt) || amt < 0) return { ok: false, reason: "invalid" };
  return { ok: true, amt };
}

/* ------------------------------------------------------------------
   Apartment/unit peeling — Pelias (NYC geosearch) only resolves to the
   building (house number + street), and an apartment glued on can derail
   the match. So we peel a trailing secondary-unit token off the input,
   geosearch the bare building, then re-attach the unit to the confirmed
   address. The unit vocabulary is the USPS Pub. 28 (Appendix C2)
   designator set — the same list the `parse-address` library encodes —
   minus the ambiguous English words (front, rear, lower, …) that collide
   with real street names, plus the "#" shorthand.
   ------------------------------------------------------------------ */
export const UNIT_KW = "apt|apartment|unit|ste|suite|rm|room|fl|floor|bldg|building|dept|department|lot|spc|space|trlr|trailer|hngr|hangar|slip|pier|penthouse|ph|no";
export const UNIT_RE = new RegExp(
  "[,\\s]+(?:#\\s*([A-Za-z0-9][A-Za-z0-9-]*)|(" + UNIT_KW + ")\\.?\\s*#?\\s*([A-Za-z0-9][A-Za-z0-9-]*))(?=$|[,\\s])",
  "i",
);
// → { base: "171 E 2nd St, New York NY", unit: "#7" }  (unit is "" when none found)
export function splitUnit(value) {
  const v = String(value || "").trim();
  const m = v.match(UNIT_RE);
  if (!m) return { base: v, unit: "" };
  // Guard against false hits on street names (e.g. "100 Floor Ave"): a keyword-style
  // unit must carry a digit or be a tiny tag like "B"/"6D". The "#" form is always a unit.
  if (m[2] && !(/\d/.test(m[3]) || m[3].length <= 2)) return { base: v, unit: "" };
  const base = (v.slice(0, m.index) + " " + v.slice(m.index + m[0].length))
    .replace(/\s*,\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "").trim();
  const unit = m[1] != null
    ? "#" + m[1]                                                       // "#7"
    : m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase() + " " + m[3]; // "Apt 6D"
  return { base, unit };
}
// Splice an apartment/unit into a canonical "STREET, Borough, NY ZIP" address,
// right after the street segment: "171 EAST 2 STREET #7, Manhattan, NY 10009".
export function withUnit(full, unit) {
  if (!unit) return full;
  const i = full.indexOf(",");
  return i === -1 ? full + " " + unit : full.slice(0, i) + " " + unit + full.slice(i);
}

/* ------------------------------------------------------------------
   Transcript denoising — Gemini's live audio ASR sometimes hallucinates a
   stray non-Latin glyph (most often a CJK/Hangul character) into an
   otherwise-English transcript — a known artifact on silence or low-level
   noise. Drop those isolated foreign characters so the caption and logs
   stay clean. BUT if the user is genuinely speaking another language — a
   sustained run of foreign script — leave the text untouched so the
   transcript follows whatever language they're actually using. Accented
   Latin (é, ñ, ü …) is NOT in this range, so Spanish/Haitian Creole
   survive intact.
   ------------------------------------------------------------------ */
export const FOREIGN_RE = /[Ѐ-ԯ֐-׿؀-ۿऀ-ॿঀ-৿฀-๿　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;
export function denoiseTranscript(s) {
  if (!s) return s;
  const foreign = (s.match(FOREIGN_RE) || []).length;
  if (!foreign) return s;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  // Sustained foreign script (a real other-language utterance) → keep as-is.
  // A hallucinated glyph is one or two isolated characters; a genuine phrase is
  // either several characters or clearly outweighs any Latin in the line.
  if (foreign >= 5 || (foreign >= 3 && foreign > latin)) return s;
  // Otherwise: stray noise. Strip it and tidy the gap it leaves behind.
  return s.replace(FOREIGN_RE, "").replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
}
