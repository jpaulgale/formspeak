// Password gate for the whole site (static assets + /api/*).
// In-site login page (password only — no username) backed by a cookie session,
// instead of the browser's Basic-Auth popup.
//
// Flow:
//   - No/invalid cookie + page navigation  → serve the login page.
//   - POST /__auth with the right password → set cookie, redirect back.
//   - Valid cookie                         → ctx.next() (serve the real response).
//   - No/invalid cookie + /api/* request   → 401 JSON.
const COOKIE = "fs_gate";
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Only allow same-site relative redirects (no open-redirect via "//evil.com").
function safeNext(n) {
  n = String(n || "/");
  if (!n.startsWith("/") || n.startsWith("//")) return "/";
  return n;
}

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function loginPage(next, isError) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>FormSpeak — talk to fill out your NYC benefits form</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<meta name="theme-color" content="#103FEF"/>
<meta name="description" content="Click the mic and ramble. This voice-first NYC benefits form fills in live as you speak. A State Capacity AI Hackathon demo by Paul Gale."/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://formspeak.pages.dev/"/>
<meta property="og:title" content="FormSpeak"/>
<meta property="og:description" content="Click the mic and ramble. This voice-first NYC benefits form fills in live as you speak. A State Capacity AI Hackathon demo by Paul Gale."/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="FormSpeak"/>
<meta name="twitter:description" content="Click the mic and ramble — a voice-first NYC benefits form. A State Capacity AI Hackathon demo by Paul Gale."/>
<style>
  :root { --accent:#103FEF; --accent-dark:#050560; --ink:#000; --bg:#EEEEEE; --line:#DDD; --warn:#EC131E; }
  * { box-sizing:border-box; margin:0; }
  body { min-height:100dvh; display:grid; place-items:center; padding:24px;
    background:var(--bg); color:var(--ink);
    font-family:"Noto Sans", ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .card { width:100%; max-width:380px; background:#fff; border:1px solid var(--line); border-radius:14px;
    box-shadow:0 1px 0 rgba(0,0,0,.04), 0 18px 40px -26px rgba(0,0,0,.5);
    padding:30px 26px; display:flex; flex-direction:column; gap:14px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:17px; letter-spacing:-.01em; }
  .brand .dot { width:12px; height:12px; background:var(--accent); }
  h1 { font-size:22px; font-weight:700; letter-spacing:-.01em; margin-top:4px; }
  .sub { color:#555; font-size:14px; margin-top:-6px; }
  input[type=password] { width:100%; border:1.5px solid #CCC; border-radius:8px; padding:13px 14px;
    font:inherit; font-size:16px; font-weight:600; }
  input[type=password]:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px #D7E2FF; }
  button { border:none; border-radius:99px; padding:14px; font:inherit; font-weight:700; font-size:15px;
    color:#fff; background:var(--accent); cursor:pointer; }
  button:hover { background:var(--accent-dark); }
  .err { color:#C20A12; font-size:13px; font-weight:600; }
  .sub strong { color:var(--ink); }
</style></head>
<body>
  <form class="card" method="POST" action="/__auth">
    <div class="brand"><span class="dot"></span> FormSpeak</div>
    <h1>Enter password</h1>
    <div class="sub">The password is <strong>form</strong>. Very secure, I know, but can't have those bots running up my Gemini bill!</div>
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required />
    ${isError ? '<div class="err">Incorrect password. Try again.</div>' : ""}
    <input type="hidden" name="next" value="${escAttr(next)}"/>
    <button type="submit">Unlock</button>
  </form>
</body></html>`;
}

// Public assets that must resolve before login: the favicon and the social /
// iMessage preview image (otherwise an unauthenticated fetch gets the login HTML).
const PUBLIC_ASSETS = new Set([
  "/favicon.svg", "/favicon-32.png", "/favicon.ico", "/apple-touch-icon.png",
]);

export const onRequest = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);
  if (PUBLIC_ASSETS.has(url.pathname)) return ctx.next();
  const expected = env.GATE_PASSWORD || "form";
  const token = await sha256hex("fs::" + expected); // cookie marker (never the plaintext)

  const authed = readCookie(request, COOKIE) === token;

  // Handle the login form submission.
  if (url.pathname === "/__auth" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const pass = form ? String(form.get("password") || "") : "";
    const next = safeNext(form && form.get("next"));
    if (pass === expected) {
      const headers = new Headers({ Location: next });
      headers.append(
        "Set-Cookie",
        `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
      );
      return new Response(null, { status: 303, headers });
    }
    return new Response(loginPage(next, true), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (authed) {
    if (url.pathname === "/__auth") return new Response(null, { status: 303, headers: { Location: "/" } });
    return ctx.next();
  }

  // Unauthenticated API calls get JSON, not the HTML page.
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Anything else → show the login page (remembering where they were headed).
  // Served as 200 (not 401) so link-preview crawlers (iMessage/Apple, Slack, etc.)
  // parse the Open Graph tags — they skip OG on non-200 responses.
  return new Response(loginPage(url.pathname + url.search, false), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
};
