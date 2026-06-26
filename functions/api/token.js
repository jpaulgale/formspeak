// POST /api/token — mint a short-lived *ephemeral* token for the Gemini Live API
// so the browser can open the WebSocket directly to Google without ever seeing the
// real API key. Mirrors the Python serve.py get_ephemeral_token().
//
// REST call equivalent of the google-genai `client.auth_tokens.create(...)`:
//   POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens
//   header x-goog-api-key: <GEMINI_API_KEY>
//   body { uses, expireTime, newSessionExpireTime }
// The response's `name` is the token the client uses as ?access_token=...
const ENDPOINT = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";

const RL_LIMIT = 10;        // max token mints per IP per window
const RL_WINDOW_MS = 60000; // 1-minute window

export const onRequestPost = async (ctx) => {
  // Per-IP rate limit on the expensive path. Each token opens a Gemini Live session,
  // and there's no password gate anymore, so this is what stops one source from
  // spinning up sessions in a loop and burning the shared free-tier quota. Backed by
  // D1 (the `ratelimits` binding isn't supported on Pages). Degrades OPEN on any DB
  // error so the limiter can never take the endpoint down.
  const ip = ctx.request.headers.get("CF-Connecting-IP") || "anon";
  if (ctx.env.DB) {
    const bucket = Math.floor(Date.now() / RL_WINDOW_MS);
    try {
      const row = await ctx.env.DB.prepare(
        `INSERT INTO token_rate_limit (ip, bucket, count) VALUES (?1, ?2, 1)
         ON CONFLICT(ip, bucket) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(ip, bucket).first();
      if (row && row.count > RL_LIMIT) {
        return Response.json(
          { error: "Too many sessions from your network just now — give it a minute and tap the mic again." },
          { status: 429 },
        );
      }
      // Opportunistically sweep stale buckets so the table can't grow without bound.
      if (ctx.waitUntil && Math.random() < 0.1) {
        ctx.waitUntil(
          ctx.env.DB.prepare(`DELETE FROM token_rate_limit WHERE bucket < ?1`)
            .bind(bucket - 5).run().catch(() => {}),
        );
      }
    } catch { /* degrade open — never block token minting on a limiter failure */ }
  }

  const key = ctx.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: "No GEMINI_API_KEY configured on the server." }, { status: 500 });
  }

  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const body = {
    uses: 1,
    expireTime: iso(30 * 60 * 1000),        // token valid to create a session for 30 min
    newSessionExpireTime: iso(2 * 60 * 1000), // must start the session within 2 min
  };

  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name) {
      const detail = j?.error?.message || `status ${r.status}`;
      return Response.json({ error: "token mint failed: " + detail }, { status: 500 });
    }
    return Response.json({ token: j.name });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
};
