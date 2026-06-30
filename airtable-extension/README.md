# FormSpeak for Airtable 🎙️

A **schema-driven** voice + typed form that runs as a custom **Airtable Interface
Extension** (the `interface-alpha` SDK — React 19 + Tailwind, plain HTML, no SDK
UI components). It:

1. **Reads a table's field schema** — iterates `sourceTable.fields` and renders
   each writable field as the right control (text, number, single/multi‑select,
   date, checkbox, barcode). Computed and structurally‑complex fields are
   detected and skipped.
2. **Lets the user fill it by TALKING** — the Gemini Live API does speech
   recognition + intent + tool‑calling in one pass and fills fields live — **or
   by typing.**
3. **Submits as a record** to the submission table via `createRecordAsync`,
   permission‑checked first.

The Gemini context is built **dynamically at every connect** from the live field
schema and the current user's name (`session.currentUser.name`) — so adding or
renaming a field, or editing a single‑select's options, changes what the model
understands with no code change.

> **On "fields in view order":** the interface‑alpha SDK exposes **no
> view‑metadata API** (there is no `useViewMetadata`), so view‑specific ordering
> / visibility can't be read. This extension uses the configured **table's field
> order** (`table.fields`) as the schema — the closest the SDK supports — and the
> builder controls inclusion by exposing tables/fields to the extension and by
> picking the source table in the properties panel.

---

## Setup (Interface Extension)

You build this in **Builder Hub**, run it locally with the Blocks CLI, then load
it into an Interface page in Develop mode. (Full walkthrough mirrors the toolkit
SKILL.md.)

1. **Builder Hub → Extensions → Create new extension → Interface** → start from
   *Hello world (JavaScript)*. Copy the `block init` command (it has your
   **Block ID**, `blk…`).
2. **Create a Personal Access Token** (Builder Hub → Personal access tokens)
   with scopes `data.records:read`, `data.records:write`, `schema.bases:read`,
   `block:manage`, and access to your base. Copy it (`pat…`, shown once).
3. **Initialize the project** with the copied command, then replace its
   `frontend/` + config with the files in this folder (or copy these files into
   the scaffolded project). Install deps:
   ```bash
   npm install
   ```
4. **Create `.airtableblocksrc.json`** (gitignored — holds your PAT):
   ```json
   { "airtableApiKey": "patYOUR_TOKEN", "airtableBaseId": "appYOUR_BASE_ID" }
   ```
5. **Run the dev server:**
   ```bash
   npx block run          # http://localhost:9000  (leave running)
   ```
6. **Add to an Interface:** open your base → **Interfaces** → a **Custom** layout
   (full page) or a **Dashboard → + → Custom** element → select this extension →
   click **`</> Develop`** to load your local code. Accept the self‑signed‑cert
   prompt if shown, then **Reload extension**.
7. **Configure** in the right‑hand **properties panel**:
   - **Form source table** — its fields become the form.
   - **Submission table** — where a record is created (blank → the source
     table; if different, fields map **by name**).
   - **Gemini token endpoint** — server that mints Live tokens (defaults to the
     deployed FormSpeak endpoint).
8. **Release** when ready:
   ```bash
   echo "Initial release" | npx block release
   ```

---

## ⚠️ Microphone in an interface extension (the important caveat)

Interface extensions run in a **sandboxed, cross‑origin iframe**. Browsers only
allow `getUserMedia()` (microphone) in a cross‑origin iframe when the embedding
page delegates it via `allow="microphone"` (Permissions‑Policy). Airtable does
**not** delegate the microphone to extension iframes, so **in‑extension voice
capture is typically blocked** (script injection and `fetch`/WebSocket work
fine; device permissions are the exception).

This extension **degrades gracefully** rather than breaking:

- The **typed, schema‑driven form always works** in‑extension and creates the
  record — voice is a *progressive enhancement*.
- The mic is feature‑detected, and the first real `getUserMedia` rejection is
  caught as a typed `MicUnavailableError`, flipping the panel to a fallback that
  links out to **open FormSpeak in its own browser tab** (where the mic works),
  instead of throwing a raw `NotAllowedError`.

---

## Security model

- **No API key in the browser.** The client `POST`s the configured **token
  endpoint**, which mints a single‑use, short‑lived **ephemeral token**; the
  WebSocket opens directly to Google with that token. (`functions/api/token.js`
  in this repo is exactly that endpoint, rate‑limited per IP.)
- **Session‑cost caps.** Idle (90s of silence) and hard (10 min) timers close
  the billable socket so an abandoned tab can't burn quota.
- **Writes are permission‑checked.** Submit calls
  `hasPermissionToCreateRecords([{fields}])` before `createRecordAsync`, and only
  writes supported, non‑computed fields.
- **Values are coerced per field type** (`schema.js`): selects snap to existing
  option names; numbers/dates are parsed — so the model can't write malformed
  cell values.
- `.airtableblocksrc.json` (your PAT) is gitignored.

---

## Interface Extensions SDK conventions used here (per SKILL.md)

- **Imports only** from `@airtable/blocks/interface/ui` and
  `@airtable/blocks/interface/models` — never `@airtable/blocks/ui|models`.
- **Entry point:** `initializeBlock({interface: () => <App/>})` (the `{interface:}`
  wrapper is required — `initializeBlock(() => …)` renders nothing).
- **No SDK UI components** — plain `<div>/<input>/<select>/<button>` styled with
  the Airtable Tailwind design tokens (`bg-blue-blue`, `text-gray-gray500`, …).
- **Config via `useCustomProperties`** (not `useGlobalConfig`); the
  `getCustomProperties` function is **module‑scoped** for stable identity.
- **Field types** via `field.config.type` against the `FieldType` enum; choices
  via `field.options?.choices`. There's no `field.isComputed`, so computed types
  are enumerated.
- **Writes** are typed cell‑value shapes: single‑select → `{name}`,
  multi‑select → `[{name}]`, date → `"YYYY‑MM‑DD"`, number → `Number`,
  checkbox → `boolean`, barcode → `{text}`.
- **React 19**, Tailwind via PostCSS; `style.css` holds the `@tailwind`
  directives and is imported from `index.js`.

## Files

```
airtable-extension/
  block.json            # {"version":"1.0","frontendEntry":"./frontend/index.js"}
  package.json          # @airtable/blocks: interface-alpha, react 19, tailwind
  tailwind.config.js    # Airtable design tokens
  postcss.config.js     # tailwind + autoprefixer
  frontend/
    index.js            # initializeBlock({interface}) + App: form, voice, submit
    config.js           # getCustomProperties (source/submit table, token URL)
    schema.js           # field.config.type → input + writable cell-value coercion
    geminiContext.js    # builds the system instruction + tools FROM the live schema
    geminiLive.js       # robust Gemini Live transport (ws + audio + caps + mic detect)
    useGeminiLive.js    # React glue around the session
    worklets.js         # inline 16 kHz capture / 24 kHz playback AudioWorklets
    style.css           # @tailwind base/components/utilities
```

> Voice modules (`geminiLive.js`, `worklets.js`, `geminiContext.js`,
> `useGeminiLive.js`) use only browser APIs — no Airtable SDK import — so they're
> independent of the SDK version.
