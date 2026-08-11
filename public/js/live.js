// The Gemini Live session: ephemeral-token fetch, the WebSocket itself, the
// server-message loop, and the session cost caps that stop an abandoned tab
// from holding an expensive realtime connection open.

import { MODEL, VOICE, TAP, FIELDS } from "./config.js";
import { SYSTEM_INSTRUCTION, TOOLS } from "./prompt.js";
import { state } from "./state.js";
import { $, escapeHTML, announce } from "./dom.js";
import { logEvent } from "./telemetry.js";
import { isFilled, activeIndex, fieldsSnapshot } from "./form-state.js";
import { denoiseTranscript } from "./validators.js";
import { playAudio, stopPlayback, releaseMic } from "./audio.js";
import { setPhase, scheduleThinking } from "./status.js";
import { renderCaption } from "./card.js";
import { dispatchTool } from "./tools.js";

export async function getToken() {
  const r = await fetch("/api/token", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  // Prefer the server's message (e.g. the rate-limit notice) over a bare status code.
  if (!r.ok) throw new Error(j.error || ("token request failed (" + r.status + ")"));
  if (j.error) throw new Error(j.error);
  return j.token;
}

// When a session reconnects (e.g. the mic was paused long enough for the live
// WebSocket to close), the new session has NO memory of the previous one — so by
// default the model would greet and ask for the first field again, even though the
// already-filled values are still on screen. This builds a short preamble that tells
// the fresh session what's already captured and where to pick up, so it resumes at the
// first UNFILLED field instead of starting over. Returns "" for a genuinely fresh start.
function resumeContext() {
  const filled = FIELDS.filter(isFilled);
  if (!filled.length) return ""; // nothing captured yet → normal greeting + field one
  const lines = filled.map((f) => "- " + f.label + ": " + state.values[f.key]).join("\n");
  const ai = activeIndex();
  if (ai === -1) {
    // Everything is filled → resume straight into the final review/confirm step.
    return "\n\n--- RESUMING AN IN-PROGRESS SESSION ---\n" +
      "The user already filled in EVERY field in an earlier session and the values are still on screen:\n" +
      lines +
      "\nDo NOT greet them as if starting fresh and do NOT re-ask any field. In one short sentence, " +
      "welcome them back, then read back all the values and ask \"Is everything correct?\" so you can submit.";
  }
  const next = FIELDS[ai];
  return "\n\n--- RESUMING AN IN-PROGRESS SESSION ---\n" +
    "The user already filled in these fields in an earlier session and the values are still on screen — " +
    "treat them as already captured and confirmed unless the user asks to change one:\n" +
    lines +
    "\nDo NOT greet them as if starting fresh and do NOT re-ask any of the fields above. In one short sentence, " +
    "welcome them back, then pick up exactly where they left off by asking for the next field: " +
    next.label + " (\"" + next.q + "\").";
}

// Turn a raw WebSocket close into something a user can act on. The Gemini Live
// API closes with a numeric code (and sometimes a reason string) that means
// nothing to a person — "Connection closed (1008)." doesn't tell you it's
// usually a recoverable token/session timeout. Map the common ones and always
// say how to get going again.
function closeMessage(ev) {
  const reconnect = " " + TAP + " the mic to reconnect.";
  const reason = (ev.reason || "").trim();
  switch (ev.code) {
    case 1008: // policy violation — token expired/invalid, quota, or session limit
      return "The voice session timed out." + reconnect;
    case 1011: // server-side error
    case 1012: // service restarting
    case 1013: // try again later
      return "The voice service had a hiccup." + reconnect;
    case 1006: // abnormal (no close frame) — network drop
    case 1001: // going away
      return "Lost the connection." + reconnect;
    case 1009: // message too big
      return "That was too much audio at once." + reconnect;
    default:
      // Unknown code: still be friendly, but surface the reason if Google gave one.
      return "The voice session ended" + (reason ? " (" + reason + ")" : "") + "." + reconnect;
  }
}

function setConn(live) {
  state.connected = live; // connection indicator removed from the top; state still drives the mic flow
}

export function connect(token) {
  return new Promise((resolve, reject) => {
    const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=" + token;
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: "models/" + MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            temperature: 0.3,
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + resumeContext() }] },
          tools: TOOLS,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              silenceDurationMs: 700,
              prefixPaddingMs: 300,
              startOfSpeechSensitivity: "START_SENSITIVITY_LOW", // ignore faint onsets / background
            },
            turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
          },
        },
      }));
    };
    ws.onmessage = (e) => handleServerMessage(e, resolve);
    ws.onerror = () => { logEvent("ws_error", {}); reject(new Error("WebSocket error — check the API key / model id.")); };
    ws.onclose = (ev) => {
      setConn(false);
      // 1000 = normal, 1005 = no status (we closed it) → not errors worth showing.
      const benign = state.submitted || ev.code === 1000 || ev.code === 1005;
      const msg = benign ? "" : closeMessage(ev);
      // Log every close — the code/reason is the clearest signal of where the
      // voice session broke for someone who never finished.
      logEvent("ws_close", {
        code: ev.code, reason: ev.reason || "", wasClean: ev.wasClean,
        shown: msg, submitted: !!state.submitted, snapshot: fieldsSnapshot(),
      });
      if (benign) return;
      $("caption").innerHTML = '<span class="err">' + escapeHTML(msg) + "</span>";
      announce(msg);
    };
  });
}

async function handleServerMessage(e, onSetup) {
  const text = e.data instanceof Blob ? await e.data.text() : e.data;
  let msg; try { msg = JSON.parse(text); } catch { return; }

  if (msg.setupComplete) {
    setConn(true);
    logEvent("ws_ready", {});
    // The Live API never speaks first — it only responds to a turn of input. Send a
    // neutral opening turn so the model delivers its greeting (or, on a reconnect, the
    // "welcome back" line from resumeContext()) instead of sitting silently on the
    // VAD waiting for the user to talk first. Fires on every session open.
    if (state.ws && state.ws.readyState === WebSocket.OPEN)
      state.ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Hi" }] }],
          turnComplete: true,
        },
      }));
    onSetup && onSetup();
    return;
  }

  if (msg.toolCall) {
    const calls = msg.toolCall.functionCalls || [];
    const responses = [];
    for (const c of calls) {
      const result = await dispatchTool(c.name, c.args || {});
      // The args + the result string ("confirmed" / "not confirmed" / the list of
      // blocking problems / "submitted") are the richest diagnostic we have for
      // where a session stalls — capture both verbatim.
      logEvent("tool_call", { name: c.name, args: c.args || {}, result });
      responses.push({ id: c.id, name: c.name, response: { result } });
    }
    state.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.modelTurn && sc.modelTurn.parts) {
    for (const p of sc.modelTurn.parts) {
      if (p.inlineData && p.inlineData.data) { setPhase("speaking"); playAudio(p.inlineData.data); }
    }
  }
  if (sc.inputTranscription && sc.inputTranscription.text) {
    state.userBuf += sc.inputTranscription.text; renderCaption();
    // user is talking → back to listening, then arm the "thinking" timer for the pause after
    setPhase("listening"); scheduleThinking(); bumpIdle();
  }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    state.asstBuf += sc.outputTranscription.text; renderCaption();
    setPhase("speaking"); bumpIdle();
  }
  if (sc.interrupted) { stopPlayback(); setPhase("listening"); }
  if (sc.turnComplete) {
    const u = denoiseTranscript(state.userBuf).trim(), a = denoiseTranscript(state.asstBuf).trim();
    if (u) state.lastUser = u;
    if (a) state.lastAsst = a;
    if (u || a) logEvent("turn", { user: u, asst: a });
    state.userBuf = ""; state.asstBuf = ""; renderCaption();
    setPhase("listening");
  }
}

/* ------------------------------------------------------------------
   Session cost caps. The open Gemini Live WebSocket is the expensive
   thing, so an abandoned tab shouldn't be able to hold one open and
   quietly burn the API budget. IDLE closes after a stretch of no
   conversation (user walked away); HARD is an absolute backstop for a
   session that stays active far longer than any real form takes. Either
   close is graceful: the mic re-arms and a tap resumes (answers are
   kept, and resumeContext() re-greets the user where they left off).
   ------------------------------------------------------------------ */
const IDLE_LIMIT_MS = 90 * 1000;     // 90s of no speech (either side) → pause
const HARD_LIMIT_MS = 10 * 60 * 1000; // 10 min wall-clock → pause no matter what

// bumpIdle() resets the silence timer on any conversational activity (user OR
// assistant speech); armSessionLimits() starts both timers when a session opens.
function bumpIdle() {
  clearTimeout(state.idleTimer);
  if (state.submitted) return;
  state.idleTimer = setTimeout(() => endSession("idle"), IDLE_LIMIT_MS);
}
export function armSessionLimits() {
  clearTimeout(state.hardTimer);
  state.hardTimer = setTimeout(() => endSession("max"), HARD_LIMIT_MS);
  bumpIdle();
}
export function clearSessionLimits() {
  clearTimeout(state.idleTimer); clearTimeout(state.hardTimer);
}
// Gracefully pause an active session to stop it billing. Closes with 1000 so the
// ws.onclose handler treats it as benign (no scary error banner); we show our own
// friendly resume prompt instead. Tapping the mic runs begin() again, which mints
// a fresh token and reconnects with the user's answers carried over.
function endSession(reason) {
  clearSessionLimits();
  if (state.submitted || !state.ws) return;
  logEvent("session_capped", { reason, snapshot: fieldsSnapshot() });
  try { state.ws.close(1000, "session_" + reason); } catch {}
  const msg = reason === "max"
    ? "Paused after 10 minutes to keep this free demo's costs down. " + TAP + " the mic to continue — your answers are saved."
    : "Paused after a stretch of quiet to save resources. " + TAP + " the mic to continue — your answers are saved.";
  // Surface the reason in the paused mic label itself (renderStatus reads pauseMsg),
  // not as a separate caption line below it — one paused message, in one place. Set it
  // before releaseMic() so its renderStatus() paints the full message in a single pass.
  state.pauseMsg = msg;
  releaseMic();
  announce(msg);
}
