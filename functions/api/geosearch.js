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

// ---- Fallback geocoder: OpenStreetMap Nominatim, bounded to NYC ----
// Used ONLY when the primary (Planning Labs Pelias) is unreachable, so the address
// feature keeps working through their outages. Results are mapped to the SAME shape
// featureToAddr() produces, so the judging logic below is source-agnostic.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// left,top,right,bottom (lon/lat) — the five-borough bounding box.
const NYC_VIEWBOX = "-74.2591,40.9176,-73.7002,40.4774";
const COUNTY_TO_BOROUGH = {
  "new york county": "Manhattan",
  "kings county": "Brooklyn",
  "queens county": "Queens",
  "bronx county": "Bronx",
  "richmond county": "Staten Island",
};

function boroughFromOSM(a) {
  // suburb/city_district is usually the borough name outright ("Brooklyn", "Manhattan").
  for (const c of [a.suburb, a.city_district, a.borough]) {
    if (c) { const b = detectBorough(String(c).toLowerCase()); if (b) return b; }
  }
  const county = String(a.county || "").toLowerCase();
  return COUNTY_TO_BOROUGH[county] || detectBorough(county);
}

function osmToAddr(item) {
  const a = item.address || {};
  const housenumber = a.house_number || "";
  const street = a.road || "";
  const borough = boroughFromOSM(a);
  const postalcode = a.postcode || "";
  const name = [housenumber, street].filter(Boolean).join(" ");
  const tail = "NY" + (postalcode ? ` ${postalcode}` : "");
  const full = [name, borough, tail].filter(Boolean).join(", ");
  return {
    full, label: item.display_name || "", name, housenumber, street, borough,
    postalcode, region: "NY", lat: item.lat != null ? Number(item.lat) : null,
    lon: item.lon != null ? Number(item.lon) : null, confidence: null, match_type: null,
  };
}

async function fetchNominatim(text) {
  const u = new URL(NOMINATIM_URL);
  u.searchParams.set("q", text);
  u.searchParams.set("format", "json");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("countrycodes", "us");
  u.searchParams.set("limit", "8");
  u.searchParams.set("viewbox", NYC_VIEWBOX);
  u.searchParams.set("bounded", "1"); // hard-restrict to the NYC box
  const r = await fetch(u, {
    signal: AbortSignal.timeout(6000),
    headers: {
      "User-Agent": "FormSpeak-demo/1.0 (jpaulgale@gmail.com)",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error("nominatim " + r.status);
  return await r.json();
}

export const onRequestGet = async (ctx) => {
  const text = (new URL(ctx.request.url).searchParams.get("text") || "").trim();
  if (!text) return Response.json({ error: "missing text" }, { status: 400 });

  // Resolve to a common candidate list from whichever geocoder answers. Primary is
  // Planning Labs Pelias; if it's unreachable we fall back to OSM Nominatim (bounded
  // to NYC) so the address feature survives their outages. `source` rides along in the
  // responses for telemetry so a fallback-served confirmation is distinguishable.
  let cands, source = "pelias";
  try {
    const data = await fetchGeosearch(text);
    cands = (data?.features || []).map(featureToAddr);
  } catch (ePelias) {
    try {
      const items = await fetchNominatim(text);
      source = "nominatim";
      // Drop anything Nominatim couldn't pin to a borough — that's outside NYC.
      cands = (Array.isArray(items) ? items : []).map(osmToAddr).filter((c) => c.borough);
    } catch (eNom) {
      // BOTH geocoders are down. Rather than block the form on a dead dependency,
      // DEGRADE GRACEFULLY: accept what the user said (carrying a borough if they named
      // one) as a soft-confirm. `degraded` is flagged so telemetry and the client can be
      // honest that it wasn't actually verified.
      const boro = detectBorough(text.toLowerCase());
      const full = boro && !text.toLowerCase().includes(boro.toLowerCase())
        ? `${text}, ${boro}` : text;
      return Response.json({
        status: "confirmed", found: true, degraded: true,
        full, borough: boro, label: text,
        error: `pelias: ${String(ePelias?.message || ePelias)}; nominatim: ${String(eNom?.message || eNom)}`,
      });
    }
  }

  if (!cands.length) return Response.json({ status: "not_found", found: false, source });

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
    return Response.json({ status: "confirmed", found: true, source, ...top });
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

  return Response.json({ status: "ambiguous", found: true, source, reason, candidates: offered });
};
