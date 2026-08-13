// Shared session state. One mutable object, imported everywhere — the modules
// communicate through it (and through explicit function calls), never through
// globals on window.

export const state = {
  ws: null, connected: false,
  values: {},                 // key -> string
  feedbackModel: "",          // last complete feedback text the model wrote — lets us
                              // swap its contribution in place without clobbering typed text
  submitted: false,
  micOn: false,
  capCtx: null, capNode: null, micStream: null,
  playCtx: null, playNode: null,
  playInit: null,       // one-shot playback-context init promise (chunks await it; no race)
  userBuf: "", asstBuf: "",   // in-flight transcription for the current turn
  lastUser: "", lastAsst: "", // last COMPLETED turn — keeps the caption up between turns
  phase: "listening",   // listening | thinking | speaking — drives the dock status
  thinkTimer: null,
  idleTimer: null, hardTimer: null, // session cost caps (idle silence + hard backstop)
  pauseMsg: "",         // when auto-paused (idle/max), the reason shown in the paused mic label
  // --- hero-card reveal ---
  // When a value lands the card would otherwise jump straight to the next field. Instead
  // we pin it on the just-answered field and "type" the value in, so the viewer sees it
  // land. pinKey holds that field; revealN is how many chars are typed so far.
  pinKey: null, revealN: 0, revealTimer: null,
  focusKey: null,       // field the user is manually editing (has DOM focus) → the card holds
                        // on it and won't advance until they leave, even once it has a value
  addrStatus: "idle",   // idle | checking | ok | none — NYC geosearch confirmation
  addrBorough: "",
  addrUnit: "",         // apartment/unit (e.g. "#7", "Apt 6D") — geosearch can't resolve it, so we carry it ourselves
  addrVerified: "",     // canonical building address geosearch confirmed (no unit) — shown on hovering ✓ Verified
  addrSeq: 0,
  addrChoices: [],      // [{letter,full,borough}] when an address splits across boroughs
  injecting: false,     // test mode: a corpus clip owns the send path (mic frames are dropped)
  // --- noise gate ---
  gate: {
    floor: 0,       // 0 = stream everything; let Gemini's server-side VAD handle noise
    openUntil: 0,   // ms timestamp: keep streaming until this (hangover tail)
    aboveRun: 0,    // consecutive frames clearing the floor (sustained-barge-in counter)
  },
  // --- acoustic echo suppression ---
  playUntil: 0,       // ms timestamp: arrival-based estimate of when speaker emission ends
  speakerLive: false, // playback worklet's own report: sound is leaving the speaker NOW
  liveSince: 0,       // ms timestamp: when speakerLive last flipped on (seed guard)
  echo: { level: 0, seedMin: 0, seedN: 0 }, // learned RMS of the speaker→mic bleed (+ seed calibration)
};
