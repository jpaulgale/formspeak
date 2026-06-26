// POST /api/submit — persist a confirmed submission to D1.
// Uses the DB binding (parameterized insert) instead of the Python serve.py's
// wrangler-subprocess hack, so PII like O'Brien is handled safely.
const FIELDS = [
  "first_name", "last_name", "address", "date_of_birth", "phone",
  "household_size", "household_income", "preferred_language", "feedback",
];

const LABELS = {
  first_name: "First name", last_name: "Last name", address: "Address",
  date_of_birth: "DOB", phone: "Phone", household_size: "Household size",
  household_income: "Monthly income", preferred_language: "Preferred language",
  feedback: "Feedback",
};

// Fire-and-forget Telegram ping so a new submission lands in your chat instantly.
// No-ops (returns quietly) unless BOTH secrets are set, and never throws — a
// notification failure must never break the user's submission.
async function notifyTelegram(env, data) {
  const tokenTg = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!tokenTg || !chatId) return;

  const lines = FIELDS
    .map((k) => {
      const v = String(data?.[k] ?? "").trim();
      return v ? `*${LABELS[k]}:* ${v}` : null;
    })
    .filter(Boolean);
  const text = `🎙️ *New FormSpeak submission*\n${lines.join("\n")}`;

  try {
    await fetch(`https://api.telegram.org/bot${tokenTg}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch {
    // swallow — the submission already succeeded; the ping is best-effort.
  }
}

export const onRequestPost = async (ctx) => {
  if (!ctx.env.DB) {
    return Response.json({ error: "D1 binding 'DB' not configured" }, { status: 500 });
  }

  let data;
  try {
    data = await ctx.request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const values = FIELDS.map((k) => String(data?.[k] ?? ""));
  const sessionId = String(data?.session_id ?? "").slice(0, 64);
  const cols = FIELDS.concat("session_id").join(", ");
  const placeholders = FIELDS.concat("session_id").map(() => "?").join(", ");
  const insert = () =>
    ctx.env.DB
      .prepare(`INSERT INTO submissions (${cols}) VALUES (${placeholders})`)
      .bind(...values, sessionId)
      .run();

  try {
    // Self-healing migration: if a newly-added field's column isn't on this database
    // yet, the insert fails with "no column named <x>". We add it via the (full-access)
    // DB binding and retry — looping so several new columns can be added in one request.
    // The column name comes from SQLite's own error and is constrained to \w+, and we
    // only ever add a TEXT column, so there's nothing injectable here.
    let lastErr = null;
    for (let attempt = 0; attempt < FIELDS.length + 1; attempt++) {
      try { await insert(); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        const m = String(e?.message || e).match(/no column named (\w+)/i);
        if (!m) throw e;
        try { await ctx.env.DB.prepare(`ALTER TABLE submissions ADD COLUMN ${m[1]} TEXT NOT NULL DEFAULT ''`).run(); } catch { /* raced in */ }
      }
    }
    if (lastErr) throw lastErr;
    // Notify after the write succeeds; waitUntil lets the response return
    // immediately while the ping finishes in the background.
    ctx.waitUntil(notifyTelegram(ctx.env, data));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: "D1 write failed", detail: String(e?.message || e) }, { status: 500 });
  }
};
