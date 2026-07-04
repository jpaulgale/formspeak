June 2026 · Case Study

# FormSpeak: A Form That Fills Itself Out as You Speak

An experimental accessibility demo built in a few hours at the NYC State Capacity AI Hackathon, then refined over a weekend into something strangers could try to break: a benefits form you complete by talking — in any order, in any language, correcting yourself as you go.

[Try it live →](https://formspeak.pages.dev)

8 fields, filled in any order

9+ languages

1 HTML file, no framework

42 commits over 4 days

## Summary

At a GovTech hackathon focused on state capacity, I built FormSpeak: a SNAP (food assistance) application form with a voice agent attached. You can ramble, answer out of order, or correct yourself mid-sentence ("no, G-A-L-E, and that address is in Brooklyn"), and the fields update live as you speak. When everything's filled, the agent reads it all back and only submits after you say yes.

The hackathon version worked. What made the project interesting was the weekend after, when I put it in front of strangers on the internet and used session telemetry to find everything that didn't.

**This case study is about that process** — the design decisions, the failure modes, and what a small demo taught me about how voice agents and traditional interfaces should share a screen.

---

## The Problem

Filling out forms is a pain no matter who you are. But for many people, they're a serious obstacle to crucial services like housing, healthcare, or SNAP. Forms either don't get filled out at all, or the work falls to overwhelmed helpers — children translating for their parents at the doctor's office, caseworkers trying to piece together a situation before another back-to-back appointment.

Meanwhile, the latest voice-driven AI models process casually-delivered information remarkably well. If you're impatient, not especially tech-savvy, or more comfortable in another language, **a simple conversation should be able to become a completed form.**

The question is what that interface actually looks like.

## Where the Idea Came From

Good ideas have a lineage, and this one is worth tracing.

It starts with **Ramble**, Todoist's voice-capture feature: you talk freely — half-formed, out of order, thinking out loud — and it turns the mess into structured tasks. I'd read Google's Gemini case study on it and listened to a podcast conversation with the developers behind it, and the thing that stuck with me was how *forgiving* it was. No commands, no dictation posture. You ramble; structure comes out the other side.

I borrowed that pattern for a client project first: a **Brain Dump** feature in a storefront-management system I built for an EV dealership. Instead of clicking through records to make updates, staff could just talk through what changed and let the system sort the ramble into structured data. It worked well enough to change how I thought about voice — not as an alternative interface, but as a faster way *into* an existing one.

The hackathon thought was one small step further: **what if I could use that to fill out a form via voice, while still retaining the typical control surface of the standard form?** Not voice replacing the form — voice layered onto it, with every field still visible, tappable, and editable underneath.

The lineage is right there in the git history: the prototype was literally named *Ramble* for its first two days, before the rename to FormSpeak.

## The Thesis: Not Another Chatbot

We're still figuring out how these new tools integrate with typical interfaces, and the default answer — wrap everything in a chat window — is often wrong. Using a chatbot to make little tweaks to a document is a frustrating waste of time.

So FormSpeak's core design rule: **the form stays a form.** Real fields you can see, tap, and edit. The voice agent helps with the form; it never becomes the form.

That rule produced three input modes that coexist on one screen:

- **Dictation** — say a value, watch the field fill the moment it's understood
- **Conversation** — ask questions, get clarification, correct yourself, wander off-topic
- **Manual editing** — tap any field and just type

Being able to bounce between all three felt, immediately, like the natural direction for this kind of interface. Each mode covers the others' weaknesses — and most of the engineering that followed was about keeping the three in sync.

## The Hackathon Build

The architecture is deliberately minimal. Raw 16 kHz PCM audio streams from the browser straight to the Gemini Live API, which does speech recognition, intent, and tool-calling in a single pass — no separate transcription step, so there's nothing to lag behind.

The model drives the UI through exactly two tools:

- `set_field(field, value)` — fills or corrects a field the instant a value is understood
- `submit_form()` — allowed only after the user verbally confirms a full read-back

That first tool encodes the most important product decision: **the system prompt forbids the model from waiting.** The moment it understands a value, it fills the field — no "got it, what's next?" ceremony. The live-updating field *is* the feedback loop. When you say "actually, B as in boy," you watch the correction land. Trust in a system like this isn't something you explain; it's something the user watches accumulate, one field at a time.

## Making It Trustworthy

A demo that fills a form is easy. A demo you'd let fill a *government benefits* form has to earn it, because the signature failure mode of language models is confident, plausible invention. Most of the post-hackathon work was building walls against that.

**Addresses get verified, not transcribed.** Every spoken address is checked against NYC Planning Labs' official geocoder. The borough is never invented — it comes from the match. When an address exists in multiple boroughs (spoken addresses often do), the agent doesn't guess: up to four candidates appear as lettered buttons on screen while the agent reads them aloud — "Is that A, Manhattan, or B, Brooklyn?" You can answer by voice or by tap. **It's my favorite moment in the demo, because it's where voice and GUI stop competing and start covering for each other:** the ear is bad at comparing similar options; the eye is great at it.

**Deterministic systems handle truth; the model handles language.** The geocoder's fuzzy search would happily autocomplete a fragment like "125" into the very real-sounding "125 Beach 125 Street" — an address the user never said. So the agent is required to collect a house number *and* a street name before it's allowed to look anything up. Same discipline for phone numbers: watching real sessions revealed the model "helpfully" zero-padding partial numbers out to ten digits, so it's now explicitly forbidden from inventing digits, and every value passes through validation that talks back — the tool response tells the model what's wrong, and the model relays it conversationally.

**Dependencies fail gracefully and honestly.** When the geocoder is unreachable, the form doesn't block on a dead dependency — it soft-accepts what the user said, flags the record as unverified in telemetry, and moves on. A demo for people who find forms hard should never strand them because a third-party API had a bad minute.

**Nothing submits without consent.** All eight values are read back aloud, and only an explicit verbal "yes" triggers submission.

## Making It Listen

The least glamorous work mattered most: making barge-in — interrupting the agent mid-sentence — actually work on real devices.

On phones playing through the loudspeaker, the browser's echo cancellation often fails to cancel the app's own audio output. The model hears itself, interprets it as the user talking, and interrupts itself into an endless stutter. The fix is a small acoustic-echo suppressor built into the mic pipeline: the app measures the speaker-to-mic bleed while the agent talks, calibrates during the opening greeting (taking the *minimum* across the first frames, because echo cancellation is still converging and the first frame lies), and then requires real interruptions to sustain above that floor for ~190 ms. A cough doesn't cut the agent off; a person saying "wait—" does.

Dozens of decisions live at this layer. The pause button doesn't just mute — it commits the turn, so half-finished audio gets processed instead of hanging. The mic is released entirely when the tab is hidden. A noise gate keeps quiet rooms from streaming silence to the API. **None of this is visible, which is exactly the point** — it's the difference between a demo that works on the builder's laptop and one that survives a stranger's phone on a windy sidewalk.

## Manual Edits Are a Conversation Too

Here's a subtle bug that says a lot about designing agentic interfaces: a user types a correction directly into a field, and the voice agent — unaware — keeps asking for information that's already on screen. The human and the agent are now working from different realities.

The fix treats the form as **shared state**: any manual edit quietly injects a note into the conversation ("[form update] last name is now Gale"), so the agent's mental model always matches the screen. And while a field has focus, the interface holds still — the spotlight card stops advancing so the form doesn't yank itself away mid-keystroke.

I think this pattern generalizes well beyond forms. If an AI agent and a person share an interface, **every change either of them makes has to be visible to both** — otherwise you don't have collaboration, you have two users fighting over one document.

## Watching Strangers Break It

After sharing the demo publicly, I needed to see what actually happened in the wild. Every session streams its events — transcripts, tool calls, connection drops — to a small database, and a local dashboard replays any session as a chat transcript: user and assistant bubbles, every tool call with its outcome, problems flagged in red. New submissions ping me on Telegram.

Nearly every post-launch fix traces back to a replayed session: the zero-padded phone numbers, the autocompleted address fragments, the self-interrupting echo loop, users typing while the agent talked past them.

Opening a GenAI demo to the public also means opening a metered API to the public, so the boring safety rails matter: the API key never reaches the browser (each session gets a single-use ephemeral token), per-IP rate limits stop anyone from burning the quota in a loop — and those limits *degrade open*, because a broken rate limiter should never take down the thing it protects. Telemetry is fail-safe in the same spirit: a logging hiccup can never surface as an error in someone's voice session.

## Details That Carry the Mission

For a tool whose whole premise is accessibility, the small choices are the product:

- **The SSN field was removed entirely** early on — a public demo shouldn't invite real Social Security numbers, full stop.
- **Language is fluid.** The form offers nine notice languages (including Yiddish), and if you simply start speaking Spanish or Russian or Haitian Creole, the agent switches and carries the whole conversation there.
- **The form is a good form even with the sound off** — proper autocomplete semantics for assistive tech, live regions for captions, and copy that says "tap" on phones and "click" on desktops.
- **The demo teaches by example.** Before you start, a "try saying" prompt models the exact behaviors people don't expect to work: answering out of order and correcting a spelling after the fact.

The whole thing is one 2,000-line HTML file and four small serverless functions — no framework, no build step, about 3,000 lines total. For an experiment like this, that's a feature: **every decision described above is readable in one sitting.**

---

## What I Took Away

There's a lot of hype about AI replacing people. My favorite tools to build (and use) do the opposite: they take something tedious or genuinely difficult and let a person get through it quickly, on their own terms.

FormSpeak's real lesson is about the division of labor. The model does what it's uniquely good at — understanding messy, multilingual, out-of-order human speech. Deterministic systems handle truth: geocoders verify addresses, validators check digits, and the model is structurally prevented from inventing either. The interface keeps all state visible and editable. And the human always has the final say.

That pattern — **agent as collaborator inside a conventional interface, not a replacement for it** — is what I'd bet on for this entire category of tools.

Thanks to Tal Roded, Henry Grunzweig, and Jeremie Ponak for putting the State Capacity AI Hackathon together, and to Civic Roundtable and CUNY PIT Lab for hosting.

FormSpeak is a demo I built in a few hours. I build production versions of tools like this for companies like IBM. If you have a project or an idea, [reach out](mailto:jpaulgale@gmail.com) — or check out my [other projects](https://paulgale.dev/#projects).
