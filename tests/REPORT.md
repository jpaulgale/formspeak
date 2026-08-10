# FormSpeak voice-backend evaluation — verdict

*2026-07-16 · 9 scripted scenarios, 29 TTS turns, identical prompt/tools/validation
across all legs (extracted live from `index.html`). Raw scorecard:
`tests/results/report.md`; per-run JSON in `tests/results/<backend>/`.*

## Side-by-side (final, fair configs)

| | **Gemini Live** (shipped) | **gpt-realtime-2.1** (VAD auto, prod config) | **LiveKit: Flux → Gemma 4 31B** |
|---|---|---|---|
| Architecture | speech-to-speech, browser→WS | speech-to-speech, browser→WS (1:1 swap) | STT→LLM→TTS pipeline + agent worker (rebuild) |
| Per-turn checks | 89%* | 94%† | 87% (2 real capability misses) |
| Model capability (final form state) | **100%** | ~100% (one VAD-split casualty) | 2 wrong outcomes |
| Guardrails | 9/9 | 9/9 | 8/9 |
| End-of-speech → tool call (median) | **~1.0 s** | ~1.2 s | ~0.8–1.2 s (excl. TTS hop) |
| Session drops in eval | 8 (see Reliability) | 0 | 0 |
| Est. cost / 3-min session | **~$0.03** | ~$0.12–0.25 | ~$0.04–0.06 |
| Data posture | PII → Google | PII → OpenAI | ZDR default; open weights |

\* Gemini misses were all turns swallowed around a reconnect — final form state
was always fully correct.
† One real miss: production VAD split the slow digit cadence
"nine zero eight *(pause)* seven seven zero" into two turns and the phone never
completed. With deterministic turn control the same model scored 100% — but
that config adds ~1.2 s latency, so 94% is the honest production number.
Also verified: `reasoning.effort: low` keeps 100% accuracy and does **not**
reduce latency (it's not the latency driver). **Mini is not viable**: 83%,
a guardrail failure, hesitates on edge cases, same latency as full 2.1.

## Reliability — what the disconnect data actually says

The harness saw 8 Gemini session drops in 9 back-to-back sessions (1008/1006,
plus one explicit 1011 "resource exhausted"). **This is correlated with
session-creation density, not proof of steady-state instability**: the eval
created dozens of sessions within the hour (every reconnect is itself a new
session, so drops compound), which is nothing like one user at a time.

Prod telemetry (Jun 26–Jul 2): 12 abnormal closes out of 34, but **7 of the 12
come from just two heavy users** (likely dev/demo bursts — same churn pattern
as the harness), 3 of the rest are code 1006 (network-side), leaving only 2
spread-out 1008s across distinct real users. Consistent with the observed
~91–100% per-user reliability.

**The launch-relevant conclusion:** these are per-API-key limits, and every
browser session mints tokens against the same key — so *concurrent users at
launch reproduce exactly the churn the harness hit*. Before launching on
Gemini Live (a preview model with its own caps): confirm the key's tier/quota
for `gemini-3.1-flash-live-preview`, load-test N concurrent sessions, and keep
the reconnect+resume machinery (it recovered every eval session that dropped).

## Recommendation

1. **Keep Gemini Live for this product.** It's the fastest to act (~1.0 s),
   ~4–8× cheaper than the alternative that matches it, its model capability was
   flawless in the eval, and the reliability scare is mostly session-churn
   quota pressure you can size for. Action items: verify quota tier, load-test
   concurrency, watch the prod 1008 rate on the dashboard.
2. **gpt-realtime-2.1 (full) is a credible plan B** — within ~200 ms of Gemini,
   zero drops, essentially equal capability — if Gemini's preview-model quotas
   or PII-to-Google posture become blockers. It is *not* a latency or price
   win, and mini is not a substitute. The swap is ~200 lines of protocol code.
3. **Pass on the LiveKit Gemma-4 pipeline for now.** It's fast and
   cost-competitive with real ZDR/open-weight benefits, but it produced the
   eval's only two wrong-value outcomes (STT truncation → wrong DOB; address
   never filed), and it's a rebuild (rooms + deployed agent worker), not a
   swap. Revisit if data posture becomes the top priority.
4. **Re-test when the GPT-Live API ships** (currently ChatGPT-only): full-duplex
   listening-while-speaking directly targets this app's correction-heavy UX.

## Caveats

- Latency measured from end-of-speech over a residential connection; all legs
  share the same 700 ms VAD wait inside their numbers. LiveKit's marketed
  354 ms TTFA assumes colocated infra; our LiveKit number excludes its TTS hop.
- Costs are estimates from measured audio seconds × published prices; realtime
  APIs re-bill context per turn (cached at a discount), so long sessions drift
  upward — the OpenAI range reflects that.
- Corpus is synthetic TTS in quiet conditions; accents, noise, and barge-in
  aren't covered (the `?test=1` injector can demo clips through the real UI).
- One scorer regex artifact inflates Gemma's miss count by 1 (spelled-out
  "Fifth" vs `350.*5`); its true per-turn score is ~88%.
