// ============================================================================
// schema.js — turn an Airtable view's field schema into (a) form-input
// descriptors and (b) writable cell values for createRecordAsync.
//
// This is what makes the form "informed by a schema call": the host reads the
// view's visibleFields (already in view order) and hands each Field here. We
// classify it, decide how to render it, describe it to the Gemini model, and —
// on submit — coerce the captured string back into the exact cell-value shape
// Airtable's write API expects for that field type.
//
// Read-only / computed fields (formula, rollup, lookup, autonumber, created
// time, …) are detected via field.isComputed and excluded — you can neither
// type into them nor write them. A few writable-but-structurally-complex types
// (record links, collaborators, attachments) are marked "unsupported" so the
// form stays robust rather than guessing at record ids the user can't speak.
// ============================================================================

import { FieldType } from "@airtable/blocks/models";

// Field types we render + write, grouped by how they behave in the form.
const TEXT_TYPES = new Set([
    FieldType.SINGLE_LINE_TEXT,
    FieldType.EMAIL,
    FieldType.URL,
    FieldType.PHONE_NUMBER,
]);
const LONGTEXT_TYPES = new Set([
    FieldType.MULTILINE_TEXT,
    FieldType.RICH_TEXT,
]);
const NUMBER_TYPES = new Set([
    FieldType.NUMBER,
    FieldType.CURRENCY,
    FieldType.PERCENT,
    FieldType.DURATION,
    FieldType.RATING,
]);

// HTML inputmode / type hints so phones show the right keyboard for typed entry.
const TEXT_INPUT_HINT = {
    [FieldType.EMAIL]: { type: "email", inputMode: "email" },
    [FieldType.URL]: { type: "url", inputMode: "url" },
    [FieldType.PHONE_NUMBER]: { type: "tel", inputMode: "tel" },
};

// Classify a Field into a render/write "kind". Returns null for fields the form
// must not touch (computed, or complex types we deliberately don't handle).
export function describeField(field) {
    if (!field) return null;
    // Computed fields are never writable and never typed into.
    if (field.isComputed) {
        return unsupported(field, "computed (read-only)");
    }
    const t = field.type;

    let kind = null;
    let input = null;
    let choices = null;

    if (TEXT_TYPES.has(t)) {
        kind = "text";
        input = TEXT_INPUT_HINT[t] || { type: "text", inputMode: "text" };
    } else if (LONGTEXT_TYPES.has(t)) {
        kind = "longtext";
    } else if (NUMBER_TYPES.has(t)) {
        kind = "number";
        input = { type: t === FieldType.RATING ? "number" : "text", inputMode: "decimal" };
    } else if (t === FieldType.CHECKBOX) {
        kind = "checkbox";
    } else if (t === FieldType.SINGLE_SELECT) {
        kind = "select";
        choices = choiceNames(field);
    } else if (t === FieldType.MULTIPLE_SELECTS) {
        kind = "multiselect";
        choices = choiceNames(field);
    } else if (t === FieldType.DATE) {
        kind = "date";
    } else if (t === FieldType.DATE_TIME) {
        kind = "datetime";
    } else if (t === FieldType.BARCODE) {
        kind = "barcode";
        input = { type: "text", inputMode: "text" };
    } else {
        // record links, collaborators, attachments, button, etc.
        return unsupported(field, "field type not supported in this form");
    }

    return {
        id: field.id,
        name: field.name,
        description: field.description || "",
        slug: slugify(field.name, field.id),
        kind,
        input: input || { type: "text", inputMode: "text" },
        choices,
        max: t === FieldType.RATING ? ratingMax(field) : null,
        supported: true,
    };
}

function unsupported(field, why) {
    return {
        id: field.id,
        name: field.name,
        description: field.description || "",
        slug: slugify(field.name, field.id),
        kind: "unsupported",
        why,
        supported: false,
    };
}

function choiceNames(field) {
    const opts = field.options && field.options.choices;
    return Array.isArray(opts) ? opts.map((c) => c.name) : [];
}
function ratingMax(field) {
    const m = field.options && field.options.max;
    return typeof m === "number" ? m : 5;
}

// A stable, model-friendly key derived from the field name (the model's tool
// enum reads "first_name", not "fldXX…"). Falls back to the field id if a name
// slugs to empty, and the host de-dupes collisions.
export function slugify(name, fallbackId) {
    const s = String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return s || fallbackId;
}

// Build the FIELDS array the rest of the app drives off, from the view's
// ordered visibleFields. Only supported fields become form rows; unsupported
// ones are returned separately so the UI can disclose what it skipped. Slugs
// are made unique so the tool enum has no collisions.
export function buildSchema(visibleFields) {
    const supported = [];
    const skipped = [];
    const seen = new Set();
    for (const field of visibleFields) {
        const d = describeField(field);
        if (!d) continue;
        if (!d.supported) {
            skipped.push(d);
            continue;
        }
        let slug = d.slug;
        let n = 2;
        while (seen.has(slug)) slug = d.slug + "_" + n++;
        seen.add(slug);
        d.slug = slug;
        supported.push(d);
    }
    return { fields: supported, skipped };
}

// ---------------------------------------------------------------------------
// Cell-value coercion: captured string  →  the exact write shape Airtable wants
// for createRecordAsync. Returns { ok, value, reason }. ok=false means "leave
// this field unset" (empty input, or a value that couldn't be coerced).
// ---------------------------------------------------------------------------
export function coerceCellValue(descriptor, raw) {
    const s = (raw == null ? "" : String(raw)).trim();
    if (!s) return { ok: false, reason: "empty" };

    switch (descriptor.kind) {
        case "text":
        case "longtext":
            return { ok: true, value: s };

        case "barcode":
            return { ok: true, value: { text: s } };

        case "number": {
            // Keep digits, one decimal point, and a leading sign; tolerate "$1,200".
            const cleaned = s.replace(/[^0-9.\-]/g, "");
            const num = parseFloat(cleaned);
            if (isNaN(num)) return { ok: false, reason: "not a number" };
            return { ok: true, value: num };
        }

        case "checkbox":
            return { ok: true, value: TRUTHY.has(s.toLowerCase()) };

        case "select": {
            const name = matchChoice(descriptor.choices, s) || s;
            return { ok: true, value: { name } };
        }

        case "multiselect": {
            const parts = s
                .split(/[,;]+/)
                .map((p) => p.trim())
                .filter(Boolean);
            if (!parts.length) return { ok: false, reason: "empty" };
            const value = parts.map((p) => ({
                name: matchChoice(descriptor.choices, p) || p,
            }));
            return { ok: true, value };
        }

        case "date": {
            const iso = toISODate(s);
            return iso
                ? { ok: true, value: iso }
                : { ok: false, reason: "unparseable date" };
        }

        case "datetime": {
            const iso = toISODateTime(s);
            return iso
                ? { ok: true, value: iso }
                : { ok: false, reason: "unparseable date/time" };
        }

        default:
            return { ok: false, reason: "unsupported field" };
    }
}

const TRUTHY = new Set([
    "true", "yes", "y", "1", "on", "checked", "check", "done", "x",
]);

// Case-insensitive match of a spoken/typed value to one of the field's existing
// option names, so "english" snaps to the real "English" choice and we don't
// spawn near-duplicate options. Returns the canonical name or null.
function matchChoice(choices, value) {
    if (!Array.isArray(choices)) return null;
    const v = value.toLowerCase();
    const exact = choices.find((c) => c.toLowerCase() === v);
    if (exact) return exact;
    const partial = choices.find(
        (c) => c.toLowerCase().includes(v) || v.includes(c.toLowerCase()),
    );
    return partial || null;
}

// "March 3, 1990" | "1990-03-03" | "3/3/1990"  →  "1990-03-03"
export function toISODate(s) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
export function toISODateTime(s) {
    const d = new Date(s);
    if (isNaN(d.getTime())) {
        // bare date → midnight UTC
        const day = toISODate(s);
        return day ? day + "T00:00:00.000Z" : null;
    }
    return d.toISOString();
}
