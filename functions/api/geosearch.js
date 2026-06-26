// GET /api/geosearch?text=... — confirm a spoken address against NYC Planning Labs
// Geosearch (Pelias) and return a deterministic verdict the frontend acts on:
//   confirmed | ambiguous (+candidates/reason) | not_found | error
// Direct JS port of serve.py geosearch() — the borough is never invented; it comes
// straight from the match.
const GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search";

const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"];

// Spoken/written synonyms → Pelias `borough`. Real borough names win first (see
// detectBorough); these only resolve when none appear. "New York"/"NYC" → Manhattan
// because the model normalizes Manhattan addresses to their USPS city ("…, New York, NY").
// Order matters (longest/most-specific phrases first) — kept as an array of pairs.
const BOROUGH_SYNONYMS = [
  ["new york city", "Manhattan"],
  ["new york county", "Manhattan"],
  ["nyc", "Manhattan"],
  ["new york", "Manhattan"],
  ["kings county", "Brooklyn"],
  ["the bronx", "Bronx"],
  ["bronx county", "Bronx"],
  ["richmond county", "Staten Island"],
  ["queens county", "Queens"],
];

function detectBorough(low) {
  for (const b of BOROUGHS) if (low.includes(b.toLowerCase())) return b;
  for (const [phrase, b] of BOROUGH_SYNONYMS) if (low.includes(phrase)) return b;
  return "";
}

function featureToAddr(feature) {
  const props = feature.properties || {};
  const geom = feature.geometry || {};
  const coords = geom.coordinates || [null, null];

  const housenumber = props.housenumber || "";
  const street = props.street || "";
  const borough = props.borough || "";
  const postalcode = props.postalcode || "";
  const region = props.region_a || "NY";
  const name = props.name || [housenumber, street].filter(Boolean).join(" ");

  const tail = region + (postalcode ? ` ${postalcode}` : "");
  const full = [name, borough, tail].filter(Boolean).join(", ");

  return {
    full,
    label: props.label || "",
    name,
    housenumber,
    street,
    borough,
    postalcode,
    region,
    lat: coords[1],
    lon: coords[0],
    confidence: props.confidence ?? null,
    match_type: props.match_type ?? null,
  };
}

// Query the upstream with one quick retry. The model fires several lookups in a
// burst while narrowing an address, and the hosted Pelias occasionally answers a
// transient 5xx / times out under that — a single retry recovers most of them.
async function fetchGeosearch(text) {
  const u = new URL(GEOSEARCH_URL);
  u.searchParams.set("text", text);
  u.searchParams.set("size", "8"); // fetch extra so we can surface a top-4 after de-dupe
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) { lastErr = new Error("upstream " + r.status); continue; }
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("geosearch unreachable");
}

export const onRequestGet = async (ctx) => {
  const text = (new URL(ctx.request.url).searchParams.get("text") || "").trim();
  if (!text) return Response.json({ error: "missing text" }, { status: 400 });

  let data;
  try {
    data = await fetchGeosearch(text);
  } catch (e) {
    // Geosearch is unreachable even after a retry. Rather than block the form on a
    // dead dependency, DEGRADE GRACEFULLY: accept what the user said (carrying a
    // borough if they named one) as a soft-confirm. `degraded` is flagged so it's
    // visible in telemetry and the client can be honest that it wasn't verified.
    const boro = detectBorough(text.toLowerCase());
    const full = boro && !text.toLowerCase().includes(boro.toLowerCase())
      ? `${text}, ${boro}` : text;
    return Response.json({
      status: "confirmed", found: true, degraded: true,
      full, borough: boro, label: text, error: String(e?.message || e),
    });
  }

  const features = data?.features || [];
  if (!features.length) return Response.json({ status: "not_found", found: false });

  const cands = features.map(featureToAddr);

  // Pelias's fuzzy /search ignores a named borough or ZIP, so "171 E 2nd St, Manhattan"
  // still returns both boroughs — narrow it ourselves before judging ambiguity.
  const low = text.toLowerCase();
  const namedBoro = detectBorough(low);
  const hnMatch = /^\s*(\d+)/.exec(text);
  const queryHn = hnMatch ? hnMatch[1] : "";
  const zipMatch = (text.match(/\b\d{5}\b/g) || []).find((z) => z !== queryHn) || "";

  let pool = cands;
  if (namedBoro) {
    const narrowed = pool.filter((c) => c.borough === namedBoro);
    if (narrowed.length) pool = narrowed;
  }
  if (zipMatch) {
    const narrowed = pool.filter((c) => String(c.postalcode) === zipMatch);
    if (narrowed.length) pool = narrowed;
  }

  const top = pool[0];

  // Did Pelias actually match the house number the user said?
  const hnOk = !queryHn || queryHn === String(top.housenumber);

  // Among candidates with the SAME street address as the top hit, how many boroughs?
  // >1 means the spoken address exists in multiple boroughs (the ambiguity to catch).
  const same = pool.filter((c) => c.housenumber === top.housenumber && c.street === top.street);
  const boroughs = [...new Set(same.map((c) => c.borough).filter(Boolean))].sort();

  if (hnOk && boroughs.length === 1) {
    return Response.json({ status: "confirmed", found: true, ...top });
  }

  // Ambiguous: hand back a short, distinct candidate list for the model to offer.
  const reason = boroughs.length > 1 ? "multiple_boroughs" : "no_exact_match";
  const offerPool = boroughs.length > 1 ? same : cands;
  const seen = new Set();
  const offered = [];
  for (const c of offerPool) {
    if (!c.full || seen.has(c.full)) continue;
    seen.add(c.full);
    offered.push({ full: c.full, borough: c.borough, label: c.label });
    if (offered.length >= 4) break;
  }

  return Response.json({ status: "ambiguous", found: true, reason, candidates: offered });
};
