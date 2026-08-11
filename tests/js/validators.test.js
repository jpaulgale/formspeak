// Unit tests for the SHIPPED validators (public/js/validators.js) — the exact
// module the browser loads, not a copy. Cases live in the shared fixture so the
// Python ports (tests/formspeak_env.py) are held to the same answers.
//
//   npm test        (node --test tests/js/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  phoneInfo, formatPhone, dobInfo, hhSizeInfo, incomeInfo, splitUnit, withUnit,
} from "../../public/js/validators.js";

const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/validator-cases.json", import.meta.url)), "utf8"),
);

// Check every expected key the fixture lists (ok always; reason/n/year/amt/intl when present).
function checkInfo(actual, expected, label) {
  assert.equal(actual.ok, expected.ok, `${label}: ok`);
  for (const k of ["reason", "n", "year", "amt", "intl"]) {
    if (k in expected) assert.equal(actual[k], expected[k], `${label}: ${k}`);
  }
}

test("phoneInfo matches fixture", () => {
  for (const c of cases.phone) checkInfo(phoneInfo(c.input), c, JSON.stringify(c.input));
});

test("dobInfo matches fixture", () => {
  for (const c of cases.dob) checkInfo(dobInfo(c.input), c, JSON.stringify(c.input));
});

test("hhSizeInfo matches fixture", () => {
  for (const c of cases.household_size) checkInfo(hhSizeInfo(c.input), c, JSON.stringify(c.input));
});

test("incomeInfo matches fixture", () => {
  for (const c of cases.income) checkInfo(incomeInfo(c.input), c, JSON.stringify(c.input));
});

test("splitUnit matches fixture", () => {
  for (const c of cases.split_unit) {
    const { base, unit } = splitUnit(c.input);
    assert.equal(base, c.base, `${c.input}: base`);
    assert.equal(unit, c.unit, `${c.input}: unit`);
  }
});

test("withUnit matches fixture", () => {
  for (const c of cases.with_unit) {
    assert.equal(withUnit(c.full, c.unit), c.output);
  }
});

// Display formatting is cosmetic and JS-only (the Python harness never formats),
// so these cases live here rather than in the shared fixture.
test("formatPhone display formatting", () => {
  assert.equal(formatPhone("2125551234"), "(212) 555-1234");
  assert.equal(formatPhone("12125551234"), "+1 (212) 555-1234");
  assert.equal(formatPhone("+12125551234"), "+1 (212) 555-1234");
  assert.equal(formatPhone("212555"), "(212) 555");
  assert.equal(formatPhone("+442079460958"), "+44 207 946 095 8");
  assert.equal(formatPhone(""), "");
});
