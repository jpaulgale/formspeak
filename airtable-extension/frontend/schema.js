// ============================================================================
// schema.js — turn an Airtable table's field schema into (a) form-input
// descriptors and (b) writable cell values for createRecordAsync.
//
// Built for the Airtable **Interface Extensions** SDK (`interface-alpha`):
//   • Field type is read from `field.config.type` (NOT `field.type`), compared
//     against the `FieldType` enum from `@airtable/blocks/interface/models`.
//   • Select choices come from `field.options?.choices`.
//   • The interface SDK has no `field.isComputed`, so computed/read-only types
//     are detected with an explicit set.
//
// NOTE on "fields in view order": the interface-alpha SDK does not expose
// view-level field ordering or visibility (no `useViewMetadata`). We therefore
// drive the form from the configured table's field order (`table.fields`),
// skipping computed and structurally-complex types. The builder controls which
// table feeds the form via the extension's custom properties.
// ============================================================================

import { FieldType } from "@airtable/blocks/interface/models";

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

// Computed / read-only: never writable, never typed into. (interface-alpha has
// no `field.isComputed`, so we enumerate.)
const COMPUTED_TYPES = new Set([
    FieldType.AI_TEXT,
    FieldType.AUTO_NUMBER,
    FieldType.BUTTON,
    FieldType.COUNT,
    FieldType.CREATED_BY,
    FieldType.CREATED_TIME,
    FieldType.FORMULA,
    FieldType.LAST_MODIFIED_BY,
    FieldType.LAST_MODIFIED_TIME,
    FieldType.MULTIPLE_LOOKUP_VALUES,
    FieldType.ROLLUP,
    FieldType.EXTERNAL_SYNC_SOURCE,
]);

// HTML input hints so the right keyboard shows for typed entry.
const TEXT_INPUT_HINT = {
    [FieldType.EMAIL]: { type: "email", inputMode: "email" },
    [FieldType.URL]: { type: "url", inputMode: "url" },
    [FieldType.PHONE_NUMBER]: { type: "tel", inputMode: "tel" },
};

function fieldType(field) {
    return (field && field.config && field.config.type) || (field && field.type);
}
function fieldChoices(field) {
    const opts =
        (field && field.options && field.options.choices) ||
        (field && field.config && field.config.options && field.config.options.choices);
    return Array.isArray(opts) ? opts.map((c) => c.name) : [];
}
function fieldRatingMax(field) {
    const m =
        (field && field.options && field.options.max) ||
        (field && field.config && field.config.options && field.config.options.max);
    return typeof m === "number" ? m : 5;
}

// Classify a Field into a render/write "kind". `supported:false` means the form
// must not touch it (computed, or a complex type we deliberately don't handle).
export function describeField(field) {
    if (!field) return null;
    const t = fieldType(field);
    if (COMPUTED_TYPES.has(t)) return unsupported(field, "computed (read-only)");

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
        choices = fieldChoices(field);
    } else if (t === FieldType.MULTIPLE_SELECTS) {
        kind = "multiselect";
        choices = fieldChoices(field);
    } else if (t === FieldType.DATE) {
        kind = "date";
    } else if (t === FieldType.DATE_TIME) {
        kind = "datetime";
    } else if (t === FieldType.BARCODE) {
        kind = "barcode";
        input = { type: "text", inputMode: "text" };
    } else {
        // record links, collaborators, attachments, etc.
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
        max: t === FieldType.RATING ? fieldRatingMax(field) : null,
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

// A stable, model-friendly key from the field name (the tool enum reads
// "first_name", not "fldXX…"). Falls back to the field id; the caller de-dupes.
export function slugify(name, fallbackId) {
    const s = String(name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return s || fallbackId;
}

// Build the FIELDS array the app drives off, from a table's ordered fields.
// Only supported fields become form rows; unsupported ones are returned
// separately so the UI can disclose what it skipped. Slugs are made unique.
export function buildSchema(fields) {
    const supported = [];
    const skipped = [];
    const seen = new Set();
    for (const field of fields || []) {
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
// for createRecordAsync. Returns { ok, value, reason }. ok=false ⇒ leave unset.
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
            const parts = s.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
            if (!parts.length) return { ok: false, reason: "empty" };
            return {
                ok: true,
                value: parts.map((p) => ({ name: matchChoice(descriptor.choices, p) || p })),
            };
        }

        case "date": {
            const iso = toISODate(s);
            return iso ? { ok: true, value: iso } : { ok: false, reason: "unparseable date" };
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

const TRUTHY = new Set(["true", "yes", "y", "1", "on", "checked", "check", "done", "x"]);

// Case-insensitive match of a spoken/typed value to an existing option name, so
// "english" snaps to "English" and we don't spawn near-duplicate options.
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
        const day = toISODate(s);
        return day ? day + "T00:00:00.000Z" : null;
    }
    return d.toISOString();
}
