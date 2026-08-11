#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "google-genai>=1.0",
#     "aiohttp>=3.9",
# ]
# ///
"""FormSpeak backend eval — BASELINE runner (Gemini Live, the shipped setup).

Drives the exact session the browser would: same model, system instruction
(extracted from public/js/prompt.js), tools, VAD config, and client-side tool responses
(via formspeak_env.VirtualForm + the real /api/geosearch on serve.py). Streams
the TTS corpus clips at real-time pace, records every tool call + transcript +
latency, and writes one JSON result per scenario.

Telemetry: each run logs to D1 through serve.py's /api/log with a `test-`
session-id prefix, so it lands flagged as is_test=1 and stays out of prod views.

    uv run serve.py                       # in another terminal (or we spawn it)
    uv run tests/run_baseline.py                    # all scenarios
    uv run tests/run_baseline.py --scenario happy_path
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

import aiohttp
from google import genai
from google.genai import types

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from formspeak_env import (
    SERVE_BASE,
    TEST_SESSION_PREFIX,
    VirtualForm,
    resume_context,
    system_instruction,
    tool_declarations,
)
from scenarios import SCENARIOS

from serve import load_api_key

BACKEND = "gemini-live"
MODEL = "gemini-3.1-flash-live-preview"  # keep in lockstep with public/js/config.js
VOICE = "Aoede"
RATE = 16_000
CHUNK_MS = 128  # realtime pacing chunk
TURN_TIMEOUT_S = 60
RESULTS_DIR = HERE / "results" / BACKEND
AUDIO_DIR = HERE / "audio"


def read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1, path
        return w.readframes(w.getnframes())


async def ensure_serve(http: aiohttp.ClientSession):
    """serve.py must be up (geosearch + telemetry). Spawn it if it isn't."""
    try:
        async with http.get(SERVE_BASE + "/", timeout=aiohttp.ClientTimeout(total=2)):
            return None
    except Exception:
        pass
    print("⏳ serve.py not running — spawning it…")
    proc = await asyncio.create_subprocess_exec(
        "uv",
        "run",
        str(HERE.parent / "serve.py"),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    for _ in range(30):
        await asyncio.sleep(0.5)
        try:
            async with http.get(SERVE_BASE + "/", timeout=aiohttp.ClientTimeout(total=2)):
                return proc
        except Exception:
            continue
    proc.terminate()
    raise RuntimeError("could not start serve.py")


class TurnRecorder:
    """Collects everything that happens between end-of-user-audio and turn end."""

    def __init__(self):
        self.user_text = ""
        self.asst_text = ""
        self.tool_calls: list[dict] = []
        self.audio_bytes = 0
        self.t_end_audio = 0.0
        self.t_first_tool: float | None = None
        self.t_first_audio: float | None = None

    def snapshot(self, say: str) -> dict:
        ms = lambda t: round((t - self.t_end_audio) * 1000) if t else None
        for c in self.tool_calls:
            if "t_abs" in c:
                c["t_ms"] = ms(c.pop("t_abs"))
        return {
            "say": say,
            "heard": self.user_text.strip(),
            "assistant": self.asst_text.strip(),
            "tool_calls": self.tool_calls,
            "audio_out_s": round(self.audio_bytes / 2 / 24_000, 2),  # model speaks 24 kHz
            "ttft_tool_ms": ms(self.t_first_tool),
            "ttfa_ms": ms(self.t_first_audio),
        }


class SessionReader:
    """Persistent message pump — mirrors the browser's single global handler.

    Tool calls are answered IMMEDIATELY whenever they arrive (even straggling
    ones after a turn boundary — leaving one unanswered aborts the session),
    and transcripts/audio are attributed to whichever TurnRecorder is active.
    `turn_done` fires when a receive pass ends with no tool response sent in it
    (i.e. the model finished reacting, including post-tool follow-up speech).
    """

    def __init__(self, session, form: VirtualForm):
        self.session = session
        self.form = form
        self.rec = TurnRecorder()  # active recorder (swapped per turn)
        self.turn_done = asyncio.Event()
        self.task: asyncio.Task | None = None

    def start(self):
        self.task = asyncio.create_task(self._pump())

    async def stop(self):
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass

    async def next_turn(self, rec: TurnRecorder):
        self.rec = rec
        self.turn_done.clear()

    async def wait_turn(self, timeout: float):
        """Wait for the model to finish this turn; re-raise immediately if the
        pump died (ws closed) instead of sitting out the whole timeout."""
        ev = asyncio.create_task(self.turn_done.wait())
        done, _ = await asyncio.wait(
            {ev, self.task}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        if ev not in done:
            ev.cancel()
        if self.task in done:
            self.task.result()  # raises the pump's exception
        if not done:
            raise TimeoutError

    async def _pump(self):
        while True:
            sent_tool_response = False
            async for msg in self.session.receive():
                rec = self.rec
                if msg.tool_call:
                    now = time.monotonic()
                    if rec.t_first_tool is None:
                        rec.t_first_tool = now
                    responses = []
                    for fc in msg.tool_call.function_calls or []:
                        result = await self.form.dispatch(fc.name, dict(fc.args or {}))
                        # t_abs: tool calls can land while the silence tail is
                        # still streaming, before t_end_audio is known — the
                        # snapshot converts to relative ms afterwards.
                        rec.tool_calls.append(
                            {
                                "name": fc.name,
                                "args": dict(fc.args or {}),
                                "result": result,
                                "t_abs": now,
                            }
                        )
                        responses.append(
                            types.FunctionResponse(
                                id=fc.id, name=fc.name, response={"result": result}
                            )
                        )
                    await self.session.send_tool_response(function_responses=responses)
                    sent_tool_response = True
                    continue
                sc = msg.server_content
                if not sc:
                    continue
                if sc.model_turn:
                    for p in sc.model_turn.parts or []:
                        if p.inline_data and p.inline_data.data:
                            if rec.t_first_audio is None:
                                rec.t_first_audio = time.monotonic()
                            rec.audio_bytes += len(p.inline_data.data)
                if sc.input_transcription and sc.input_transcription.text:
                    rec.user_text += sc.input_transcription.text
                if sc.output_transcription and sc.output_transcription.text:
                    rec.asst_text += sc.output_transcription.text
            # A receive pass ends at a turn boundary. If we answered a tool call
            # in it, the model's follow-up comes in the next pass — not done yet.
            if not sent_tool_response:
                self.turn_done.set()


async def send_clip(session, pcm: bytes) -> float:
    """Stream a clip at real-time pace + trailing silence to trip the 700ms VAD.
    Returns the end-of-SPEECH timestamp — the latency reference for the turn."""
    step = RATE * 2 * CHUNK_MS // 1000
    for i in range(0, len(pcm), step):
        await session.send_realtime_input(
            audio=types.Blob(data=pcm[i : i + step], mime_type=f"audio/pcm;rate={RATE}")
        )
        await asyncio.sleep(CHUNK_MS / 1000)
    t_speech_end = time.monotonic()
    silence = b"\x00" * step
    for _ in range(1200 // CHUNK_MS):
        await session.send_realtime_input(
            audio=types.Blob(data=silence, mime_type=f"audio/pcm;rate={RATE}")
        )
        await asyncio.sleep(CHUNK_MS / 1000)
    return t_speech_end


async def run_scenario(client: genai.Client, http: aiohttp.ClientSession, sc: dict) -> dict:
    async def geosearch(text: str) -> dict:
        async with http.get(SERVE_BASE + "/api/geosearch", params={"text": text}) as r:
            return await r.json()

    form = VirtualForm(geosearch=geosearch)
    session_id = f"{TEST_SESSION_PREFIX}eval-{BACKEND}-{sc['id']}-{int(time.time())}"
    turns_out: list[dict] = []

    def make_config() -> types.LiveConnectConfig:
        # Rebuilt per (re)connect: on resume the app appends resumeContext() to
        # the system instruction so the fresh session picks up where it was.
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            temperature=0.3,
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE)
                )
            ),
            system_instruction=types.Content(
                parts=[types.Part(text=system_instruction() + resume_context(form))]
            ),
            tools=tool_declarations(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    silence_duration_ms=700,
                    prefix_padding_ms=300,
                    start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_LOW,
                ),
                turn_coverage=types.TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            ),
        )

    # Gemini Live drops sessions mid-conversation in the wild (1008/1011 — the
    # prod telemetry shows the same codes), and the app's answer is reconnect +
    # resumeContext(). The harness mirrors that, and records every disconnect as
    # a first-class reliability metric.
    error: str | None = None
    disconnects: list[dict] = []
    next_i = 0
    stuck = 0  # consecutive failures on the same turn
    while next_i < len(sc["turns"]):
        try:
            async with client.aio.live.connect(model=MODEL, config=make_config()) as session:
                reader = SessionReader(session, form)
                # Same opener the app sends — the Live API never speaks first.
                greeting = TurnRecorder()
                greeting.t_end_audio = time.monotonic()
                await reader.next_turn(greeting)
                reader.start()
                await session.send_client_content(
                    turns=types.Content(role="user", parts=[types.Part(text="Hi")]),
                    turn_complete=True,
                )
                await reader.wait_turn(TURN_TIMEOUT_S)

                try:
                    while next_i < len(sc["turns"]):
                        i, turn = next_i, sc["turns"][next_i]
                        clip = next((AUDIO_DIR / sc["id"]).glob(f"{i:02d}_*.wav"))
                        pcm = read_wav(clip)
                        rec = TurnRecorder()
                        await asyncio.sleep(0.5)  # a beat between turns, like a human
                        await reader.next_turn(rec)
                        rec.t_end_audio = await send_clip(session, pcm)
                        try:
                            await reader.wait_turn(TURN_TIMEOUT_S)
                        except TimeoutError:
                            rec.asst_text += " [TURN TIMEOUT]"
                        turns_out.append(rec.snapshot(turn["say"]))
                        print(
                            f"   #{i} heard={turns_out[-1]['heard'][:48]!r} "
                            f"tools={[c['name'] + ':' + str(c['args'].get('field', '')) for c in rec.tool_calls]}"
                        )
                        next_i += 1
                        stuck = 0
                        if reader.task.done():  # pump died (ws closed) — surface it
                            reader.task.result()
                finally:
                    await reader.stop()
        except Exception as e:
            stuck += 1
            disconnects.append({"before_turn": next_i, "error": repr(e)})
            print(
                f"   ⚠️  disconnect before turn {next_i}: {e!r} — reconnecting with resume context…"
            )
            if stuck >= 2:  # same turn failed twice → skip it, keep the scenario going
                turns_out.append(
                    {
                        "say": sc["turns"][next_i]["say"],
                        "heard": "",
                        "assistant": "[SKIPPED after repeated disconnects]",
                        "tool_calls": [],
                        "audio_out_s": 0,
                        "ttft_tool_ms": None,
                        "ttfa_ms": None,
                    }
                )
                next_i += 1
                stuck = 0
            if len(disconnects) >= 6:
                error = f"aborted after {len(disconnects)} disconnects"
                break
            await asyncio.sleep(3)

    result = {
        "backend": BACKEND,
        "model": MODEL,
        "scenario": sc["id"],
        "session_id": session_id,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "turns": turns_out,
        "disconnects": disconnects,
        "final_values": form.values,
        "addr_status": form.addr_status,
        "submitted": form.submitted,
        "tool_log": form.tool_log,
    }
    if error:
        result["error"] = error
        result["completed_turns"] = len(turns_out)

    # Telemetry → D1 via serve.py, flagged is_test by the session-id prefix.
    events = [
        {
            "seq": 0,
            "type": "session_start",
            "ts": int(time.time() * 1000),
            "data": {"eval": True, "backend": BACKEND, "scenario": sc["id"]},
        }
    ]
    seq = 1
    for t in turns_out:
        for c in t["tool_calls"]:
            events.append(
                {
                    "seq": seq,
                    "type": "tool_call",
                    "ts": int(time.time() * 1000),
                    "data": {"name": c["name"], "args": c["args"], "result": c["result"]},
                }
            )
            seq += 1
        events.append(
            {
                "seq": seq,
                "type": "turn",
                "ts": int(time.time() * 1000),
                "data": {"user": t["heard"], "asst": t["assistant"]},
            }
        )
        seq += 1
    events.append(
        {
            "seq": seq,
            "type": "session_end",
            "ts": int(time.time() * 1000),
            "data": {"values": form.values, "submitted": form.submitted},
        }
    )
    try:
        async with http.post(
            SERVE_BASE + "/api/log", json={"sessionId": session_id, "events": events}
        ) as r:
            await r.json()
    except Exception as e:
        print(f"   ⚠️  telemetry post failed (non-fatal): {e}")

    return result


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", help="run just one scenario id")
    args = ap.parse_args()

    api_key, _src = load_api_key()
    if not api_key:
        sys.exit("No GEMINI_API_KEY found.")
    client = genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    todo = [s for s in SCENARIOS if not args.scenario or s["id"] == args.scenario]
    async with aiohttp.ClientSession() as http:
        spawned = await ensure_serve(http)
        try:
            for sc in todo:
                print(f"\n▶️  {sc['id']}  ({len(sc['turns'])} turns)")
                result = None
                for attempt in (1, 2):  # preview models flake — one clean retry
                    result = await run_scenario(client, http, sc)
                    if "error" not in result:
                        break
                    if attempt == 1:
                        print("   🔁 retrying scenario after session error…")
                        await asyncio.sleep(2)
                out = RESULTS_DIR / f"{sc['id']}.json"
                out.write_text(json.dumps(result, indent=1))
                print(f"   💾 {out.relative_to(HERE.parent)}")
        finally:
            if spawned:
                spawned.terminate()

    print("\n✅ baseline run complete")


if __name__ == "__main__":
    asyncio.run(main())
