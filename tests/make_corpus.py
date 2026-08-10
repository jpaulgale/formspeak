#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "google-genai>=1.0",
#     "numpy>=1.26",
#     "aiohttp>=3.9",
# ]
# ///
"""Generate the spoken test corpus for the FormSpeak backend eval.

Renders every scenario turn in scenarios.py to a 16 kHz mono PCM16 WAV via
Gemini TTS (voices rotate per scenario so no backend gets to overfit one
speaker). Clips are cached by (text, voice) hash — re-running only synthesizes
new/changed turns.

    uv run tests/make_corpus.py            # generate all missing clips
    uv run tests/make_corpus.py --force    # regenerate everything
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
from google import genai
from google.genai import types

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from scenarios import SCENARIOS  # noqa: E402
from serve import load_api_key  # noqa: E402  (reuses the app's key resolution)

TTS_MODEL = "gemini-3.1-flash-tts-preview"
AUDIO_DIR = HERE / "audio"
MANIFEST = AUDIO_DIR / "manifest.json"
TARGET_RATE = 16_000   # what Gemini Live / the app's worklet feeds the models
TTS_RATE = 24_000      # what Gemini TTS returns

STYLE = (
    "Speak as an ordinary person talking to a voice assistant on the phone — "
    "natural pace, plain delivery, no theatrical emotion. Say exactly this: "
)


def clip_id(text: str, voice: str) -> str:
    return hashlib.sha256(f"{voice}::{text}".encode()).hexdigest()[:12]


def resample_to_16k(pcm24: bytes) -> bytes:
    """24 kHz PCM16 → 16 kHz PCM16 (linear interpolation — fine for speech)."""
    x = np.frombuffer(pcm24, dtype=np.int16).astype(np.float32)
    n_out = int(len(x) * TARGET_RATE / TTS_RATE)
    idx = np.linspace(0, len(x) - 1, n_out)
    y = np.interp(idx, np.arange(len(x)), x)
    return y.astype(np.int16).tobytes()


def write_wav(path: Path, pcm16: bytes, rate: int = TARGET_RATE) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16)


def synth(client: genai.Client, text: str, voice: str) -> bytes:
    """One TTS call → raw 24 kHz PCM16. Retries on transient/rate errors."""
    for attempt in range(4):
        try:
            resp = client.models.generate_content(
                model=TTS_MODEL,
                contents=STYLE + text,
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                        )
                    ),
                ),
            )
            part = resp.candidates[0].content.parts[0]
            return part.inline_data.data
        except Exception as e:  # noqa: BLE001
            wait = 5 * (attempt + 1)
            print(f"   ⚠️  TTS failed ({e}); retrying in {wait}s…")
            time.sleep(wait)
    raise RuntimeError(f"TTS failed after retries: {text[:60]!r}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="regenerate even cached clips")
    args = ap.parse_args()

    api_key, src = load_api_key()
    if not api_key:
        sys.exit("No GEMINI_API_KEY found (env, ./.env, or ev-storefront .dev.vars).")
    print(f"🔑 key from {src}\n🗣  TTS model: {TTS_MODEL}\n")
    client = genai.Client(api_key=api_key)

    AUDIO_DIR.mkdir(exist_ok=True)
    manifest: dict = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    made = skipped = 0

    for sc in SCENARIOS:
        voice = sc["voice"]
        sc_dir = AUDIO_DIR / sc["id"]
        sc_dir.mkdir(exist_ok=True)
        for i, turn in enumerate(sc["turns"]):
            cid = clip_id(turn["say"], voice)
            fname = f"{i:02d}_{cid}.wav"
            fpath = sc_dir / fname
            key = f"{sc['id']}/{i}"
            manifest[key] = {"file": f"{sc['id']}/{fname}", "text": turn["say"], "voice": voice}
            if fpath.exists() and not args.force:
                skipped += 1
                continue
            print(f"🎙  [{sc['id']} #{i}] ({voice}) {turn['say'][:70]}…")
            pcm = synth(client, turn["say"], voice)
            write_wav(fpath, resample_to_16k(pcm))
            dur = (fpath.stat().st_size - 44) / 2 / TARGET_RATE
            print(f"   → {fname} ({dur:.1f}s)")
            made += 1

    MANIFEST.write_text(json.dumps(manifest, indent=1))
    print(f"\n✅ corpus ready: {made} generated, {skipped} cached → {AUDIO_DIR}")


if __name__ == "__main__":
    main()
