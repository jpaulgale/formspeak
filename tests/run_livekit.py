#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "livekit-agents>=1.3",
#     "aiohttp>=3.9",
# ]
# ///
"""FormSpeak backend eval — CANDIDATE runner: LiveKit Inference pipeline
(STT → Gemma 4 31B → [TTS]), the stack LiveKit markets for voice agents.

Headless, no room: corpus clips stream through inference STT exactly as the
agents framework would feed them, the transcript drives an AgentSession turn
against `google/gemma-4-31b-it` with the app's system instruction and raw tool
schemas, and tool results come from the same VirtualForm as every other leg.
Latency is recorded per hop (STT finalization, LLM turn) so the end-to-end
comparison against the speech-to-speech backends stays honest: add a TTS
time-to-first-byte (~100-150 ms on their stack) when comparing to first-audio.

Credentials: LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL — after
`lk cloud auth`, populate with:  eval "$(lk app env)"  or pass --env-file.

    uv run tests/run_livekit.py
    uv run tests/run_livekit.py --scenario happy_path --llm google/gemma-4-31b-it
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path

import aiohttp

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from formspeak_env import (
    SERVE_BASE,
    TEST_SESSION_PREFIX,
    VirtualForm,
    parse_env_file,
    system_instruction,
    tool_declarations,
)
from scenarios import SCENARIOS

DEFAULT_LLM = "google/gemma-4-31b-it"
DEFAULT_STT = "deepgram/flux-general"
RATE = 16_000
AUDIO_DIR = HERE / "audio"
TURN_TIMEOUT_S = 60


def load_livekit_env(env_file: str | None) -> bool:
    if env_file and Path(env_file).exists():
        for k, v in parse_env_file(Path(env_file)).items():
            os.environ.setdefault(k, v)
    for p in (HERE.parent / ".env.livekit", HERE.parent / ".env.local"):
        if p.exists():
            for k, v in parse_env_file(p).items():
                os.environ.setdefault(k, v)
    return bool(os.environ.get("LIVEKIT_API_KEY") and os.environ.get("LIVEKIT_API_SECRET"))


def read_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1, path
        return w.readframes(w.getnframes())


async def transcribe(stt, pcm: bytes) -> tuple[str, int]:
    """Stream a clip through inference STT at real-time pace.
    Returns (final transcript, ms from end-of-audio to final transcript)."""
    from livekit import rtc
    from livekit.agents import stt as stt_mod

    stream = stt.stream()
    step = RATE * 2 * 128 // 1000  # 128ms frames

    async def push():
        for i in range(0, len(pcm), step):
            chunk = pcm[i : i + step]
            stream.push_frame(
                rtc.AudioFrame(
                    data=chunk,
                    sample_rate=RATE,
                    num_channels=1,
                    samples_per_channel=len(chunk) // 2,
                )
            )
            await asyncio.sleep(0.128)
        t_speech_end = time.monotonic()  # latency reference: end of SPEECH
        # trailing silence so endpointing closes the turn
        silence = b"\x00" * step
        for _ in range(10):
            stream.push_frame(
                rtc.AudioFrame(
                    data=silence, sample_rate=RATE, num_channels=1, samples_per_channel=step // 2
                )
            )
            await asyncio.sleep(0.128)
        stream.end_input()
        return t_speech_end

    push_task = asyncio.create_task(push())
    finals: list[str] = []
    t_final = None
    # The inference STT stream doesn't terminate on end_input — consume events
    # until they go quiet after the push finishes (2s idle = utterance done).
    it = stream.__aiter__()
    while True:
        try:
            ev = await asyncio.wait_for(anext(it), 2.0 if push_task.done() else 30.0)
        except (TimeoutError, StopAsyncIteration):
            break
        if ev.type == stt_mod.SpeechEventType.FINAL_TRANSCRIPT and ev.alternatives:
            finals.append(ev.alternatives[0].text)
            t_final = time.monotonic()
    t_speech_end = await push_task
    await stream.aclose()
    text = " ".join(t for t in finals if t).strip()
    latency = round((t_final - t_speech_end) * 1000) if t_final and t_final > t_speech_end else 0
    return text, latency


def build_agent(form: VirtualForm):
    """Agent with the app's EXACT tool schemas (raw), dispatching to VirtualForm."""
    from livekit.agents import Agent
    from livekit.agents.llm import function_tool

    decls = tool_declarations()[0]["function_declarations"]
    tools = []
    for decl in decls:
        params = json.loads(
            json.dumps(decl["parameters"])
            .replace('"OBJECT"', '"object"')
            .replace('"STRING"', '"string"')
        )

        def make_handler(name):
            async def handler(raw_arguments: dict):  # raw tool: single dict arg
                return await form.dispatch(name, dict(raw_arguments or {}))

            return handler

        tools.append(
            function_tool(
                make_handler(decl["name"]),
                raw_schema={
                    "name": decl["name"],
                    "description": decl["description"],
                    "parameters": params,
                },
            )
        )

    return Agent(instructions=system_instruction(), tools=tools)


async def run_scenario(
    http: aiohttp.ClientSession, sc: dict, llm_model: str, stt_model: str
) -> dict:
    from livekit.agents import AgentSession, inference

    async def geosearch(text: str) -> dict:
        async with http.get(SERVE_BASE + "/api/geosearch", params={"text": text}) as r:
            return await r.json()

    form = VirtualForm(geosearch=geosearch)
    backend = f"livekit-{llm_model.split('/')[-1]}"
    session_id = f"{TEST_SESSION_PREFIX}eval-{backend}-{sc['id']}-{int(time.time())}"
    turns_out: list[dict] = []
    error: str | None = None

    from livekit.agents.utils import http_context

    try:
        async with (
            http_context.open(),  # required to use inference outside a worker
            inference.STT(model=stt_model, language="en") as stt,
            inference.LLM(model=llm_model) as llm,
            AgentSession(llm=llm) as session,
        ):
            await session.start(build_agent(form))
            # Same opener as the app — greet first.
            await asyncio.wait_for(session.run(user_input="Hi"), TURN_TIMEOUT_S)

            for i, turn in enumerate(sc["turns"]):
                clip = next((AUDIO_DIR / sc["id"]).glob(f"{i:02d}_*.wav"))
                heard, stt_ms = await transcribe(stt, read_wav(clip))
                calls_before = len(form.tool_log)
                t0 = time.monotonic()
                try:
                    await asyncio.wait_for(
                        session.run(user_input=heard or "(unintelligible)"), TURN_TIMEOUT_S
                    )
                    llm_ms = round((time.monotonic() - t0) * 1000)
                except TimeoutError:
                    llm_ms = None
                new_calls = [
                    {"name": c["name"], "args": c["args"], "result": c["result"], "t_ms": llm_ms}
                    for c in form.tool_log[calls_before:]
                ]
                turns_out.append(
                    {
                        "say": turn["say"],
                        "heard": heard,
                        "assistant": "",
                        "tool_calls": new_calls,
                        "audio_out_s": 0,
                        "stt_final_ms": stt_ms,
                        "ttft_tool_ms": (stt_ms + llm_ms) if llm_ms is not None else None,
                        "ttfa_ms": None,  # pipeline TTS not exercised — see report note
                    }
                )
                print(
                    f"   #{i} heard={heard[:48]!r} stt={stt_ms}ms "
                    f"tools={[c['name'] + ':' + str(c['args'].get('field', '')) for c in new_calls]}"
                )
    except Exception as e:
        error = repr(e)
        print(f"   ⚠️  session error after {len(turns_out)} turn(s): {error}")

    result = {
        "backend": backend,
        "model": f"{stt_model} + {llm_model}",
        "scenario": sc["id"],
        "session_id": session_id,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "turns": turns_out,
        "final_values": form.values,
        "addr_status": form.addr_status,
        "submitted": form.submitted,
        "tool_log": form.tool_log,
    }
    if error:
        result["error"] = error
        result["completed_turns"] = len(turns_out)

    events = [
        {
            "seq": 0,
            "type": "session_start",
            "ts": int(time.time() * 1000),
            "data": {"eval": True, "backend": backend, "scenario": sc["id"]},
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
                "data": {"user": t["heard"], "asst": ""},
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
    ap.add_argument("--scenario")
    ap.add_argument("--llm", default=DEFAULT_LLM)
    ap.add_argument("--stt", default=DEFAULT_STT)
    ap.add_argument("--env-file", help="file with LIVEKIT_API_KEY/SECRET (e.g. from `lk app env`)")
    args = ap.parse_args()

    if not load_livekit_env(args.env_file):
        sys.exit(
            "Missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET.\n"
            "Run `lk cloud auth`, then `lk app env -w .env.livekit` in the project root,\n"
            "or pass --env-file."
        )

    backend = f"livekit-{args.llm.split('/')[-1]}"
    results_dir = HERE / "results" / backend
    results_dir.mkdir(parents=True, exist_ok=True)
    todo = [s for s in SCENARIOS if not args.scenario or s["id"] == args.scenario]

    async with aiohttp.ClientSession() as http:
        from formspeak_env import ensure_serve

        spawned = await ensure_serve(http)
        try:
            for sc in todo:
                print(f"\n▶️  {sc['id']}  ({len(sc['turns'])} turns)  [{args.stt} → {args.llm}]")
                result = None
                for attempt in (1, 2):
                    result = await run_scenario(http, sc, args.llm, args.stt)
                    if "error" not in result:
                        break
                    if attempt == 1:
                        print("   🔁 retrying scenario after session error…")
                        await asyncio.sleep(2)
                out = results_dir / f"{sc['id']}.json"
                out.write_text(json.dumps(result, indent=1))
                print(f"   💾 {out.relative_to(HERE.parent)}")
        finally:
            if spawned:
                spawned.terminate()
    print("\n✅ livekit run complete")


if __name__ == "__main__":
    asyncio.run(main())
