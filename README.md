# FormSpeak 🎙️

**A form that fills itself out as you speak to it.**

A SNAP (food assistance) benefits form you complete by talking — in any order,
in any language, correcting yourself as you go. Not a chatbot: a real form with
real fields you can see, tap, and type into. The voice agent helps with the
form; it never becomes the form.

**[Try it live →](https://formspeak.pages.dev)** · **[Case study →](#case-study)**
· **[Voice-backend evaluation →](tests/REPORT.md)**

Built in a few hours at the NYC State Capacity AI Hackathon (hosted by Civic
Roundtable and CUNY PIT Lab), then hardened over the following weeks against
real sessions from strangers on the internet.

---

## Why

Filling out forms is a pain no matter who you are. For many people they're a
serious obstacle to crucial services like housing, healthcare, or SNAP. Forms
either don't get filled out at all, or the work falls to overwhelmed helpers —
children translating for their parents at the doctor's office, caseworkers
piecing together a situation before another back-to-back appointment.

Voice models now handle casually-delivered information remarkably well. If
you're impatient, not especially tech-savvy, or more comfortable in another
language, a conversation should be able to become a completed form.

## The design rule

**The form stays a form.** That single constraint produced three input modes
that coexist on one screen:

- **Dictation** — say a value, watch the field fill the moment it's understood
- **Conversation** — ask questions, get clarification, correct yourself, wander
- **Manual editing** — tap any field and just type

Each mode covers the others' weaknesses. Most of the engineering is about
keeping the three in sync.

## How it works

Raw 16 kHz PCM audio streams from the browser straight to the **Gemini Live
API** (`gemini-3.1-flash-live-preview`), which does speech recognition, intent,
and tool-calling in a single pass — no separate transcription step to lag
behind. The model drives the UI through exactly two tools:

- `set_field(field, value)` — fills or corrects a field the instant a value is
  understood. The system prompt **forbids the model from waiting**: no "got it,
  what's next?" ceremony. The live-updating field *is* the feedback loop.
- `submit_form()` — allowed only after all eight values are read back aloud and
  the user verbally confirms.

Eight fields: first name, last name, NYC address, date of birth, phone,
household size, monthly household income, preferred notice language.

## Making it trustworthy

A demo that fills a form is easy. A demo you'd let fill a *government benefits*
form has to earn it, because the signature failure mode of language models is
confident, plausible invention.

**Addresses are verified, not transcribed.** Every spoken address is checked
against [NYC Planning Labs' official geocoder](https://geosearch.planninglabs.nyc).
The borough is never invented — it comes from the match. When an address exists
in multiple boroughs (spoken addresses often do), up to four candidates appear
as lettered buttons while the agent reads them aloud: *"Is that A, Manhattan,
or B, Brooklyn?"* Answer by voice or by tap. The ear is bad at comparing
similar options; the eye is great at it.

**Deterministic systems handle truth; the model handles language.** The
geocoder would happily autocomplete `"125"` into the very real-sounding
"125 Beach 125 Street" — an address the user never said. So the agent must
collect a house number *and* a street name before it can look anything up. Same
discipline for phone numbers: real sessions caught the model "helpfully"
zero-padding partial numbers out to ten digits, so inventing digits is now
explicitly forbidden and every value passes through validation that talks back.

**Dependencies fail gracefully and honestly.** When the geocoder is
unreachable, the form doesn't block — it soft-accepts what the user said, flags
the record as unverified in telemetry, and moves on. A tool for people who find
forms hard should never strand them because a third-party API had a bad minute.

**Nothing submits without consent.** All eight values are read back aloud, and
only an explicit verbal "yes" triggers submission.

## Accessibility

Accessibility is the premise of the project, not a retrofit:

- **The form is a good form with the sound off** — proper autocomplete
  semantics for assistive tech, live regions for captions, and copy that says
  "tap" on phones and "click" on desktops
- **Language is fluid** — nine notice languages (English, Spanish, Chinese,
  Bengali, Russian, Haitian Creole, Korean, Arabic, Yiddish, plus Other). Start
  speaking Spanish or Russian or Haitian Creole and the agent switches and
  carries the whole conversation there
- **The demo teaches by example** — a "try saying" prompt models the behaviors
  people don't expect to work: answering out of order, correcting a spelling
  after the fact
- **It works on real phones** — barge-in (interrupting the agent mid-sentence)
  is the least glamorous work here and mattered most. On phones playing through
  the loudspeaker, browser echo cancellation often fails to cancel the app's own
  output; the model hears itself and interrupts itself into an endless stutter.
  A small acoustic echo suppressor measures speaker-to-mic bleed, calibrates
  during the opening greeting, and requires real interruptions to sustain above
  that floor for ~190 ms. A cough doesn't cut the agent off; a person saying
  "wait—" does.

> Not independently audited against WCAG 2.1 AA / Section 508. The work above is
> described as built, not as certified.

## Testing

`tests/` is a voice-backend evaluation harness, not a unit-test suite:

- `scenarios.py` — scripted conversations covering the happy path plus the edge
  cases the system prompt guards against: spelling corrections, ambiguous NYC
  addresses, apartment preservation, partial phone digits, out-of-range DOB,
  household phrasing, unlisted languages, premature submit
- `make_corpus.py` — renders every turn to 16 kHz WAV via TTS, cached by content hash
- `formspeak_env.py` — a "virtual browser" that extracts the **live** system
  instruction from `public/js/prompt.js` at runtime, ports its validators, and
  reproduces the real tool-response strings. Address checks hit the real
  geocoder endpoint.
- `score.py` — grades per-turn expectations, final form state, submit
  guardrails, and latency

There are also plain unit tests, and they run against the shipped code, not a
copy: `npm test` imports `public/js/validators.js` under Node, and
`uv run pytest` runs the **same** cases (`tests/fixtures/validator-cases.json`)
against the Python ports — a case failing on one side but not the other means
the eval harness has drifted from the app.

**[tests/REPORT.md](tests/REPORT.md)** is the writeup: a head-to-head of Gemini
Live vs. `gpt-realtime-2.1` vs. a LiveKit STT→Gemma pipeline, with identical
prompt, tools, and validation across all three legs — accuracy, guardrail pass
rates, latency, cost per session, and data posture.

## Observability

Every session streams its events — transcripts, tool calls, connection drops —
to a small database. `tools/dashboard.py` replays any session as a chat transcript:
user and assistant bubbles, every tool call with its outcome, problems flagged
in red. Nearly every post-launch fix traces back to a replayed session.

## Run it

```bash
echo "GEMINI_API_KEY=your-key" > .env
uv run serve.py
open http://localhost:8000
```

Tap **"Tap to start"**, allow the mic, and start talking.

> Open over `http://localhost` — microphone access is allowed there without
> HTTPS. Chrome works best for the AudioWorklet PCM pipeline.

### Persistence

Confirmed submissions are written to Cloudflare D1 (table `submissions`).
To run your own copy, create a database and put its ID in `wrangler.jsonc`:

```bash
npx wrangler d1 create <your-database-name>
npx wrangler d1 execute <your-database-name> --remote --file schema.sql
```

## Layout

```
public/
  index.html        markup only — the app boots from js/main.js
  js/               native ES modules: config, prompt, validators, audio
                    (echo suppression), live session, form, card, tools…
  worklets/         AudioWorklet processors (16 kHz capture, 24 kHz playback)
  styles.css
functions/api/      Pages Functions — token minting, geosearch, submit, telemetry
serve.py            local dev server + ephemeral token minting
tools/              local admin — session-replay dashboard, D1 views (shared d1.py)
tests/              voice-backend eval harness (see REPORT.md) + unit tests
schema.sql          D1 schema
migrations/
```

No framework, no build step — the browser loads the modules natively, and a
`modulepreload` manifest keeps the graph a single parallel fetch. Each module
owns one subsystem and is readable on its own; **[ARCHITECTURE.md](ARCHITECTURE.md)**
has the module map and the data flows.

## How this was built

I built FormSpeak to test a conviction: an agent belongs inside a conventional
interface, as a collaborator — not as a replacement for it. The model does the
one thing it's uniquely good at, which is understanding messy, multilingual,
out-of-order human speech. Deterministic systems decide what's true. The
interface keeps every value visible and editable, and the person always has
the final say.

The product decisions are mine — the form stays a form, the model may not
wait, addresses come from the city's geocoder or not at all, the SSN field got
deleted. So are the failure modes: nearly every fix here traces to a replayed
session of a real stranger using the demo, and the evaluation that chose the
voice backend is mine too.

> The code and much of this documentation were generated with Claude Code,
> working under my direction — and thoroughly tested over the course of the
> week after the hackathon before anything shipped.

## Case study

A longer writeup of the design decisions, failure modes, and what a small demo
taught me about how voice agents and traditional interfaces should share a
screen — including the subtle bug where a user types a correction and the agent,
unaware, keeps asking for information that's already on screen. (If an AI agent
and a person share an interface, every change either of them makes has to be
visible to both — otherwise you don't have collaboration, you have two users
fighting over one document.)

## Credits

Thanks to Tal Roded, Henry Grunzweig, and Jeremie Ponak for organizing the
State Capacity AI Hackathon, and to Civic Roundtable and CUNY PIT Lab for
hosting.

Built by [Paul Gale](https://paulgale.dev).
