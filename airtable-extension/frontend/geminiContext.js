// ============================================================================
// geminiContext.js — build the Gemini Live setup (system instruction + tools)
// DYNAMICALLY from the live Airtable schema and the current user.
//
// This is the heart of the request: nothing about the form is hard-coded. The
// system instruction is assembled at every connect from
//   • the user's name              (session.currentUser.name)
//   • the destination table name
//   • each visible field, IN VIEW ORDER, with its type, options, and help text
// and the set_field tool's `field` enum is exactly the current field slugs. So
// when someone reorders the view, renames a field, or edits its choices, the
// model's understanding of the form changes with it — no code edit, no redeploy.
// ============================================================================

// Human-readable, per-kind guidance the model uses to normalise spoken input
// into the value the field expects.
function fieldKindHint(f) {
    switch (f.kind) {
        case "number":
            return "a number" + (f.max ? " from 1 to " + f.max : "");
        case "checkbox":
            return 'yes/no — set the value to "yes" or "no"';
        case "select":
            return (
                "exactly one of these options: " +
                (f.choices && f.choices.length ? f.choices.join(", ") : "(no options defined)")
            );
        case "multiselect":
            return (
                "one or more of these options, comma-separated: " +
                (f.choices && f.choices.length ? f.choices.join(", ") : "(no options defined)")
            );
        case "date":
            return 'a date, formatted "Month D, YYYY" (e.g. "March 3, 1990")';
        case "datetime":
            return 'a date and time, formatted "Month D, YYYY h:mm AM/PM"';
        case "longtext":
            return "free text (a sentence or two is fine)";
        case "barcode":
            return "the barcode's text/number";
        default:
            return "free text";
    }
}

function fieldLine(f, i) {
    const bits = [`${i + 1}. ${f.slug} — "${f.name}" (${fieldKindHint(f)})`];
    if (f.description) bits.push(`   Field help: ${f.description}`);
    return bits.join("\n");
}

// Optional resume preamble so a reconnected session (the live socket times out
// after a pause) picks up where it left off instead of re-greeting from field 1.
function resumeContext(fields, values) {
    const filled = fields.filter((f) => (values[f.slug] || "").trim());
    if (!filled.length) return "";
    const lines = filled
        .map((f) => `- ${f.name}: ${values[f.slug]}`)
        .join("\n");
    const next = fields.find((f) => !(values[f.slug] || "").trim());
    const head =
        "\n\n--- RESUMING AN IN-PROGRESS SESSION ---\n" +
        "These fields are already filled in and shown on screen — treat them as captured " +
        "unless the user asks to change one:\n" +
        lines +
        "\nDo NOT greet as if starting fresh and do NOT re-ask the fields above. ";
    return next
        ? head +
              `In one short sentence welcome them back, then ask for the next field: "${next.name}".`
        : head +
              "In one short sentence welcome them back, then read all the values back and ask " +
              '"Is everything correct?" so you can submit.';
}

export function buildSystemInstruction({ fields, values, userName, tableName }) {
    const who = userName ? `You're helping ${userName}. ` : "";
    const dest = tableName ? ` Their answers become a new record in the "${tableName}" table.` : "";
    const list = fields.map(fieldLine).join("\n");

    const base = `You are "FormSpeak", a warm, fast voice assistant that helps a user fill out a form just by talking. ${who}The form has exactly ${fields.length} field${fields.length === 1 ? "" : "s"}, in this order:${dest}

${list}

How to behave:
- Greet the user in ONE short sentence (use their name if you know it), then ask for the first field.
- Guide them one field at a time, in order — but if they volunteer several details at once, capture every one immediately.
- The MOMENT you understand a value, call the set_field tool with that field's slug (the identifier before the dash above) and the normalized value. Never wait for the user to finish or to confirm before filling a field — fill it live so they see it on screen.
- If the user corrects themselves ("no, it's…", "actually…", "B as in boy"), call set_field again with the corrected value. Always trust the most recent correction.
- Normalize each value to the format described for its field. For single-select and multi-select fields you MUST pick from the listed options; match what the user says to the closest option, and only if nothing fits should you use their words verbatim. For yes/no (checkbox) fields, set the value to exactly "yes" or "no". Read back dates, numbers, and the spelling of names right after capturing them so the user can catch mistakes.
- After each set_field call, the tool response tells you whether the value was accepted or what's wrong; act on it. If a value was rejected (e.g. an option that doesn't exist, an unreadable date), tell the user briefly and ask again.
- Keep every spoken reply short and natural — one or two sentences, no filler.
- Language: speak English by default, but if the user consistently speaks another language, switch and carry on in it. Field values keep their formats regardless of spoken language.
- When every field is filled, read back ALL the values clearly and ask "Is everything correct?". Only call submit_form AFTER the user clearly confirms (e.g. "yes", "that's right"). If they want a change, fix it with set_field and confirm again before submitting.
- NEVER call submit_form until the user has verbally confirmed everything.`;

    return base + resumeContext(fields, values);
}

export function buildTools(fields) {
    const slugs = fields.map((f) => f.slug);
    return [
        {
            functionDeclarations: [
                {
                    name: "set_field",
                    description:
                        "Set or correct one field on the form. Call this the instant you understand a value, and again whenever the user corrects it.",
                    parameters: {
                        type: "object",
                        properties: {
                            field: {
                                type: "string",
                                enum: slugs,
                                description:
                                    "Which field to fill — the slug identifier listed in the instructions.",
                            },
                            value: {
                                type: "string",
                                description:
                                    "The normalized value to display, formatted as described for that field.",
                            },
                        },
                        required: ["field", "value"],
                    },
                },
                {
                    name: "submit_form",
                    description:
                        "Submit the completed form as a new record. ONLY call after the user has verbally confirmed every value is correct.",
                    parameters: { type: "object", properties: {} },
                },
            ],
        },
    ];
}
