#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "aiohttp>=3.9",
#     "numpy>=1.26",
# ]
# ///
"""FormSpeak backend eval — CANDIDATE runner: OpenAI gpt-realtime (speech-to-speech).

Architecturally 1:1 with the shipped Gemini Live setup: one WebSocket, native
audio in/out, function calling. Same system instruction (extracted from
index.html), same VirtualForm tool responses, same corpus, same telemetry
flagging (`test-` session prefix → is_test=1).

    uv run tests/run_openai_realtime.py                    # all scenarios
    uv run tests/run_openai_realtime.py --scenario happy_path
    uv run tests/run_openai_realtime.py --model gpt-realtime-2.1-mini
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import time
import wave
from pathlib import Path

import aiohttp
import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from formspeak_env import (  # noqa: E402
    SERVE_BASE, TEST_SESSION_PREFIX, VirtualForm, parse_env_file,
    system_instruction, tool_declarations,
)
from scenarios import SCENARIOS  # noqa: E402

DEFAULT_MODEL = "gpt-realtime-2.1"
VOICE = "alloy"
SRC_RATE = 16_000        # corpus clips
API_RATE = 24_000        # realtime API pcm16 rate
CHUNK_MS = 128
TURN_TIMEOUT_S = 60
AUDIO_DIR = HERE / "audio"


def load_openai_key() -> str | None:
    import os
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    dev_vars = HERE.parent.parent.parent / "ev-storefront" / "storefront-updater-airtable-worker" / ".dev.vars"
    if dev_vars.exists():
        return parse_env_file(dev_vars).get("OPENAI_API_KEY")
    return None


def read_wav_24k(path: Path) -> bytes:
    """Corpus clip (16 kHz PCM16) → 24 kHz PCM16 for the realtime API."""
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SRC_RATE and w.getnchannels() == 1, path
        pcm = w.readframes(w.getnframes())
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    n_out = int(len(x) * API_RATE / SRC_RATE)
    y = np.interp(np.linspace(0, len(x) - 1, n_out), np.arange(len(x)), x)
    return y.astype(np.int16).tobytes()


def openai_tools() -> list[dict]:
    """Convert the app's function declarations to realtime-API tool format."""
    out = []
    for decl in tool_declarations()[0]["function_declarations"]:
        params = json.loads(json.dumps(decl["parameters"]).replace('"OBJECT"', '"object"').replace('"STRING"', '"string"'))
        out.append({"type": "function", "name": decl["name"],
                    "description": decl["description"], "parameters": params})
    return out


class Turn:
    def __init__(self):
        self.user_text = ""
        self.asst_text = ""
        self.tool_calls: list[dict] = []
        self.audio_bytes = 0
        self.t_end_audio = 0.0
        self.t_first_tool: float | None = None
        self.t_first_audio: float | None = None

    def snapshot(self, say: str) -> dict:
        ms = lambda t: round((t - self.t_end_audio) * 1000) if t else None  # noqa: E731
        return {"say": say, "heard": self.user_text.strip(), "assistant": self.asst_text.strip(),
                "tool_calls": self.tool_calls,
                "audio_out_s": round(self.audio_bytes / 2 / API_RATE, 2),
                "ttft_tool_ms": ms(self.t_first_tool), "ttfa_ms": ms(self.t_first_audio)}


async def send_json(ws, obj: dict) -> None:
    await ws.send_str(json.dumps(obj))


async def recv_event(ws) -> dict:
    while True:
        msg = await ws.receive()
        if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
            raise ConnectionError(f"ws closed: {msg}")
        if msg.type == aiohttp.WSMsgType.TEXT:
            return json.loads(msg.data)


async def drain_response(ws, form: VirtualForm, rec: Turn) -> None:
    """Wait out one model response; chase function-call → output → new response
    chains until a response.done arrives with no function calls in it."""
    while True:
        fn_calls: list[dict] = []
        while True:
            ev = await recv_event(ws)
            et = ev.get("type", "")
            if et == "error":
                print(f"   🔴 API error event: {json.dumps(ev)[:300]}")
                return
            if et.endswith("input_audio_transcription.completed"):
                rec.user_text += ev.get("transcript", "")
            elif et in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
                rec.asst_text += ev.get("delta", "")
            elif et in ("response.output_audio.delta", "response.audio.delta"):
                if rec.t_first_audio is None:
                    rec.t_first_audio = time.monotonic()
                rec.audio_bytes += len(base64.b64decode(ev.get("delta", "") or ""))
            elif et == "response.done":
                for item in ((ev.get("response") or {}).get("output") or []):
                    if (item or {}).get("type") == "function_call":
                        fn_calls.append(item)
                break
        if not fn_calls:
            # The input transcription is a separate async model and often lands
            # after response.done — linger briefly so `heard` stays attributed
            # to the right turn (purely diagnostic; scoring keys on tool calls).
            if not rec.user_text:
                deadline = time.monotonic() + 1.5
                while time.monotonic() < deadline:
                    try:
                        ev = await asyncio.wait_for(
                            recv_event(ws), max(0.05, deadline - time.monotonic()))
                    except (asyncio.TimeoutError, ConnectionError):
                        break
                    if ev.get("type", "").endswith("input_audio_transcription.completed"):
                        rec.user_text += ev.get("transcript", "")
                        break
            return
        now = time.monotonic()
        if rec.t_first_tool is None:
            rec.t_first_tool = now
        for fc in fn_calls:
            args = json.loads(fc.get("arguments") or "{}")
            result = await form.dispatch(fc.get("name", ""), args)
            rec.tool_calls.append({"name": fc.get("name", ""), "args": args, "result": result,
                                   "t_ms": round((now - rec.t_end_audio) * 1000)})
            await send_json(ws, {"type": "conversation.item.create",
                                 "item": {"type": "function_call_output",
                                          "call_id": fc.get("call_id"), "output": result}})
        await send_json(ws, {"type": "response.create"})


async def send_clip(ws, pcm24: bytes) -> float:
    """Stream + trailing silence (trips server VAD commit). Returns end-of-speech ts."""
    step = API_RATE * 2 * CHUNK_MS // 1000
    for i in range(0, len(pcm24), step):
        await send_json(ws, {"type": "input_audio_buffer.append",
                             "audio": base64.b64encode(pcm24[i:i + step]).decode()})
        await asyncio.sleep(CHUNK_MS / 1000)
    t_speech_end = time.monotonic()
    silence = base64.b64encode(b"\x00" * step).decode()
    for _ in range(1200 // CHUNK_MS):
        await send_json(ws, {"type": "input_audio_buffer.append", "audio": silence})
        await asyncio.sleep(CHUNK_MS / 1000)
    return t_speech_end


async def run_scenario(http: aiohttp.ClientSession, key: str, model: str, sc: dict,
                       reasoning: str | None = None) -> dict:
    async def geosearch(text: str) -> dict:
        async with http.get(SERVE_BASE + "/api/geosearch", params={"text": text}) as r:
            return await r.json()

    form = VirtualForm(geosearch=geosearch)
    backend = model + (f"-r{reasoning}" if reasoning else "")
    session_id = f"{TEST_SESSION_PREFIX}eval-{backend}-{sc['id']}-{int(time.time())}"
    turns_out: list[dict] = []

    url = f"wss://api.openai.com/v1/realtime?model={model}"
    async with http.ws_connect(url, headers={"Authorization": f"Bearer {key}"},
                               max_msg_size=16 * 1024 * 1024) as ws:
        ev = await recv_event(ws)  # session.created
        if ev.get("type") == "error":
            raise RuntimeError(f"session error: {ev}")
        session_cfg_extra = {"reasoning": {"effort": reasoning}} if reasoning else {}
        await send_json(ws, {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": system_instruction(),
                "tools": openai_tools(),
                "tool_choice": "auto",
                **session_cfg_extra,
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": API_RATE},
                        "transcription": {"model": "gpt-4o-transcribe"},
                        "turn_detection": {
                            "type": "server_vad",
                            "silence_duration_ms": 700,
                            "prefix_padding_ms": 300,
                            # Production-faithful: VAD triggers the response itself at
                            # 700ms of silence — same as Gemini Live's config. (An
                            # explicit response.create after the harness's full 1.2s
                            # silence tail would hand this leg a ~500ms latency
                            # penalty the real app wouldn't have.)
                            "create_response": True,
                            "interrupt_response": False,
                        },
                    },
                    "output": {"format": {"type": "audio/pcm", "rate": API_RATE},
                               "voice": VOICE},
                },
            },
        })
        ev = await recv_event(ws)
        if ev.get("type") == "error":
            # Surface the exact validation error — the session shape is the one
            # part of this API most likely to have drifted.
            raise RuntimeError(f"session.update rejected: {json.dumps(ev)[:500]}")

        # Same opener as the app: a text turn so the model greets first.
        greeting = Turn()
        greeting.t_end_audio = time.monotonic()
        await send_json(ws, {"type": "conversation.item.create",
                             "item": {"type": "message", "role": "user",
                                      "content": [{"type": "input_text", "text": "Hi"}]}})
        await send_json(ws, {"type": "response.create"})
        await asyncio.wait_for(drain_response(ws, form, greeting), TURN_TIMEOUT_S)

        for i, turn in enumerate(sc["turns"]):
            clip = next((AUDIO_DIR / sc["id"]).glob(f"{i:02d}_*.wav"))
            rec = Turn()
            await asyncio.sleep(0.3)
            rec.t_end_audio = await send_clip(ws, read_wav_24k(clip))
            # VAD auto-creates the response at 700ms into the silence tail.
            try:
                await asyncio.wait_for(drain_response(ws, form, rec), TURN_TIMEOUT_S)
            except asyncio.TimeoutError:
                rec.asst_text += " [TURN TIMEOUT]"
            turns_out.append(rec.snapshot(turn["say"]))
            print(f"   #{i} heard={turns_out[-1]['heard'][:48]!r} "
                  f"tools={[c['name'] + ':' + str(c['args'].get('field', '')) for c in rec.tool_calls]}")

    result = {
        "backend": backend, "model": model, "scenario": sc["id"],
        "session_id": session_id, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "turns": turns_out, "final_values": form.values, "addr_status": form.addr_status,
        "submitted": form.submitted, "tool_log": form.tool_log,
    }

    events = [{"seq": 0, "type": "session_start", "ts": int(time.time() * 1000),
               "data": {"eval": True, "backend": backend, "scenario": sc["id"]}}]
    seq = 1
    for t in turns_out:
        for c in t["tool_calls"]:
            events.append({"seq": seq, "type": "tool_call", "ts": int(time.time() * 1000),
                           "data": {"name": c["name"], "args": c["args"], "result": c["result"]}})
            seq += 1
        events.append({"seq": seq, "type": "turn", "ts": int(time.time() * 1000),
                       "data": {"user": t["heard"], "asst": t["assistant"]}})
        seq += 1
    events.append({"seq": seq, "type": "session_end", "ts": int(time.time() * 1000),
                   "data": {"values": form.values, "submitted": form.submitted}})
    try:
        async with http.post(SERVE_BASE + "/api/log",
                             json={"sessionId": session_id, "events": events}) as r:
            await r.json()
    except Exception as e:  # noqa: BLE001
        print(f"   ⚠️  telemetry post failed (non-fatal): {e}")
    return result


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--reasoning", choices=["minimal", "low", "medium", "high", "xhigh"],
                    help="Realtime 2 reasoning.effort (unset = model default)")
    args = ap.parse_args()

    key = load_openai_key()
    if not key:
        sys.exit("No OPENAI_API_KEY found (env or ev-storefront .dev.vars).")

    results_dir = HERE / "results" / (args.model + (f"-r{args.reasoning}" if args.reasoning else ""))
    results_dir.mkdir(parents=True, exist_ok=True)
    todo = [s for s in SCENARIOS if not args.scenario or s["id"] == args.scenario]

    async with aiohttp.ClientSession() as http:
        # serve.py must be up for geosearch + telemetry (reuse baseline's helper)
        from formspeak_env import ensure_serve
        spawned = await ensure_serve(http)
        try:
            for sc in todo:
                print(f"\n▶️  {sc['id']}  ({len(sc['turns'])} turns)  [{args.model}]")
                try:
                    result = await run_scenario(http, key, args.model, sc)
                except Exception as e:  # noqa: BLE001
                    print(f"   ❌ scenario failed: {e!r}")
                    result = {"backend": args.model, "model": args.model, "scenario": sc["id"],
                              "error": repr(e), "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
                out = results_dir / f"{sc['id']}.json"
                out.write_text(json.dumps(result, indent=1))
                print(f"   💾 {out.relative_to(HERE.parent)}")
        finally:
            if spawned:
                spawned.terminate()
    print("\n✅ gpt-realtime run complete")


if __name__ == "__main__":
    asyncio.run(main())
