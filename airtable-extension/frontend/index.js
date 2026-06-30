// ============================================================================
// FormSpeak for Airtable — entry point.
//
// Reads a view's fields (in view order), renders them as a form you can fill by
// TYPING or by TALKING (Gemini Live), and on submit creates a record in the
// submission table. The schema and the current user's name are injected into
// the Gemini context dynamically at connect time (see geminiContext.js).
//
// Airtable Blocks SDK conventions honoured here:
//   • Exactly one initializeBlock(() => <App/>) call is the whole entry point.
//   • Everything reactive comes from hooks (useBase, useSession, useGlobalConfig,
//     useViewMetadata, useSettingsButton) — never poll, never reach outside React.
//   • useViewMetadata(view).visibleFields IS the schema call, already ordered.
//   • Writes go through createRecordAsync after a hasPermissionToCreateRecord
//     check, with cell values shaped per field type (see schema.js).
//   • The extension runs in a sandboxed cross-origin iframe, so the microphone
//     may be unavailable; voice is a progressive enhancement and the typed form
//     always works.
// ============================================================================

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
    initializeBlock,
    useBase,
    useSession,
    useSettingsButton,
    useViewMetadata,
    Box,
    Button,
    Heading,
    Text,
    Input,
    Select,
    Switch,
    FormField,
    Loader,
    Icon,
} from "@airtable/blocks/ui";

import { Settings, useSettings } from "./settings";
import { buildSchema, describeField, coerceCellValue } from "./schema";
import { buildSystemInstruction, buildTools } from "./geminiContext";
import { useGeminiLive } from "./useGeminiLive";

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Aoede";

function FormSpeakApp() {
    const [showSettings, setShowSettings] = useState(false);
    useSettingsButton(() => setShowSettings((v) => !v));

    const settings = useSettings();

    if (showSettings || !settings.isConfigured) {
        return (
            <Box>
                {!settings.isConfigured && (
                    <Box padding={3} paddingBottom={0}>
                        <Text textColor="light">
                            Pick the view whose fields should become the form, then a place
                            to submit records.
                        </Text>
                    </Box>
                )}
                <Settings />
                {settings.isConfigured && (
                    <Box padding={3} paddingTop={0}>
                        <Button onClick={() => setShowSettings(false)} variant="primary">
                            Done
                        </Button>
                    </Box>
                )}
            </Box>
        );
    }

    return (
        <FormRunner
            sourceView={settings.sourceView}
            submitTable={settings.submitTable}
            tokenEndpoint={settings.tokenEndpoint}
        />
    );
}

function FormRunner({ sourceView, submitTable, tokenEndpoint }) {
    const base = useBase();
    const session = useSession();
    const userName =
        (session.currentUser && session.currentUser.name) || "";

    // THE schema call: visible fields, already in view order.
    const viewMetadata = useViewMetadata(sourceView);
    const visibleFields = (viewMetadata && viewMetadata.visibleFields) || [];
    const { fields, skipped } = useMemo(
        () => buildSchema(visibleFields),
        // visibleFields identity changes when the view's field set/order changes.
        [visibleFields],
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

    // doSubmit needs to be referenced by onToolCall, which is built before it in
    // source order; a ref breaks the cycle without stale-closure risk.
    const doSubmitRef = useRef(null);

    const onToolCall = useCallback(
        async (name, args) => {
            if (name === "set_field") {
                const slug = args.field;
                const f = fieldsRef.current.find((x) => x.slug === slug);
                if (!f) return "Unknown field '" + slug + "'.";
                if (typeof args.value !== "string") return "ok";
                setValue(slug, args.value);
                // Validate against the field's write rules so the model can self-correct.
                const c = coerceCellValue(f, args.value);
                if (!c.ok)
                    return (
                        '"' + f.name + '" not accepted (' + c.reason + "). Ask the user to clarify."
                    );
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
            const sourceTable = sourceView.parentTable;
            const sameTable = submitTable.id === sourceTable.id;
            const writeFields = {};
            for (const f of fieldsRef.current) {
                const raw = valuesRef.current[f.slug];
                if (!raw || !String(raw).trim()) continue;
                const target = sameTable
                    ? submitTable.getFieldByIdIfExists(f.id)
                    : submitTable.getFieldByNameIfExists(f.name);
                if (!target || target.isComputed) continue;
                const tDesc = describeField(target);
                if (!tDesc || !tDesc.supported) continue;
                const c = coerceCellValue(tDesc, raw);
                if (c.ok) writeFields[target.id] = c.value;
            }
            if (!Object.keys(writeFields).length)
                throw new Error("Nothing to submit yet — fill in at least one field.");
            if (!submitTable.hasPermissionToCreateRecord(writeFields))
                throw new Error(
                    "You don't have permission to create a record in " +
                        submitTable.name +
                        ".",
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
    }, [sourceView, submitTable, gemini]);
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

    const filledCount = fields.filter(
        (f) => (values[f.slug] || "").trim(),
    ).length;

    return (
        <Box padding={3} display="flex" flexDirection="column" style={{ gap: 12 }}>
            <Box>
                <Heading size="small" marginBottom={1}>
                    {userName ? `Hi ${userName.split(" ")[0]} — ` : ""}fill{" "}
                    {submitTable ? submitTable.name : "the form"} by voice or typing
                </Heading>
                <Text textColor="light" size="small">
                    {filledCount} of {fields.length} field
                    {fields.length === 1 ? "" : "s"} filled.
                </Text>
            </Box>

            <VoicePanel gemini={gemini} tokenEndpoint={tokenEndpoint} />

            <Box display="flex" flexDirection="column" style={{ gap: 10 }}>
                {fields.map((f) => (
                    <FieldControl
                        key={f.slug}
                        field={f}
                        value={values[f.slug] || ""}
                        onChange={(val) => setValue(f.slug, val)}
                    />
                ))}
            </Box>

            {skipped.length > 0 && (
                <Text size="small" textColor="light">
                    Not shown ({skipped.length}):{" "}
                    {skipped.map((s) => `${s.name} (${s.why})`).join(", ")}.
                </Text>
            )}

            {submitError && (
                <Box
                    padding={2}
                    backgroundColor="redLight2"
                    borderRadius="default"
                >
                    <Text textColor="red">{submitError}</Text>
                </Box>
            )}

            <Button
                variant="primary"
                size="large"
                disabled={submitting || !filledCount}
                onClick={doSubmit}
                icon={submitting ? undefined : "check"}
            >
                {submitting ? "Submitting…" : "Submit"}
            </Button>
        </Box>
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
            <Box padding={2} backgroundColor="grayLight2" borderRadius="default">
                <Text size="small">
                    <Icon name="microphone" size={14} /> Voice isn't available inside the
                    embedded extension (Airtable's frame blocks microphone access). Type
                    your answers below
                    {standaloneOrigin ? (
                        <>
                            {" "}
                            — or{" "}
                            <a
                                href={standaloneOrigin}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                open FormSpeak in its own tab
                            </a>{" "}
                            to talk.
                        </>
                    ) : (
                        " to fill the form."
                    )}
                </Text>
            </Box>
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
        <Box
            padding={2}
            backgroundColor="grayLight2"
            borderRadius="default"
            display="flex"
            flexDirection="column"
            style={{ gap: 8 }}
        >
            <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                <Button
                    onClick={gemini.toggleMic}
                    disabled={gemini.connecting}
                    icon={gemini.micActive ? "pause" : "microphone"}
                    variant={gemini.micActive ? "default" : "primary"}
                >
                    {gemini.connecting
                        ? "Connecting…"
                        : gemini.micActive
                          ? "Pause"
                          : gemini.connected
                            ? "Resume"
                            : "Talk to fill"}
                </Button>
                {gemini.connecting && <Loader scale={0.3} />}
                <Text size="small" textColor="light">
                    {phaseLabel}
                </Text>
            </Box>

            {(gemini.transcript.user || gemini.transcript.asst) && (
                <Box>
                    {gemini.transcript.user && (
                        <Text size="small">
                            <strong>You:</strong> {gemini.transcript.user}
                        </Text>
                    )}
                    {gemini.transcript.asst && (
                        <Text size="small" textColor="light">
                            <strong>FormSpeak:</strong> {gemini.transcript.asst}
                        </Text>
                    )}
                </Box>
            )}

            {gemini.notice && (
                <Text size="small" textColor="light">
                    {gemini.notice}
                </Text>
            )}
            {gemini.error && (
                <Text size="small" textColor="red">
                    {gemini.error}
                </Text>
            )}
        </Box>
    );
}

// --- a single schema-driven form control -------------------------------------
function FieldControl({ field, value, onChange }) {
    const desc = field.description || hintFor(field);

    let control;
    if (field.kind === "checkbox") {
        control = (
            <Switch
                value={isTruthy(value)}
                onChange={(v) => onChange(v ? "yes" : "no")}
                label={isTruthy(value) ? "Yes" : "No"}
            />
        );
    } else if (field.kind === "select") {
        const options = [
            { value: "", label: "—" },
            ...(field.choices || []).map((c) => ({ value: c, label: c })),
        ];
        control = (
            <Select
                options={options}
                value={field.choices && field.choices.includes(value) ? value : ""}
                onChange={(v) => onChange(v || "")}
            />
        );
    } else if (field.kind === "date") {
        control = (
            <Input
                type="date"
                value={toDateInput(value)}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else if (field.kind === "datetime") {
        control = (
            <Input
                type="datetime-local"
                value={toDateTimeInput(value)}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else {
        control = (
            <Input
                type={field.input.type || "text"}
                inputMode={field.input.inputMode}
                value={value}
                placeholder={
                    field.kind === "multiselect" ? "comma-separated" : undefined
                }
                onChange={(e) => onChange(e.target.value)}
            />
        );
    }

    return (
        <FormField label={field.name} description={desc}>
            {control}
        </FormField>
    );
}

function DoneScreen({ submitTable, onReset }) {
    return (
        <Box padding={3} display="flex" flexDirection="column" style={{ gap: 12 }}>
            <Box display="flex" alignItems="center" style={{ gap: 8 }}>
                <Icon name="check" size={20} fillColor="green" />
                <Heading size="small">Submitted</Heading>
            </Box>
            <Text textColor="light">
                A new record was created in {submitTable ? submitTable.name : "the table"}
                .
            </Text>
            <Button onClick={onReset} icon="plus" variant="primary">
                Fill out another
            </Button>
        </Box>
    );
}

// --- small helpers -----------------------------------------------------------
function hintFor(f) {
    if (f.kind === "multiselect") return "Choose one or more (comma-separated).";
    if (f.kind === "select" && f.choices && f.choices.length)
        return "Choose one.";
    return "";
}
const TRUTHY = new Set(["true", "yes", "y", "1", "on", "checked"]);
function isTruthy(v) {
    return TRUTHY.has(String(v || "").trim().toLowerCase());
}
// "March 3, 1990" → "1990-03-03" for <input type=date>; pass ISO through.
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
        d.getFullYear() +
        "-" +
        p(d.getMonth() + 1) +
        "-" +
        p(d.getDate()) +
        "T" +
        p(d.getHours()) +
        ":" +
        p(d.getMinutes())
    );
}

initializeBlock(() => <FormSpeakApp />);
