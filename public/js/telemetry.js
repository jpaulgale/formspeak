// Telemetry → batched POST /api/log (server adds IP-hash + geo).
//
// The whole voice session lives in this browser (the WebSocket goes straight to
// Google), so nothing about HOW people use the form reaches the server on its
// own. This streams the session — ws lifecycle + close codes, every tool call
// and its outcome, raw transcripts per turn, errors, and a final snapshot on
// unload — so non-submissions can be reviewed and stuck points spotted.
// Fail-safe: never throws, never blocks.

// ?test=1 → this is a QA/demo run: the session id gets a "test-" prefix, which
// log.js / serve.py turn into sessions.is_test=1 so analytics can exclude it.
export const IS_TEST = new URLSearchParams(location.search).has("test");
export const SESSION_ID =
  (IS_TEST ? "test-" : "") +
  ((crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(16).slice(2));

export const tlog = {
  q: [],
  seq: 0,
  timer: null,
  startSent: false,
  push(type, data) {
    try {
      this.q.push({ seq: this.seq++, type, ts: Date.now(), data: data || {} });
      if (this.q.length >= 20) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 4000);
    } catch {}
  },
  flush(useBeacon) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.q.length) return;
    const batch = this.q.splice(0, this.q.length);
    const body = JSON.stringify({ sessionId: SESSION_ID, events: batch });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon("/api/log", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  },
};

export const logEvent = (type, data) => tlog.push(type, data);
