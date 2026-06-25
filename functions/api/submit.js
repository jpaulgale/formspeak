// POST /api/submit — persist a confirmed submission to D1.
// Uses the DB binding (parameterized insert) instead of the Python serve.py's
// wrangler-subprocess hack, so PII like O'Brien is handled safely.
const FIELDS = [
  "first_name", "last_name", "address", "date_of_birth", "ssn",
  "household_size", "household_income", "feedback",
];

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
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: "D1 write failed", detail: String(e?.message || e) }, { status: 500 });
  }
};
