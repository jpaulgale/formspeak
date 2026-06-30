// ============================================================================
// FormSpeak for Airtable — Interface Extension entry point (interface-alpha SDK).
//
// Reads a table's fields (in field order), renders them as a form you can fill
// by TYPING or by TALKING (Gemini Live), and on submit creates a record in the
// submission table. The field schema and the current user's name
// (session.currentUser.name) are injected into the Gemini context dynamically
// at every connect (see geminiContext.js).
//
// Interface Extensions SDK rules honoured (see SKILL.md):
//   • initializeBlock({interface: () => <App/>})  — NOT initializeBlock(() => …)
//   • Imports ONLY from @airtable/blocks/interface/{ui,models}.
//   • NO SDK UI components — plain HTML + Tailwind only.
//   • Config via useCustomProperties (getCustomProperties is module-scoped).
//   • field.config.type for type checks; table.getFieldIfExists for lookups.
//   • Writes: hasPermissionToCreateRecords([{fields}]) then createRecordAsync.
//   • Extensions run in a sandboxed cross-origin iframe → the microphone may be
//     blocked; voice is progressive enhancement, the typed form always works.
// ============================================================================

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
    initializeBlock,
    useBase,
    useSession,
    useCustomProperties,
    useColorScheme,
} from "@airtable/blocks/interface/ui";

import { getCustomProperties, DEFAULT_TOKEN_ENDPOINT } from "./config";
import { buildSchema, describeField, coerceCellValue } from "./schema";
import { buildSystemInstruction, buildTools } from "./geminiContext";
import { useGeminiLive } from "./useGeminiLive";
import "./style.css";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Aoede";

function FormSpeakApp() {
    const base = useBase();
    const { customPropertyValueByKey, errorState } =
        useCustomProperties(getCustomProperties);

    if (errorState) {
        return (
            <Shell>
                <p className="text-sm text-red-red">Error: {errorState.message}</p>
            </Shell>
        );
    }

    const sourceTable = customPropertyValueByKey.sourceTable;
    const submitTable = customPropertyValueByKey.submitTable || sourceTable;
    const tokenEndpoint =
        customPropertyValueByKey.tokenEndpoint || DEFAULT_TOKEN_ENDPOINT;

    if (!sourceTable) {
        return (
            <Shell>
                <p className="text-sm text-gray-gray500 dark:text-gray-gray400">
                    Open the properties panel (right) and pick a{" "}
                    <span className="font-medium">Form source table</span> to begin.
                </p>
            </Shell>
        );
    }

    // sourceTable is guaranteed non-null below — safe to read its fields.
    return (
        <FormRunner
            sourceTable={sourceTable}
            submitTable={submitTable}
            tokenEndpoint={tokenEndpoint}
        />
    );
}

function FormRunner({ sourceTable, submitTable, tokenEndpoint }) {
    const session = useSession();
    const userName =
        (session && session.currentUser && session.currentUser.name) || "";

    // THE schema call: the table's fields, in field order. (interface-alpha has
    // no view-metadata API, so table field order is the available ordering.)
    const { fields, skipped } = useMemo(
        () => buildSchema(sourceTable.fields),
        [sourceTable],
    );

    const [values, setValues] = useState({}); // slug -> string
    const [submitting, setSubmitting] = useState(false);
    const [submittedRecordId, setSubmittedRecordId] = useState(null);
    const [submitError, setSubmitError] = useState("");

    // Refs so Gemini's setup/tool callbacks always read the freshest schema+values.
    const fieldsRef = useRef(fields);
    const valuesRef = useRef(values);
    fieldsRef.current = fields;
    valuesRef.current = values;

    const setValue = useCallback((slug, val) => {
        setValues((v) => ({ ...v, [slug]: val }));
    }, []);

    const getToken = useCallback(async () => {
        const r = await fetch(tokenEndpoint, { method: "POST" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "token request failed (" + r.status + ")");
        if (j.error) throw new Error(j.error);
        if (!j.token) throw new Error("token endpoint returned no token");
        return j.token;
    }, [tokenEndpoint]);

    const buildSetup = useCallback(
        () => ({
            systemInstruction: buildSystemInstruction({
                fields: fieldsRef.current,
                values: valuesRef.current,
                userName,
                tableName: submitTable && submitTable.name,
            }),
            tools: buildTools(fieldsRef.current),
        }),
        [userName, submitTable],
    );

    const doSubmitRef = useRef(null);

    const onToolCall = useCallback(
        async (name, args) => {
            if (name === "set_field") {
                const slug = args.field;
                const f = fieldsRef.current.find((x) => x.slug === slug);
                if (!f) return "Unknown field '" + slug + "'.";
                if (typeof args.value !== "string") return "ok";
                setValue(slug, args.value);
                const c = coerceCellValue(f, args.value);
                if (!c.ok)
                    return '"' + f.name + '" not accepted (' + c.reason + "). Ask the user to clarify.";
                return f.name + ' set to "' + args.value + '". Continue to the next field.';
            }
            if (name === "submit_form") {
                const missing = fieldsRef.current.filter(
                    (f) => !(valuesRef.current[f.slug] || "").trim(),
                );
                if (missing.length)
                    return (
                        "Not yet — still empty: " +
                        missing.map((f) => f.name).join(", ") +
                        ". Ask for those, then confirm before submitting."
                    );
                const res = await (doSubmitRef.current && doSubmitRef.current());
                return res && res.ok
                    ? "submitted"
                    : "Submit failed: " + ((res && res.error) || "unknown error");
            }
            return "unknown tool";
        },
        [setValue],
    );

    const gemini = useGeminiLive({
        model: MODEL,
        voice: VOICE,
        getToken,
        buildSetup,
        onToolCall,
    });

    const doSubmit = useCallback(async () => {
        setSubmitError("");
        setSubmitting(true);
        try {
            const sameTable = submitTable.id === sourceTable.id;
            const writeFields = {};
            for (const f of fieldsRef.current) {
                const raw = valuesRef.current[f.slug];
                if (!raw || !String(raw).trim()) continue;
                // getFieldIfExists accepts an id OR a name → resolve by id within the
                // same table, by name when writing to a different table.
                const target = sameTable
                    ? submitTable.getFieldIfExists(f.id)
                    : submitTable.getFieldIfExists(f.name);
                if (!target) continue;
                const tDesc = describeField(target);
                if (!tDesc || !tDesc.supported) continue;
                const c = coerceCellValue(tDesc, raw);
                if (c.ok) writeFields[target.id] = c.value;
            }
            if (!Object.keys(writeFields).length)
                throw new Error("Nothing to submit yet — fill in at least one field.");
            if (!submitTable.hasPermissionToCreateRecords([{ fields: writeFields }]))
                throw new Error(
                    "You don't have permission to create a record in " + submitTable.name + ".",
                );
            const recordId = await submitTable.createRecordAsync(writeFields);
            setSubmittedRecordId(recordId);
            gemini.markSubmitted();
            return { ok: true, recordId };
        } catch (e) {
            const msg = String((e && e.message) || e);
            setSubmitError(msg);
            return { ok: false, error: msg };
        } finally {
            setSubmitting(false);
        }
    }, [sourceTable, submitTable, gemini]);
    doSubmitRef.current = doSubmit;

    if (submittedRecordId) {
        return (
            <DoneScreen
                submitTable={submitTable}
                onReset={() => {
                    setValues({});
                    setSubmittedRecordId(null);
                }}
            />
        );
    }

    const filledCount = fields.filter((f) => (values[f.slug] || "").trim()).length;
    const firstName = userName ? userName.split(" ")[0] : "";

    return (
        <Shell>
            <div className="mb-4">
                <h1 className="font-display font-bold text-xl text-gray-gray700 dark:text-gray-gray100">
                    {firstName ? `Hi ${firstName} — ` : ""}fill{" "}
                    {submitTable ? submitTable.name : "the form"} by voice or typing
                </h1>
                <p className="text-sm text-gray-gray500 dark:text-gray-gray400 mt-0.5">
                    {filledCount} of {fields.length} field
                    {fields.length === 1 ? "" : "s"} filled.
                </p>
            </div>

            <VoicePanel gemini={gemini} tokenEndpoint={tokenEndpoint} />

            <div className="flex flex-col gap-3 mt-4">
                {fields.map((f) => (
                    <FieldControl
                        key={f.slug}
                        field={f}
                        value={values[f.slug] || ""}
                        onChange={(val) => setValue(f.slug, val)}
                    />
                ))}
            </div>

            {skipped.length > 0 && (
                <p className="text-xs text-gray-gray400 dark:text-gray-gray500 mt-3">
                    Not shown ({skipped.length}):{" "}
                    {skipped.map((s) => `${s.name} (${s.why})`).join(", ")}.
                </p>
            )}

            {submitError && (
                <div className="mt-3 rounded-md bg-red-redLight3 dark:bg-red-redDark1 px-3 py-2">
                    <p className="text-sm text-red-red dark:text-red-redLight2">{submitError}</p>
                </div>
            )}

            <button
                type="button"
                disabled={submitting || !filledCount}
                onClick={doSubmit}
                className="mt-4 w-full bg-blue-blue text-white px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
            >
                {submitting ? "Submitting…" : "Submit"}
            </button>
        </Shell>
    );
}

// --- voice panel: mic control + live transcript, or a graceful fallback ------
function VoicePanel({ gemini, tokenEndpoint }) {
    const blocked = !gemini.micCapable || gemini.voiceUnavailable;

    if (blocked) {
        let standaloneOrigin = "";
        try {
            standaloneOrigin = new URL(tokenEndpoint).origin;
        } catch {}
        return (
            <div className="rounded-md bg-gray-gray75 dark:bg-gray-gray700 px-3 py-2.5">
                <p className="text-sm text-gray-gray600 dark:text-gray-gray300">
                    🎙️ Voice isn't available inside the embedded extension (Airtable's
                    frame blocks microphone access). Type your answers below
                    {standaloneOrigin ? (
                        <>
                            {" "}— or{" "}
                            <a
                                href={standaloneOrigin}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-blue underline"
                            >
                                open FormSpeak in its own tab
                            </a>{" "}
                            to talk.
                        </>
                    ) : (
                        " to fill the form."
                    )}
                </p>
            </div>
        );
    }

    const phaseLabel = !gemini.micActive
        ? "Paused"
        : gemini.phase === "speaking"
          ? "FormSpeak is speaking…"
          : gemini.phase === "thinking"
            ? "Thinking…"
            : "Listening…";

    return (
        <div className="rounded-md bg-gray-gray75 dark:bg-gray-gray700 px-3 py-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={gemini.toggleMic}
                    disabled={gemini.connecting}
                    className={
                        "px-3 py-1.5 rounded-md text-sm font-medium transition disabled:opacity-50 " +
                        (gemini.micActive
                            ? "border border-gray-gray300 dark:border-gray-gray600 text-gray-gray700 dark:text-gray-gray200 hover:bg-gray-gray100 dark:hover:bg-gray-gray600"
                            : "bg-blue-blue text-white hover:opacity-90")
                    }
                >
                    {gemini.connecting
                        ? "Connecting…"
                        : gemini.micActive
                          ? "⏸ Pause"
                          : gemini.connected
                            ? "Resume"
                            : "🎙️ Talk to fill"}
                </button>
                <span className="text-sm text-gray-gray500 dark:text-gray-gray400">
                    {phaseLabel}
                </span>
            </div>

            {(gemini.transcript.user || gemini.transcript.asst) && (
                <div className="text-sm">
                    {gemini.transcript.user && (
                        <p className="text-gray-gray700 dark:text-gray-gray200">
                            <span className="font-semibold">You:</span> {gemini.transcript.user}
                        </p>
                    )}
                    {gemini.transcript.asst && (
                        <p className="text-gray-gray500 dark:text-gray-gray400">
                            <span className="font-semibold">FormSpeak:</span>{" "}
                            {gemini.transcript.asst}
                        </p>
                    )}
                </div>
            )}

            {gemini.notice && (
                <p className="text-sm text-gray-gray500 dark:text-gray-gray400">{gemini.notice}</p>
            )}
            {gemini.error && <p className="text-sm text-red-red">{gemini.error}</p>}
        </div>
    );
}

// --- a single schema-driven form control (plain HTML + Tailwind) -------------
const INPUT_CLS =
    "w-full border border-gray-gray300 dark:border-gray-gray600 rounded-md px-2 py-1.5 text-sm bg-white dark:bg-gray-gray700 dark:text-gray-gray200";

function FieldControl({ field, value, onChange }) {
    const desc = field.description || hintFor(field);
    let control;

    if (field.kind === "checkbox") {
        control = (
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={isTruthy(value)}
                    onChange={(e) => onChange(e.target.checked ? "yes" : "no")}
                    className="h-4 w-4 accent-blue-blue"
                />
                <span className="text-sm text-gray-gray600 dark:text-gray-gray300">
                    {isTruthy(value) ? "Yes" : "No"}
                </span>
            </label>
        );
    } else if (field.kind === "select") {
        control = (
            <select
                className={INPUT_CLS}
                value={field.choices && field.choices.includes(value) ? value : ""}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value="">—</option>
                {(field.choices || []).map((c) => (
                    <option key={c} value={c}>
                        {c}
                    </option>
                ))}
            </select>
        );
    } else if (field.kind === "longtext") {
        control = (
            <textarea
                className={INPUT_CLS}
                rows={2}
                value={value}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else if (field.kind === "date") {
        control = (
            <input
                type="date"
                className={INPUT_CLS}
                value={toDateInput(value)}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else if (field.kind === "datetime") {
        control = (
            <input
                type="datetime-local"
                className={INPUT_CLS}
                value={toDateTimeInput(value)}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else {
        control = (
            <input
                type={field.input.type || "text"}
                inputMode={field.input.inputMode}
                className={INPUT_CLS}
                value={value}
                placeholder={field.kind === "multiselect" ? "comma-separated" : undefined}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    }

    return (
        <div>
            <label className="block text-xs font-medium text-gray-gray500 dark:text-gray-gray400 mb-1">
                {field.name}
            </label>
            {control}
            {desc && (
                <p className="text-xs text-gray-gray400 dark:text-gray-gray500 mt-0.5">{desc}</p>
            )}
        </div>
    );
}

function DoneScreen({ submitTable, onReset }) {
    return (
        <Shell>
            <div className="flex items-center gap-2 mb-2">
                <span className="text-green-green text-lg">✓</span>
                <h1 className="font-display font-bold text-xl text-gray-gray700 dark:text-gray-gray100">
                    Submitted
                </h1>
            </div>
            <p className="text-sm text-gray-gray500 dark:text-gray-gray400 mb-4">
                A new record was created in {submitTable ? submitTable.name : "the table"}.
            </p>
            <button
                type="button"
                onClick={onReset}
                className="bg-blue-blue text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 transition"
            >
                Fill out another
            </button>
        </Shell>
    );
}

// --- shell: page background + padding, dark-mode aware ------------------------
function Shell({ children }) {
    // Reading the scheme keeps the component subscribed; dark: classes do the work.
    useColorScheme();
    return (
        <div className="min-h-screen bg-gray-gray50 dark:bg-gray-gray800 p-5 font-sans">
            <div className="max-w-xl mx-auto">{children}</div>
        </div>
    );
}

// --- small helpers -----------------------------------------------------------
function hintFor(f) {
    if (f.kind === "multiselect") return "Choose one or more (comma-separated).";
    return "";
}
const TRUTHY = new Set(["true", "yes", "y", "1", "on", "checked"]);
function isTruthy(v) {
    return TRUTHY.has(String(v || "").trim().toLowerCase());
}
function toDateInput(v) {
    if (!v) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function toDateTimeInput(v) {
    if (!v) return "";
    const d = new Date(v);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
        "T" + p(d.getHours()) + ":" + p(d.getMinutes())
    );
}

initializeBlock({ interface: () => <FormSpeakApp /> });
