# Architecture

FormSpeak is a static web app (Cloudflare Pages) with four small serverless
functions, a local dev server, and an eval/observability toolkit. There is no
framework and no build step anywhere: what's in the repo is what runs.

The design rule that shapes everything: **the form stays a form.** The model is
a collaborator inside a conventional interface — it fills fields, it never
becomes the interface. Deterministic code decides what's true (validation,
address verification, submit gating); the model handles language.

## The frontend (`public/`)

`index.html` is markup only. The app is native ES modules under `public/js/`,
loaded directly by the browser — `modulepreload` hints in the head let the
whole graph fetch in parallel instead of one import-discovery round-trip at a
time.

```
                 ┌────────────────────────────────────────────────┐
                 │ main.js — boot + page wiring                   │
                 └───┬───────────────┬────────────────┬───────────┘
                     │               │                │
        ┌────────────▼───┐   ┌───────▼────────┐   ┌───▼──────────────┐
        │ live.js        │   │ audio.js       │   │ form.js          │
        │ token mint     │   │ mic capture    │   │ build/sync form  │
        │ WebSocket      │   │ echo suppress  │   │ error summary    │
        │ session caps   │   │ playback       │   │ manual-edit note │
        └───┬───────┬────┘   └───────┬────────┘   └───┬──────────────┘
            │       │                │                │
   ┌────────▼──┐ ┌──▼────────────────▼──┐   ┌─────────▼────────┐
   │ prompt.js │ │ status.js            │   │ tools.js         │
   │ system    │ │ phase machine + dock │   │ set_field /      │
   │ instr. +  │ └──────────┬───────────┘   │ submit_form +    │
   │ tools     │            │               │ verifyAddress    │
   └───────────┘   ┌────────▼───────┐       └─────────┬────────┘
                   │ card.js        │                 │
                   │ hero question, │       ┌─────────▼────────┐
                   │ progress, caps │       │ done.js          │
                   └────────────────┘       │ review + save    │
                                            └──────────────────┘
      shared, imported everywhere: config.js (FIELDS — the single source
      of truth), state.js (one mutable session object), validators.js
      (pure functions, unit-tested), form-state.js (completion gate),
      telemetry.js (fail-safe event log), dom.js ($, escape, announce)
```

Module responsibilities, one line each:

| Module | Owns |
|---|---|
| `config.js` | model/voice ids, pointer-aware copy ("tap" vs "click"), the `FIELDS` list every other layer derives from |
| `prompt.js` | the system instruction + the two tool declarations — the entire model contract; the eval harness extracts the prompt from this file at runtime |
| `state.js` | the one shared mutable session-state object; modules communicate through it and explicit calls, never via globals |
| `dom.js` | `$`, `escapeHTML`, and the screen-reader `announce()` live region |
| `validators.js` | pure validation/formatting/parsing (phone, DOB, household, income, unit-peeling, transcript denoising) — no DOM, directly unit-tested |
| `form-state.js` | the deterministic completion gate: `isFilled`, `activeIndex`, the telemetry snapshot |
| `telemetry.js` | session id (+ `test-` flagging) and the batched, fail-safe event log |
| `audio.js` | 16 kHz capture with noise gate + acoustic echo suppression; playback at the device's native rate (24 kHz model audio resampled via `resample.js`, buffered against network jitter by the playback worklet); loads the real worklet files in `public/worklets/` |
| `resample.js` | chunk-continuous linear resampler (24 kHz → device rate) so the playback context never needs the OS resampler — unit-tested |
| `status.js` | the mic dock and the listening → thinking → speaking phase machine |
| `card.js` | the hero question card, segmented progress, value-reveal animation, captions |
| `form.js` | the editable form (built once, then two-way synced), NYC DS error summary, and the notes that keep the model aware of manual edits |
| `tools.js` | `set_field`/`submit_form` dispatch and address verification — every response string here is part of the prompt contract |
| `done.js` | the completion screen and the save to D1 |
| `live.js` | ephemeral-token fetch, the Gemini Live WebSocket, server-message loop, and the session cost caps (90 s idle / 10 min hard) |
| `test-mode.js` | the `?test=1` clip injector for demos and QA |
| `main.js` | boot flow, mic-button behavior, lifecycle events, mini-bar |

## The life of a voice turn

1. `main.js#begin()` fetches a single-use ephemeral token (`/api/token`) and
   opens the WebSocket **directly to Google** — the API key never reaches the
   browser, and audio never touches our server.
2. `audio.js` streams 16 kHz PCM frames; the noise gate and echo suppressor
   decide which frames are really the user (a cough doesn't interrupt the
   agent; a person saying "wait—" does).
3. The model calls `set_field` the moment it understands a value; `tools.js`
   dispatches it, `form.js#setField` paints it, and the tool **response tells
   the model what deterministic code concluded** — "confirmed", or exactly what
   is wrong and what to ask for next.
4. Addresses take a detour: `tools.js#verifyAddress` peels any apartment unit,
   asks `/api/geosearch` (NYC Planning Labs' geocoder), and either confirms the
   canonical borough-qualified address or surfaces lettered candidates the user
   can tap or say. The borough is never invented.
5. `submit_form` is refused until every field passes `form-state.js#isFilled`
   — the gate does not depend on the model having read anything back.

Manual typing joins the same loop from the other side: edits update state,
addresses get the same geosearch verification, and a quiet context note tells
the model the field is handled so it stops asking.

## The backend (`functions/api/`)

Four Pages Functions, all small, all readable in one sitting:

- `token.js` — mints single-use ephemeral Gemini tokens; per-IP rate limit
  backed by D1 that **degrades open** (a broken limiter must never take down
  the thing it protects)
- `geosearch.js` — the address verdict engine (confirmed / ambiguous /
  not-found) over Planning Labs Pelias, with an OSM Nominatim fallback and an
  honest `degraded` soft-confirm when both geocoders are down
- `submit.js` — parameterized D1 insert + best-effort Telegram ping
- `log.js` — fail-safe telemetry sink (always 200; salted-hash IPs, coarse geo)

`serve.py` mirrors enough of this locally (token, geosearch, submit, log) to
run the whole app with nothing but `uv run serve.py`.

## Local tooling (`tools/`)

`dashboard.py` (session replay UI in `dashboard.html`), `view_sessions.py`,
and `view_submissions.py` all read the remote D1 through the already-
authenticated `wrangler` CLI via shared `d1.py` — no API tokens on disk. The
database name has one source of truth: `wrangler.jsonc`.

## Testing

Two layers, one principle — **test the shipped thing, not a copy**:

- Unit: `npm test` imports `public/js/validators.js` itself under Node;
  `uv run pytest` runs the identical fixture cases
  (`tests/fixtures/validator-cases.json`) against the Python ports, so the
  eval harness cannot silently drift from the app. Contract tests pin the
  tool enum to `FIELDS` and the prompt's load-bearing guardrail sentences.
- Eval: `tests/` streams a TTS-rendered spoken corpus through real voice
  backends against the live prompt/tools/validators — see
  [tests/REPORT.md](tests/REPORT.md).

## Why no framework

The complexity here is a realtime audio/WebSocket state machine — worklets,
echo calibration, tool dispatch — none of which a UI framework helps with; the
visible UI is eight fields and a card. Native modules keep the payload small
for the phones and slow connections this exists to serve, keep every line
auditable (there is no generated code), and keep the barrier to running it at
"a static file server."
