// POST /api/submit — persist a confirmed submission to D1.
// Uses the DB binding (parameterized insert) instead of the Python serve.py's
// wrangler-subprocess hack, so PII like O'Brien is handled safely.
const FIELDS = [
  "first_name", "last_name", "address", "date_of_birth", "ssn",
  "household_size", "household_income", "feedback",
];

const LABELS = {
  first_name: "First name", last_name: "Last name", address: "Address",
  date_of_birth: "DOB", ssn: "SSN", household_size: "Household size",
  household_income: "Monthly income", feedback: "Feedback",
};

function maskSSN(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 4 ? `•••-••-${d.slice(-4)}` : (v || "");
}

// Fire-and-forget Telegram ping so a new submission lands in your chat instantly.
// No-ops (returns quietly) unless BOTH secrets are set, and never throws — a
// notification failure must never break the user's submission.
async function notifyTelegram(env, data) {
  const tokenTg = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!tokenTg || !chatId) return;

  const lines = FIELDS
    .map((k) => {
      const v = k === "ssn" ? maskSSN(data?.[k]) : String(data?.[k] ?? "").trim();
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
  const cols = FIELDS.join(", ");
  const placeholders = FIELDS.map(() => "?").join(", ");

  try {
    await ctx.env.DB
      .prepare(`INSERT INTO submissions (${cols}) VALUES (${placeholders})`)
      .bind(...values)
      .run();
    // Notify after the write succeeds; waitUntil lets the response return
    // immediately while the ping finishes in the background.
    ctx.waitUntil(notifyTelegram(ctx.env, data));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: "D1 write failed", detail: String(e?.message || e) }, { status: 500 });
  }
};
