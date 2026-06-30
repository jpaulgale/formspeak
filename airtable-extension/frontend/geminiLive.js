// ============================================================================
// GeminiLiveSession — a robust, framework-agnostic wrapper around the Gemini
// Live API for use inside an Airtable custom extension.
//
// It is a faithful port of the audio + WebSocket + tool-dispatch pipeline from
// the standalone FormSpeak web app, generalised so the *form schema* and the
// *tool handling* are injected by the host (here: the Airtable extension). The
// model drives the UI by calling tools; this class only owns the transport,
// the microphone, the noise/echo handling, and the session-cost caps.
//
// SAFETY / ROBUSTNESS NOTES (why this is the "safe" way to use Gemini Live):
//   • No API key ever reaches the browser. start() calls getToken() (an async
//     function the host supplies) which hits a SERVER endpoint that mints a
//     single-use, short-lived *ephemeral token*; the WebSocket then opens
//     directly to Google with that token. The key stays server-side.
//   • Microphone capability is feature-detected up front. In a cross-origin
//     iframe (which is exactly what an Airtable extension is) getUserMedia is
//     blocked unless the embedder delegates `allow="microphone"`. We surface a
//     typed, structured error (`MicUnavailableError`) instead of throwing a raw
//     DOMException, so the host can degrade gracefully to the typed form.
//   • Session-cost caps (idle + hard wall-clock) close the expensive open
//     socket so an abandoned tab can't quietly burn the shared API quota.
//   • Every close code is mapped to a human-actionable message.
// ============================================================================

import {
    CAPTURE_WORKLET,
    PLAYBACK_WORKLET,
    blobURL,
    b64FromBuffer,
    f32FromB64Pcm16,
} from "./worklets";

// Thrown by start() when the runtime cannot grant microphone access — almost
// always because the Airtable extension iframe was not delegated `microphone`
// by the parent page (Permissions-Policy). The host treats this as "voice is
// unavailable here" and falls back to the typed form, rather than an error.
export class MicUnavailableError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = "MicUnavailableError";
        this.cause = cause;
    }
}

// --- tuning constants (ported verbatim from the production web app) ----------
const GATE_HANGOVER_MS = 400; // keep streaming briefly after speech dips
const ECHO_TAIL_MS = 250; // keep suppressing briefly after playback ends
const ECHO_EMA = 0.05; // how fast the echo-level estimate tracks (low = stable)
const ECHO_MARGIN = 3.0; // mic RMS must beat this × echo level to count as barge-in
const BARGE_FRAMES = 3; // sustained above-floor frames before a barge-in forwards
const IDLE_LIMIT_MS = 90 * 1000; // 90s of silence (either side) → pause
const HARD_LIMIT_MS = 10 * 60 * 1000; // 10 min wall-clock → pause no matter what

const GENAI_WS =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

// True only when this context can even ask for a mic. `navigator.mediaDevices`
// is undefined in insecure contexts and when Permissions-Policy fully blocks it.
export function micPlausiblyAvailable() {
    return !!(
        typeof navigator !== "undefined" &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function" &&
        (typeof window === "undefined" || window.isSecureContext !== false)
    );
}

// Map a raw WebSocket close into something a user can act on.
function closeMessage(ev, tap = "Click") {
    const reconnect = " " + tap + " the mic to reconnect.";
    const reason = (ev.reason || "").trim();
    switch (ev.code) {
        case 1008:
            return "The voice session timed out." + reconnect;
        case 1011:
        case 1012:
        case 1013:
            return "The voice service had a hiccup." + reconnect;
        case 1006:
        case 1001:
            return "Lost the connection." + reconnect;
        case 1009:
            return "That was too much audio at once." + reconnect;
        default:
            return (
                "The voice session ended" +
                (reason ? " (" + reason + ")" : "") +
                "." +
                reconnect
            );
    }
}

export class GeminiLiveSession {
    /**
     * @param {object} opts
     * @param {string} opts.model            e.g. "gemini-3.1-flash-live-preview"
     * @param {string} opts.voice            e.g. "Aoede"
     * @param {() => Promise<string>} opts.getToken   resolves an ephemeral token
     * @param {() => {systemInstruction: string, tools: object[]}} opts.buildSetup
     *        Called fresh at every connect so the system instruction + tool enum
     *        reflect the LIVE form schema and any resume context.
     * @param {(name: string, args: object) => Promise<string>} opts.onToolCall
     *        Host applies the tool (set_field / submit_form) and returns the
     *        result string the model reads back. MUST never throw.
     * @param {(phase: "listening"|"thinking"|"speaking") => void} [opts.onPhase]
     * @param {(t: {userBuf: string, asstBuf: string, lastUser: string, lastAsst: string, turnComplete: boolean}) => void} [opts.onTranscript]
     * @param {(rms: number, open: boolean) => void} [opts.onLevel]
     * @param {() => void} [opts.onConnected]
     * @param {(msg: string, ev: CloseEvent) => void} [opts.onClosed] benign closes pass msg="".
     * @param {(err: Error) => void} [opts.onError]
     * @param {(reason: "idle"|"max") => void} [opts.onCapped]
     * @param {string} [opts.tap]            "Tap" | "Click" for messages
     */
    constructor(opts) {
        this.opts = opts;
        this.tap = opts.tap || "Click";
        this.ws = null;
        this.connected = false;
        this.submitted = false;
        this.micOn = false;
        this.phase = "listening";

        this.capCtx = null;
        this.capNode = null;
        this.micStream = null;
        this.playCtx = null;
        this.playNode = null;

        this.userBuf = "";
        this.asstBuf = "";
        this.lastUser = "";
        this.lastAsst = "";

        this.thinkTimer = null;
        this.idleTimer = null;
        this.hardTimer = null;

        // noise gate + echo suppression state
        this.gate = { floor: 0, openUntil: 0, aboveRun: 0 };
        this.playUntil = 0;
        this.echo = { level: 0 };
    }

    // --- lifecycle -----------------------------------------------------------

    async start() {
        if (!micPlausiblyAvailable()) {
            throw new MicUnavailableError(
                "Microphone access isn't available inside this embedded extension. " +
                    "Open FormSpeak in its own browser tab to talk, or fill the form by typing below.",
            );
        }
        const token = await this.opts.getToken();
        await this._connect(token);
        await this._startMic(); // may throw MicUnavailableError on a Permissions-Policy block
        this._armSessionLimits();
    }

    // Toggle the mic without tearing down the socket (pause / resume).
    setMicOn(on) {
        this.micOn = on;
        if (this.micStream)
            this.micStream.getAudioTracks().forEach((t) => (t.enabled = on));
        if (on) {
            this.phase = "listening";
            this._emitPhase();
        } else {
            // PTT-style commit on pause: flush cached audio so the model finalises
            // the turn and replies. Skip while the assistant is mid-utterance.
            if (this.phase !== "speaking") this._sendAudioStreamEnd();
            this._emitLevel(0, false);
            clearTimeout(this.thinkTimer);
        }
    }

    // Fully hand the mic device back (stops tracks + closes capture context).
    releaseMic() {
        if (this.micStream) {
            this.micStream.getTracks().forEach((t) => t.stop());
            this.micStream = null;
        }
        if (this.capCtx) {
            this.capCtx.close().catch(() => {});
            this.capCtx = null;
            this.capNode = null;
        }
        this.micOn = false;
        clearTimeout(this.thinkTimer);
        this._emitLevel(0, false);
    }

    // Graceful, billing-stopping pause (idle / hard cap). Closes 1000 so onClosed
    // sees a benign close; the host shows its own friendly resume prompt.
    endSession(reason) {
        this._clearSessionLimits();
        if (this.submitted || !this.ws) return;
        try {
            this.ws.close(1000, "session_" + reason);
        } catch {}
        this.releaseMic();
        this.opts.onCapped && this.opts.onCapped(reason);
    }

    close() {
        this.submitted = true; // suppress the error banner on an intentional close
        this._clearSessionLimits();
        try {
            this.ws && this.ws.close(1000, "closed");
        } catch {}
        this.releaseMic();
        if (this.playCtx) {
            this.playCtx.close().catch(() => {});
            this.playCtx = null;
            this.playNode = null;
        }
    }

    markSubmitted() {
        this.submitted = true;
        this._clearSessionLimits();
    }

    // Inject a synthetic user turn (e.g. "Use this value: …") so the model
    // acknowledges an out-of-band UI action and moves on.
    sendUserText(text) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN)
            this.ws.send(
                JSON.stringify({
                    clientContent: {
                        turns: [{ role: "user", parts: [{ text }] }],
                        turnComplete: true,
                    },
                }),
            );
    }

    // --- connection ----------------------------------------------------------

    _connect(token) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(GENAI_WS + "?access_token=" + token);
            this.ws = ws;
            ws.onopen = () => {
                const { systemInstruction, tools } = this.opts.buildSetup();
                ws.send(
                    JSON.stringify({
                        setup: {
                            model: "models/" + this.opts.model,
                            generationConfig: {
                                responseModalities: ["AUDIO"],
                                temperature: 0.3,
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: { voiceName: this.opts.voice },
                                    },
                                },
                            },
                            systemInstruction: { parts: [{ text: systemInstruction }] },
                            tools,
                            inputAudioTranscription: {},
                            outputAudioTranscription: {},
                            realtimeInputConfig: {
                                automaticActivityDetection: {
                                    silenceDurationMs: 700,
                                    prefixPaddingMs: 300,
                                    startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                                },
                                turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
                            },
                        },
                    }),
                );
            };
            ws.onmessage = (e) => this._handleServerMessage(e, resolve);
            ws.onerror = () => {
                this.opts.onError &&
                    this.opts.onError(
                        new Error("WebSocket error — check the token endpoint / model id."),
                    );
                reject(new Error("WebSocket error."));
            };
            ws.onclose = (ev) => {
                this.connected = false;
                const benign =
                    this.submitted || ev.code === 1000 || ev.code === 1005;
                const msg = benign ? "" : closeMessage(ev, this.tap);
                this.opts.onClosed && this.opts.onClosed(msg, ev);
            };
        });
    }

    async _handleServerMessage(e, onSetup) {
        const text = e.data instanceof Blob ? await e.data.text() : e.data;
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }

        if (msg.setupComplete) {
            this.connected = true;
            this.opts.onConnected && this.opts.onConnected();
            // The Live API never speaks first — nudge it with a neutral opening turn
            // so it greets (or, on a reconnect, delivers the resume "welcome back").
            if (this.ws && this.ws.readyState === WebSocket.OPEN)
                this.ws.send(
                    JSON.stringify({
                        clientContent: {
                            turns: [{ role: "user", parts: [{ text: "Hi" }] }],
                            turnComplete: true,
                        },
                    }),
                );
            onSetup && onSetup();
            return;
        }

        if (msg.toolCall) {
            const calls = msg.toolCall.functionCalls || [];
            const responses = [];
            for (const c of calls) {
                let result = "ok";
                try {
                    result = await this.opts.onToolCall(c.name, c.args || {});
                } catch (err) {
                    result = "The tool failed: " + String(err && err.message);
                }
                responses.push({ id: c.id, name: c.name, response: { result } });
            }
            if (this.ws && this.ws.readyState === WebSocket.OPEN)
                this.ws.send(
                    JSON.stringify({ toolResponse: { functionResponses: responses } }),
                );
            return;
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.modelTurn && sc.modelTurn.parts) {
            for (const p of sc.modelTurn.parts) {
                if (p.inlineData && p.inlineData.data) {
                    this._setPhase("speaking");
                    this._playAudio(p.inlineData.data);
                }
            }
        }
        if (sc.inputTranscription && sc.inputTranscription.text) {
            this.userBuf += sc.inputTranscription.text;
            this._emitTranscript(false);
            this._setPhase("listening");
            this._scheduleThinking();
            this._bumpIdle();
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
            this.asstBuf += sc.outputTranscription.text;
            this._emitTranscript(false);
            this._setPhase("speaking");
            this._bumpIdle();
        }
        if (sc.interrupted) {
            this._stopPlayback();
            this._setPhase("listening");
        }
        if (sc.turnComplete) {
            const u = this.userBuf.trim();
            const a = this.asstBuf.trim();
            if (u) this.lastUser = u;
            if (a) this.lastAsst = a;
            this.userBuf = "";
            this.asstBuf = "";
            this._emitTranscript(true);
            this._setPhase("listening");
        }
    }

    // --- audio capture (16 kHz PCM16) ---------------------------------------

    async _startMic() {
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
        } catch (err) {
            // NotAllowedError here is overwhelmingly the iframe Permissions-Policy
            // block (no mic delegated to the extension), not a user denial we can
            // recover from with a retry. Surface it as the typed error.
            throw new MicUnavailableError(
                "Couldn't open the microphone in this embedded extension. " +
                    "Open FormSpeak in its own browser tab to use voice, or type your answers below.",
                err,
            );
        }
        this.capCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
        });
        await this.capCtx.audioWorklet.addModule(blobURL(CAPTURE_WORKLET));
        this.capNode = new AudioWorkletNode(this.capCtx, "cap");
        this.capNode.port.onmessage = (e) => this._onCaptureFrame(e.data);
        this.capCtx.createMediaStreamSource(this.micStream).connect(this.capNode);
        this.micOn = true;
        this.phase = "listening";
        this._emitPhase();
    }

    _onCaptureFrame(f32) {
        if (!this.micOn) return;
        let sum = 0;
        for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
        const rms = Math.sqrt(sum / f32.length);

        const g = this.gate;
        const now = performance.now();

        // echo floor: while our own playback is emitting (plus a short tail) learn
        // the speaker→mic bleed and require input to beat it, so the model doesn't
        // hear itself and barge in on its own reply. With headphones bleed ≈ 0.
        const ec = this.echo;
        const echoing = now < this.playUntil + ECHO_TAIL_MS;
        if (echoing) {
            if (ec.level <= 0) ec.level = rms;
            else if (rms < ec.level * ECHO_MARGIN)
                ec.level += ECHO_EMA * (rms - ec.level);
        } else {
            ec.level = 0;
        }
        const echoFloor = echoing ? ec.level * ECHO_MARGIN : 0;

        const floor = Math.max(g.floor, echoFloor);
        const above = floor <= 0 || rms > floor;
        if (above) g.openUntil = now + GATE_HANGOVER_MS;
        g.aboveRun = above ? g.aboveRun + 1 : 0;
        const open = now < g.openUntil;
        this._emitLevel(rms, open);

        if (!open) return; // gate closed → ignore background noise / our own echo
        // While speaking, only a SUSTAINED barge-in (BARGE_FRAMES) forwards, so a
        // lone echo/noise spike can't crush the reply.
        if (this.phase === "speaking" && g.aboveRun < BARGE_FRAMES) return;

        const pcm = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            pcm[i] = s * 0x7fff;
        }
        this._sendAudio(b64FromBuffer(pcm.buffer));
    }

    _sendAudio(base64) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN)
            this.ws.send(
                JSON.stringify({
                    realtimeInput: {
                        audio: { mimeType: "audio/pcm;rate=16000", data: base64 },
                    },
                }),
            );
    }

    _sendAudioStreamEnd() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN)
            this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }

    // --- audio playback (24 kHz) --------------------------------------------

    async _playAudio(base64) {
        if (!this.playCtx) {
            this.playCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 24000,
            });
            await this.playCtx.audioWorklet.addModule(blobURL(PLAYBACK_WORKLET));
            this.playNode = new AudioWorkletNode(this.playCtx, "play");
            this.playNode.connect(this.playCtx.destination);
        }
        if (this.playCtx.state === "suspended") await this.playCtx.resume();
        const f32 = f32FromB64Pcm16(base64);
        this.playNode.port.postMessage(f32);
        const durMs = (f32.length / 24000) * 1000;
        this.playUntil = Math.max(this.playUntil, performance.now()) + durMs;
    }

    _stopPlayback() {
        if (this.playNode) this.playNode.port.postMessage("stop");
        this.playUntil = 0;
    }

    // --- phase machine + session caps ---------------------------------------

    _setPhase(p) {
        if (p === "listening") clearTimeout(this.thinkTimer);
        if (this.phase === p) return;
        this.phase = p;
        this._emitPhase();
    }
    _scheduleThinking() {
        clearTimeout(this.thinkTimer);
        this.thinkTimer = setTimeout(() => {
            if (this.micOn && this.phase === "listening") this._setPhase("thinking");
        }, 650);
    }
    _bumpIdle() {
        clearTimeout(this.idleTimer);
        if (this.submitted) return;
        this.idleTimer = setTimeout(() => this.endSession("idle"), IDLE_LIMIT_MS);
    }
    _armSessionLimits() {
        clearTimeout(this.hardTimer);
        this.hardTimer = setTimeout(() => this.endSession("max"), HARD_LIMIT_MS);
        this._bumpIdle();
    }
    _clearSessionLimits() {
        clearTimeout(this.idleTimer);
        clearTimeout(this.hardTimer);
    }

    // --- emitters ------------------------------------------------------------

    _emitPhase() {
        this.opts.onPhase && this.opts.onPhase(this.phase);
    }
    _emitLevel(rms, open) {
        this.opts.onLevel && this.opts.onLevel(rms, open);
    }
    _emitTranscript(turnComplete) {
        this.opts.onTranscript &&
            this.opts.onTranscript({
                userBuf: this.userBuf,
                asstBuf: this.asstBuf,
                lastUser: this.lastUser,
                lastAsst: this.lastAsst,
                turnComplete,
            });
    }
}
