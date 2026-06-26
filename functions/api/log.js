// POST /api/log — receive a batch of client telemetry events and persist them to D1.
// The browser owns the whole Gemini Live session (the WebSocket goes straight to
// Google), so the server never sees transcripts or tool calls on its own — the client
// streams them here in batches instead. We enrich each batch server-side with the
// caller's hashed IP + Cloudflare geo so abandoned sessions can be reviewed and grouped
// into anonymized profiles.
//
// Fail-safe by design: always returns 200 with {ok:...} so a logging hiccup can never
// surface as an error in the user's voice flow. Accepts both fetch() (application/json)
// and navigator.sendBeacon() (which may send text/plain) payloads.

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ok = (extra) => Response.json({ ok: true, ...extra });
const soft = (extra) => Response.json({ ok: false, ...extra }); // still 200 — never break the client

export const onRequestPost = async (ctx) => {
  const { request, env } = ctx;
  if (!env.DB) return soft({ error: "no DB binding" });

  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return soft({ error: "bad json" });
  }

  const sessionId = String(body?.sessionId || "").slice(0, 64);
  const events = Array.isArray(body?.events) ? body.events.slice(0, 200) : [];
  if (!sessionId || !events.length) return ok();

  // Identity: salted hash of the edge-provided client IP (never the raw IP), plus
  // coarse geo + UA. Set LOG_SALT as a secret so hashes aren't guessable/portable.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const salt = env.LOG_SALT || "formspeak-default-salt";
  const ipHash = ip ? (await sha256hex(salt + "::" + ip)).slice(0, 32) : "";
  const cf = request.cf || {};
  const ua = (request.headers.get("User-Agent") || "").slice(0, 300);

  const submitted = events.some(
    (e) =>
      e?.type === "submit_saved" ||
      (e?.type === "tool_call" && e?.data?.name === "submit_form" && e?.data?.result === "submitted"),
  )
    ? 1
    : 0;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO sessions (session_id, ip_hash, country, region, city, colo, user_agent, event_count, submitted)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen   = datetime('now'),
         event_count = event_count + ?,
         submitted   = MAX(submitted, ?)`,
    ).bind(
      sessionId,
      ipHash,
      cf.country || "",
      cf.region || "",
      cf.city || "",
      cf.colo || "",
      ua,
      events.length,
      submitted,
      events.length,
      submitted,
    ),
  ];

  for (const e of events) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (session_id, seq, type, payload, client_ts) VALUES (?,?,?,?,?)`,
      ).bind(
        sessionId,
        Number(e?.seq) || 0,
        String(e?.type || "").slice(0, 40),
        JSON.stringify(e?.data ?? {}).slice(0, 20000),
        Number(e?.ts) || null,
      ),
    );
  }

  try {
    await env.DB.batch(stmts);
  } catch (err) {
    return soft({ error: "d1 write failed", detail: String(err?.message || err) });
  }
  return ok({ stored: events.length });
};
