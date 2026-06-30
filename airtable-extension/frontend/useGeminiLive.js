// ============================================================================
// useGeminiLive — React glue around GeminiLiveSession.
//
// The Blocks SDK bundles React 16, so this is a normal hook. The tricky part is
// that the session lives across renders while the form schema + values change
// every render; we keep the latest of those in refs and read them inside the
// session callbacks, so buildSetup() and onToolCall() never close over stale
// state. The session itself is created lazily on the first start().
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
    GeminiLiveSession,
    MicUnavailableError,
    micPlausiblyAvailable,
} from "./geminiLive";

export function useGeminiLive({
    model,
    voice,
    getToken,
    buildSetup, // () => ({systemInstruction, tools}) — reads live schema/values
    onToolCall, // (name, args) => Promise<string>
}) {
    const [phase, setPhase] = useState("listening");
    const [micActive, setMicActive] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState(""); // benign close / cap message
    // Set once the runtime actually refuses the mic (the iframe Permissions-Policy
    // block surfaces here, not in the upfront capability check, because
    // navigator.mediaDevices is still defined in a secure iframe).
    const [voiceUnavailable, setVoiceUnavailable] = useState(false);
    const [transcript, setTranscript] = useState({ user: "", asst: "" });
    const [level, setLevel] = useState({ rms: 0, open: false });
    const micCapable = micPlausiblyAvailable();

    const sessionRef = useRef(null);
    // Latest callbacks/state, read inside session callbacks to dodge staleness.
    const buildSetupRef = useRef(buildSetup);
    const onToolCallRef = useRef(onToolCall);
    const getTokenRef = useRef(getToken);
    useEffect(() => {
        buildSetupRef.current = buildSetup;
        onToolCallRef.current = onToolCall;
        getTokenRef.current = getToken;
    });

    const ensureSession = useCallback(() => {
        if (sessionRef.current) return sessionRef.current;
        const s = new GeminiLiveSession({
            model,
            voice,
            tap: "Click",
            getToken: () => getTokenRef.current(),
            buildSetup: () => buildSetupRef.current(),
            onToolCall: (name, args) => onToolCallRef.current(name, args),
            onConnected: () => {
                setConnected(true);
                setNotice("");
            },
            onClosed: (msg) => {
                setConnected(false);
                setMicActive(false);
                if (msg) setNotice(msg);
            },
            onCapped: (reason) => {
                setMicActive(false);
                setNotice(
                    reason === "max"
                        ? "Paused after 10 minutes to keep costs down. Click the mic to continue — your answers are saved."
                        : "Paused after a stretch of quiet. Click the mic to continue — your answers are saved.",
                );
            },
            onError: (err) => setError(String((err && err.message) || err)),
            onPhase: (p) => setPhase(p),
            onLevel: (rms, open) => setLevel({ rms, open }),
            onTranscript: (t) =>
                setTranscript({
                    user: (t.userBuf || t.lastUser || "").trim(),
                    asst: (t.asstBuf || t.lastAsst || "").trim(),
                }),
        });
        sessionRef.current = s;
        return s;
    }, [model, voice]);

    const start = useCallback(async () => {
        setError("");
        setNotice("");
        setConnecting(true);
        try {
            const s = ensureSession();
            await s.start();
            setMicActive(true);
        } catch (err) {
            if (err instanceof MicUnavailableError) {
                setError(err.message);
                setVoiceUnavailable(true); // flip the panel to the typed/popout fallback
            } else {
                setError(String((err && err.message) || err));
            }
            setMicActive(false);
        } finally {
            setConnecting(false);
        }
    }, [ensureSession]);

    const toggleMic = useCallback(() => {
        const s = sessionRef.current;
        if (!s) return start();
        if (s.connected) {
            if (!s.micOn && !s.micStream) {
                s._startMic()
                    .then(() => setMicActive(true))
                    .catch((err) => setError(String((err && err.message) || err)));
            } else {
                const next = !s.micOn;
                s.setMicOn(next);
                setMicActive(next);
            }
        } else {
            start();
        }
    }, [start]);

    // Tell the model about an out-of-band UI edit (e.g. the user typed/picked).
    const sendUserText = useCallback((text) => {
        sessionRef.current && sessionRef.current.sendUserText(text);
    }, []);

    const markSubmitted = useCallback(() => {
        sessionRef.current && sessionRef.current.markSubmitted();
    }, []);

    // Tear the session down on unmount so a closed extension never holds the mic
    // or an open billable socket.
    useEffect(() => {
        return () => {
            if (sessionRef.current) {
                sessionRef.current.close();
                sessionRef.current = null;
            }
        };
    }, []);

    return {
        phase,
        micActive,
        connecting,
        connected,
        micCapable,
        voiceUnavailable,
        error,
        notice,
        transcript,
        level,
        start,
        toggleMic,
        sendUserText,
        markSubmitted,
        clearError: () => setError(""),
    };
}
