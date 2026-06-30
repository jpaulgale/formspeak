# FormSpeak for Airtable 🎙️

A **schema-driven** voice + typed form that lives inside Airtable as a custom
extension (Blocks SDK). It:

1. **Reads a view's field schema** — `useViewMetadata(view).visibleFields` gives
   the fields **in the exact order they appear in the view**.
2. **Renders each field as a form control**, picking the right input per field
   type (text, number, single/multi‑select, date, checkbox, …).
3. **Lets the user fill it by talking** — the Gemini Live API does speech
   recognition + intent + tool‑calling in one pass and fills fields live.
4. **Submits as a record** to the submission table via `createRecordAsync`.

The Gemini context is built **dynamically at every connect** from the live
schema and the current user's name (`session.currentUser.name`) — so renaming a
field, reordering the view, or editing a single‑select's options changes what
the model understands with no code change.

---

## Setup

```bash
cd airtable-extension
npm install
# point the CLI at a new/existing custom extension in your base, then:
npm start          # block run  → live-reload dev server
npm run release    # block release → publish to the base
```

To create the extension slot: in your base open **Extensions → Add an extension
→ Build a custom extension**, give it a name, and follow the CLI's
`block init`/`add-remote` prompt (this writes a gitignored `.block/remote.json`
with your base + block id). Then `npm start` and open the extension.

### Configure (gear icon / Settings)

| Setting | What it does |
|---|---|
| **Form source view** | The view whose visible fields (in order) become the form. |
| **View** | Which view of that table to read the schema from. |
| **Submission table** *(optional)* | Where a submitted record is created. Blank → the source view's own table. If different, fields map **by name**. |
| **Gemini token endpoint** | Server URL that mints short‑lived Gemini Live tokens. Defaults to the deployed FormSpeak endpoint. |

---

## ⚠️ Microphone in a custom extension (the important caveat)

Airtable extensions run in a **sandboxed, cross‑origin iframe**. Browsers only
allow `getUserMedia()` (microphone) in a cross‑origin iframe when the embedding
page delegates it via `allow="microphone"` (Permissions‑Policy). Airtable does
**not** delegate the microphone to extension iframes, so **in‑extension voice
capture is typically blocked.**

This extension is built to **degrade gracefully** rather than break:

- The **typed, schema‑driven form always works** inside the extension and
  creates the record — voice is a *progressive enhancement*.
- The mic is **feature‑detected** (`micPlausiblyAvailable`) and the first real
  `getUserMedia` rejection is caught and surfaced as a typed
  `MicUnavailableError`, flipping the UI to a fallback that offers a link to
  **open FormSpeak in its own browser tab** (where the mic works), instead of
  throwing a raw `NotAllowedError`.

If you control the deployment and *can* run the voice experience where the mic
is delegated (e.g. the standalone web app at the token endpoint's origin), point
users there for the full talk‑to‑fill flow; the extension remains the
schema‑driven typed form + submission surface.

---

## Security model

- **No API key in the browser.** The client never sees `GEMINI_API_KEY`. It
  `POST`s the configured **token endpoint**, which mints a single‑use,
  short‑lived **ephemeral token**; the WebSocket then opens directly to Google
  with that token. (The repo's `functions/api/token.js` is exactly this
  endpoint, rate‑limited per IP.)
- **Session‑cost caps.** An idle timeout (90s of silence) and a hard wall‑clock
  cap (10 min) close the billable socket so an abandoned tab can't burn quota.
- **Writes are permission‑checked.** Every submit calls
  `hasPermissionToCreateRecord(fields)` before `createRecordAsync`, and only
  ever writes **writable** fields (computed fields are skipped via
  `field.isComputed`).
- **Values are coerced per field type** (`schema.js`) — selects snap to existing
  option names, numbers/dates are parsed — so the model can't write malformed
  cell values.

---

## Airtable Blocks SDK conventions used here ("esoteric JS")

These are the non‑obvious rules this extension follows — worth knowing if you
extend it:

- **One entry point.** `initializeBlock(() => <App/>)` is the whole bootstrap;
  there is exactly one call, at the bottom of `index.js`.
- **Everything reactive is a hook.** `useBase`, `useSession`, `useGlobalConfig`,
  `useViewMetadata`, `useSettingsButton`, `useRecords` — you never read the
  models imperatively for rendering; the hooks re‑render on change. Reaching
  outside React (polling, manual watchers) is the anti‑pattern.
- **Loadable models must load.** `useViewMetadata` handles loading internally
  and exposes `visibleFields` once ready (guard for the brief `null`).
- **Config is `globalConfig`.** Shared, synced settings live in `globalConfig`
  (`*Synced` pickers write straight to it); guard edits with
  `globalConfig.hasPermissionToSet()`.
- **Writes are async + permission‑gated.** `await table.createRecordAsync(...)`
  after `table.hasPermissionToCreateRecord(...)`. Cell values are **typed
  shapes**, not strings: single‑select → `{name}`, multi‑select → `[{name}]`,
  date → `"YYYY-MM-DD"`, number → `Number`, checkbox → `boolean`, barcode →
  `{text}`.
- **React 16.** The SDK bundles React 16.14; hooks are fine, but no React‑18‑only
  APIs.
- **Cross‑origin iframe.** External `fetch`/WebSocket work; the bundle is served
  from Airtable's origin; `AudioWorklet` via `Blob` URL works — but device
  permissions (mic) are gated as described above.

## Files

```
airtable-extension/
  block.json            # Blocks manifest → frontend entry
  package.json          # @airtable/blocks + react 16 + blocks-cli
  frontend/
    index.js            # initializeBlock + App: schema-driven form, voice, submit
    settings.js         # globalConfig settings (source view, submit table, token URL)
    schema.js           # field type → input + writable cell-value coercion
    geminiContext.js    # builds the system instruction + tools FROM the live schema
    geminiLive.js       # robust Gemini Live transport (ws + audio + caps + mic detect)
    useGeminiLive.js    # React glue around the session
    worklets.js         # inline 16 kHz capture / 24 kHz playback AudioWorklets
```
