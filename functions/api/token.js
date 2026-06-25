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

export const onRequestPost = async (ctx) => {
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
