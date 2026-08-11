# FormSpeak voice-backend eval

Head-to-head test of voice backends for the ramble form, using TTS-generated
spoken sessions and the app's **real** prompt, tools, validation, and geosearch.

| Leg | What | Runner |
|---|---|---|
| baseline | Gemini Live (`gemini-3.1-flash-live-preview`) — the shipped setup | `run_baseline.py` |
| candidate | OpenAI `gpt-realtime-2.1` / `-mini` — architectural 1:1 (speech-to-speech) | `run_openai_realtime.py` |
| candidate | LiveKit Inference pipeline — `deepgram/flux-general` STT → `google/gemma-4-31b-it` | `run_livekit.py` |

GPT-Live (OpenAI's full-duplex successor) is ChatGPT-only as of 2026-07; re-test
when its API ships.

## How it works

- `scenarios.py` — scripted conversations: happy path + the edge cases the
  system prompt guards against (spelling corrections, ambiguous NYC address,
  apartment preservation, partial phone digits, out-of-range DOB, household
  phrasing, unlisted language, premature submit, volunteered feedback).
- `make_corpus.py` — renders every turn to 16 kHz WAV via Gemini TTS
  (`tests/audio/`, cached by content hash; voices rotate per scenario).
- `formspeak_env.py` — the "virtual browser": extracts the system instruction
  from `public/js/prompt.js` at runtime, ports the validators in
  `public/js/validators.js`, and reproduces `tools.js`'s response strings
  exactly. Address checks hit the real `/api/geosearch` on `serve.py` (spawned
  automatically if not running).
- `unit/` + `js/` + `fixtures/` — plain unit tests against the shipped code:
  `npm test` runs the fixture cases through `public/js/validators.js` itself;
  `uv run pytest` runs the same cases through the Python ports, so drift
  between app and harness fails loudly.
- Runners stream clips at real-time pace, answer tool calls via the virtual
  form, and write `tests/results/<backend>/<scenario>.json`.
- `score.py` — grades per-turn expectations, final form state, submit
  guardrails, and latency; writes `tests/results/report.md`.

## Run

```bash
uv run tests/make_corpus.py                  # once (cached after)
uv run tests/run_baseline.py                 # Gemini Live
uv run tests/run_openai_realtime.py          # gpt-realtime-2.1
uv run tests/run_openai_realtime.py --model gpt-realtime-2.1-mini
lk cloud auth && lk app env -w .env.livekit  # once, for the LiveKit leg
uv run tests/run_livekit.py                  # STT → Gemma 4 31B
uv run tests/score.py                        # scorecard + report.md
```

## Telemetry

Every eval session logs to D1 with a `test-` session-id prefix →
`sessions.is_test = 1` (migration `0004`). The dashboard and `view_sessions.py`
hide test sessions by default (`--test` shows only them). The in-app injector
(`http://localhost:8000/?test=1`) flags its sessions the same way and can play
corpus clips through the live UI for demos.

## Latency caveats

- Speech-to-speech legs measure **end-of-audio → first tool call / first audio
  byte** over a real connection from this machine — not vendor-lab numbers.
- The LiveKit leg measures STT-finalization and LLM-turn separately (no room,
  no TTS hop); add their published TTS TTFB (~100–150 ms) before comparing its
  "time to first audio" against the speech-to-speech legs. LiveKit's marketed
  354 ms end-to-end assumes colocated infra; treat our number as an upper bound
  and theirs as a lower bound.
