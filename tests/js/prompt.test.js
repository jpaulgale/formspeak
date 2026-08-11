// Contract tests for the model-facing surface (public/js/prompt.js): the tool
// enum must track the form's field list, and the prompt must reference every
// field it claims the form has — drift here breaks the app silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELDS } from "../../public/js/config.js";
import { SYSTEM_INSTRUCTION, TOOLS } from "../../public/js/prompt.js";

test("set_field enum is exactly the form fields + optional feedback", () => {
  const decls = TOOLS[0].functionDeclarations;
  const setField = decls.find((d) => d.name === "set_field");
  assert.ok(setField, "set_field declared");
  assert.deepEqual(setField.parameters.properties.field.enum,
    FIELDS.map((f) => f.key).concat(["feedback"]));
  assert.ok(decls.find((d) => d.name === "submit_form"), "submit_form declared");
  assert.equal(decls.length, 2, "exactly two tools — the whole contract");
});

test("system instruction names every field key", () => {
  for (const f of FIELDS) {
    assert.ok(SYSTEM_INSTRUCTION.includes(f.key), `prompt mentions ${f.key}`);
  }
});

test("system instruction keeps the load-bearing guardrails", () => {
  for (const phrase of [
    "NEVER pad, zero-fill, or invent digits",       // the partial-phone guardrail
    "a city or borough is REQUIRED",                 // no address without a borough
    "NEVER call submit_form until the user has verbally confirmed",
  ]) {
    assert.ok(SYSTEM_INSTRUCTION.includes(phrase), `prompt keeps: ${phrase}`);
  }
});
