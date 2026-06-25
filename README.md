# Ramble Form 🎙️

Talk-to-fill identity form, à la Todoist **Ramble** — but instead of capturing
tasks, the user rambles their **first name, last name, address, date of birth,
and SSN** and the form fills in **live as they speak**. They can correct
themselves at any time ("no, it's B as in boy") and watch the field update in
real time. When all five fields are filled, the assistant reads everything back
and only submits after the user **says "yes"** out loud.

Built on the **Gemini Live API** (`gemini-3.1-flash-live-preview`): raw 16 kHz
PCM audio streams straight to the model, which does speech recognition + intent
+ tool-calling in a single pass — no separate transcribe step. The model drives
the UI by calling two tools:

- `set_field(field, value)` — fills/corrects a field the instant it's understood
- `submit_form()` — only after the user verbally confirms; the confirmed record
  is then POSTed to `/api/submit` and written to **Cloudflare D1**.

## Persistence (Cloudflare D1)

Confirmed submissions are saved to the D1 database **`ramble-form-hackathon`**
(`46c788e1-0c46-4a54-ac2d-5b344a5304d6`), table `submissions`. `serve.py` writes
via the already-authenticated `wrangler` CLI (no extra API token needed).

```bash
# inspect what's been captured
npx wrangler d1 execute ramble-form-hackathon --remote \
  --command "SELECT * FROM submissions ORDER BY created_at DESC;"
```

## Noisy rooms: the noise gate

If background noise (fans, AC, distant chatter) is disrupting capture, the app
already handles it two ways, no setup required:

1. **Auto-calibrated client noise gate** — the first ~1s after the mic starts
   measures your room's noise floor; quieter frames are then never streamed to
   the model (with a short tail so word-endings aren't clipped). Tune via the
   `GATE_*` constants near the top of the `<script>` in `index.html`
   (`GATE_MARGIN` is the main knob — raise it if noise still leaks through).
2. **Gemini VAD** set to `startOfSpeechSensitivity: LOW` so faint onsets don't
   trigger a turn.

## Run

```bash
uv run serve.py
open http://localhost:8000
```

Tap **"Tap to start"**, allow the mic, and start talking.

> **Mic + browser:** open over `http://localhost` (mic is allowed on localhost).
> Chrome works best for the AudioWorklet PCM pipeline.

## API key

`serve.py` looks for `GEMINI_API_KEY` in this order:

1. `$GEMINI_API_KEY` / `$GOOGLE_API_KEY`
2. `./.env`  (`GEMINI_API_KEY=...`)
3. `../../ev-storefront/storefront-updater-airtable-worker/.dev.vars` *(auto-reused)*

The key never reaches the browser — `serve.py` mints a single-use **ephemeral
token** per session, and the browser opens the WebSocket to Google directly with
that token.

## Files

```
ramble-form/
  serve.py     # uv PEP-723 script: serves index.html + mints ephemeral tokens
  index.html   # everything else — Typeform-style UI, Live client, audio worklets (inline)
```

## UX notes

- **Typeform-style:** one big question at a time, mobile-first, with a large
  "talk to answer" mic button (tap to pause/resume) and a live audio-level ring.
- **Live correction visibility:** the review rail at the bottom always shows all
  five fields; whichever one changes **flashes** so errors are caught instantly.
- **SSN** is masked (`•••-••-1234`) with a per-field show/hide toggle.

## Demo data only

This streams PII (incl. SSN) to the Gemini Live API for the demo. Use **fake
data**. For production you'd add masking-at-source, consent, retention controls,
and an audit trail.
