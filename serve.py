#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "aiohttp>=3.9",
#     "google-genai>=1.0",
# ]
# ///
"""
Ramble Form — local token server.

Serves index.html and mints short-lived *ephemeral tokens* for the Gemini
Live API so the browser can open a WebSocket directly to Google without ever
seeing your real API key.

Run:
    uv run serve.py
    open http://localhost:8000

API key resolution (first hit wins):
    1. $GEMINI_API_KEY / $GOOGLE_API_KEY
    2. ./.env                      (GEMINI_API_KEY=...)
    3. ../../ev-storefront/storefront-updater-airtable-worker/.dev.vars
"""

import asyncio
import datetime
import hashlib
import json
import mimetypes
import os
import re
import shutil
from pathlib import Path

import aiohttp
from aiohttp import web
from google import genai

HTTP_PORT = 8000
HERE = Path(__file__).parent

# D1 (created via `wrangler d1 create ramble-form-hackathon`)
D1_DB = "ramble-form-hackathon"
SUBMIT_FIELDS = (
    "first_name", "last_name", "address", "date_of_birth", "ssn",
    "household_size", "household_income", "session_id",
)

# NYC Planning Labs Geosearch (Pelias) — same service ev-storefront uses. It only
# covers the five boroughs, so results are inherently NYC-biased.
GEOSEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search"


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def load_api_key() -> tuple[str | None, str]:
    # 1. environment
    for var in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(var):
            return os.environ[var], f"${var}"

    # 2. local .env, 3. ev-storefront .dev.vars
    candidates = [
        HERE / ".env",
        HERE.parent.parent
        / "ev-storefront"
        / "storefront-updater-airtable-worker"
        / ".dev.vars",
    ]
    for path in candidates:
        if path.exists():
            vals = _parse_env_file(path)
            if vals.get("GEMINI_API_KEY"):
                return vals["GEMINI_API_KEY"], str(path)
    return None, "(not found)"


API_KEY, API_KEY_SOURCE = load_api_key()
client = (
    genai.Client(api_key=API_KEY, http_options={"api_version": "v1alpha"})
    if API_KEY
    else None
)


async def get_ephemeral_token(request: web.Request) -> web.Response:
    if client is None:
        return web.json_response(
            {"error": "No GEMINI_API_KEY found on the server."}, status=500
        )
    try:
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        token = client.auth_tokens.create(
            config={
                "uses": 1,
                "expire_time": (now + datetime.timedelta(minutes=30)).isoformat(),
                "new_session_expire_time": (
                    now + datetime.timedelta(minutes=2)
                ).isoformat(),
                "http_options": {"api_version": "v1alpha"},
            }
        )
        return web.json_response({"token": token.name})
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  token mint failed: {e}")
        return web.json_response({"error": str(e)}, status=500)


def _sql_str(v: str) -> str:
    """Escape a Python string as a SQLite string literal."""
    return "'" + str(v).replace("'", "''") + "'"


async def submit_form(request: web.Request) -> web.Response:
    """Persist a confirmed submission to D1 via the (already authenticated) wrangler CLI."""
    wrangler = shutil.which("wrangler") or shutil.which("npx")
    if wrangler is None:
        return web.json_response({"error": "wrangler/npx not found on PATH"}, status=500)

    try:
        data = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON"}, status=400)

    vals = [str(data.get(k, "")) for k in SUBMIT_FIELDS]
    cols = ", ".join(SUBMIT_FIELDS)
    sql = f"INSERT INTO submissions ({cols}) VALUES ({', '.join(_sql_str(v) for v in vals)});"

    # Write SQL to a temp file (avoids shell-quoting issues with PII like O'Brien).
    sql_file = HERE / ".submit.sql"
    sql_file.write_text(sql)

    cmd = ["wrangler"] if wrangler.endswith("wrangler") else ["npx", "--yes", "wrangler"]
    cmd += ["d1", "execute", D1_DB, "--remote", "--yes", f"--file={sql_file}"]

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    sql_file.unlink(missing_ok=True)

    if proc.returncode != 0:
        tail = (out or b"").decode(errors="replace")[-500:]
        print(f"⚠️  D1 write failed:\n{tail}")
        return web.json_response({"error": "D1 write failed", "detail": tail}, status=500)

    print(f"✅ saved submission to D1: {json.dumps(dict(zip(SUBMIT_FIELDS, vals)))}")
    return web.json_response({"ok": True})


async def log_events(request: web.Request) -> web.Response:
    """Persist a batch of client telemetry events to D1 (local-dev mirror of
    functions/api/log.js). Fail-safe: always 200 so logging never breaks the UI."""
    wrangler = shutil.which("wrangler") or shutil.which("npx")
    if wrangler is None:
        return web.json_response({"ok": False, "error": "wrangler/npx not found"})

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "bad json"})

    session_id = str(body.get("sessionId", ""))[:64]
    events = body.get("events") or []
    if not session_id or not events:
        return web.json_response({"ok": True})

    # No CF geo locally; hash whatever client IP aiohttp sees.
    ip = request.headers.get("X-Forwarded-For", request.remote or "")
    ip_hash = hashlib.sha256(f"local::{ip}".encode()).hexdigest()[:32] if ip else ""
    submitted = 1 if any(
        e.get("type") == "submit_saved"
        or (e.get("type") == "tool_call"
            and (e.get("data") or {}).get("name") == "submit_form"
            and (e.get("data") or {}).get("result") == "submitted")
        for e in events
    ) else 0

    sid = _sql_str(session_id)
    n = len(events)
    stmts = [
        f"INSERT INTO sessions (session_id, ip_hash, event_count, submitted) "
        f"VALUES ({sid}, {_sql_str(ip_hash)}, {n}, {submitted}) "
        f"ON CONFLICT(session_id) DO UPDATE SET last_seen=datetime('now'), "
        f"event_count=event_count+{n}, submitted=MAX(submitted,{submitted});"
    ]
    for e in events:
        payload = json.dumps(e.get("data") or {})[:20000]
        seq = int(e.get("seq") or 0)
        ts = int(e.get("ts") or 0)
        stmts.append(
            f"INSERT INTO events (session_id, seq, type, payload, client_ts) VALUES ("
            f"{sid}, {seq}, {_sql_str(str(e.get('type',''))[:40])}, "
            f"{_sql_str(payload)}, {ts});"
        )

    sql_file = HERE / ".log.sql"
    sql_file.write_text("\n".join(stmts))
    cmd = ["wrangler"] if wrangler.endswith("wrangler") else ["npx", "--yes", "wrangler"]
    cmd += ["d1", "execute", D1_DB, "--remote", "--yes", f"--file={sql_file}"]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    sql_file.unlink(missing_ok=True)
    if proc.returncode != 0:
        tail = (out or b"").decode(errors="replace")[-300:]
        print(f"⚠️  telemetry write failed:\n{tail}")
        return web.json_response({"ok": False})
    print(f"📊 logged {n} event(s) for session {session_id[:8]}")
    return web.json_response({"ok": True, "stored": n})


# The five boroughs, as Pelias labels them in the `borough` field.
_BOROUGHS = ("Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island")

# Spoken/written ways to refer to a borough → its Pelias `borough` value. The five
# real borough names are matched FIRST (see _detect_borough); these synonyms only
# resolve when none of those appear. Crucially this maps "New York" / "NYC" →
# Manhattan, because the model normalizes Manhattan addresses to their USPS city
# ("171 East 2nd Street, New York, NY"), which previously read as no-borough.
_BOROUGH_SYNONYMS = {
    "new york city": "Manhattan",
    "new york county": "Manhattan",
    "nyc": "Manhattan",
    "new york": "Manhattan",
    "kings county": "Brooklyn",
    "the bronx": "Bronx",
    "bronx county": "Bronx",
    "richmond county": "Staten Island",
    "queens county": "Queens",
}


def _detect_borough(low: str) -> str:
    """Pull a borough from lowercased query text. Real borough names win; the
    'New York'/'NYC' → Manhattan fallback applies only when none are present."""
    for b in _BOROUGHS:
        if b.lower() in low:
            return b
    for phrase, b in _BOROUGH_SYNONYMS.items():
        if phrase in low:
            return b
    return ""

# NOTE: the /v2/search endpoint returns a uniform confidence (~0.8, match_type
# "fallback") for every candidate, so confidence is useless for disambiguation.
# The real signal is STRUCTURAL: does the top candidate's house number match what
# the user said, and does that exact (house number, street) sit in exactly one
# borough? "171 E 2nd Street" exists in BOTH Manhattan and Brooklyn — that's the
# ambiguity we must catch instead of silently accepting one.


def _feature_to_addr(feature: dict) -> dict:
    """Flatten one Pelias feature into a clean address dict (borough always carried)."""
    props = feature.get("properties", {}) or {}
    geom = feature.get("geometry", {}) or {}
    coords = geom.get("coordinates") or [None, None]

    housenumber = props.get("housenumber", "")
    street = props.get("street", "")
    borough = props.get("borough", "")
    postalcode = props.get("postalcode", "")
    region = props.get("region_a") or "NY"
    name = props.get("name") or " ".join(p for p in (housenumber, street) if p)

    # Build a clean full address that always carries the borough.
    tail = region + (f" {postalcode}" if postalcode else "")
    full = ", ".join(p for p in (name, borough, tail) if p)

    return {
        "full": full,
        "label": props.get("label", ""),
        "name": name,
        "housenumber": housenumber,
        "street": street,
        "borough": borough,
        "postalcode": postalcode,
        "region": region,
        "lat": coords[1],
        "lon": coords[0],
        "confidence": props.get("confidence"),
        "match_type": props.get("match_type"),
    }


async def geosearch(request: web.Request) -> web.Response:
    """Confirm a spoken address against NYC Planning Labs Geosearch (Pelias).

    Returns a verdict the frontend can act on deterministically:
      - "confirmed": the spoken address resolves to exactly one NYC borough →
        `full` carries that borough.
      - "ambiguous": it spans multiple boroughs, or no exact house-number match →
        `candidates` (+ a `reason`).
      - "not_found": Pelias returned nothing.
    The borough is never invented here — it comes straight from the match.
    """
    text = (request.query.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "missing text"}, status=400)

    # Fetch extra so that after de-duping we can still surface a full top-4 list.
    params = {"text": text, "size": "8"}
    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(GEOSEARCH_URL, params=params) as resp:
                data = await resp.json()
    except Exception as e:  # noqa: BLE001
        print(f"⚠️  geosearch failed: {e}")
        return web.json_response({"status": "error", "found": False, "error": str(e)}, status=502)

    features = data.get("features") or []
    if not features:
        return web.json_response({"status": "not_found", "found": False})

    cands = [_feature_to_addr(f) for f in features]

    # If the user named a borough or ZIP, narrow to it first — Pelias's fuzzy
    # /search ignores them, so "171 E 2nd St, Manhattan" still returns both
    # boroughs and we'd wrongly stay ambiguous unless we filter here ourselves.
    low = text.lower()
    named_boro = _detect_borough(low)
    hn_m = re.match(r"\s*(\d+)", text)
    query_hn = hn_m.group(1) if hn_m else ""
    zip_match = next((z for z in re.findall(r"\b(\d{5})\b", text) if z != query_hn), "")

    pool = cands
    if named_boro:
        narrowed = [c for c in pool if c["borough"] == named_boro]
        if narrowed:
            pool = narrowed
    if zip_match:
        narrowed = [c for c in pool if str(c["postalcode"]) == zip_match]
        if narrowed:
            pool = narrowed

    top = pool[0]

    # Did Pelias actually match the house number the user said? If they said "100"
    # and the best hit is "719", that's not their address — don't confirm it.
    hn_ok = (not query_hn) or (query_hn == str(top["housenumber"]))

    # Among candidates that are the SAME street address as the top hit (same source
    # formatting, so an exact string compare is safe), how many distinct boroughs?
    # >1 means the spoken address (e.g. "171 E 2nd St") exists in multiple boroughs.
    same = [
        c for c in pool
        if c["housenumber"] == top["housenumber"] and c["street"] == top["street"]
    ]
    boroughs = sorted({c["borough"] for c in same if c["borough"]})

    if hn_ok and len(boroughs) == 1:
        print(f"🏙  geosearch {text!r} → confirmed: {top['full']}")
        return web.json_response({"status": "confirmed", "found": True, **top})

    # Ambiguous: hand back a short, distinct candidate list for the model to offer.
    # When it's a borough clash, offer exactly the matching-address candidates so
    # the user picks the borough; otherwise offer the nearest distinct results.
    reason = "multiple_boroughs" if len(boroughs) > 1 else "no_exact_match"
    print(f"🏙  geosearch {text!r} → ambiguous ({reason}); boroughs={boroughs or '∅'}")
    pool = same if len(boroughs) > 1 else cands
    seen: set[str] = set()
    offered = []
    for c in pool:
        if not c["full"] or c["full"] in seen:
            continue
        seen.add(c["full"])
        offered.append({"full": c["full"], "borough": c["borough"], "label": c["label"]})
        if len(offered) >= 4:
            break

    return web.json_response(
        {"status": "ambiguous", "found": True, "reason": reason, "candidates": offered}
    )


async def serve_static(request: web.Request) -> web.Response:
    path = (request.match_info.get("path") or "index.html").lstrip("/")
    if ".." in path:
        return web.Response(text="nope", status=400)
    # Static assets live in ./public (the Cloudflare Pages build output dir).
    file_path = HERE / "public" / (path or "index.html")
    if not file_path.is_file():
        return web.Response(text="not found", status=404)
    ctype, _ = mimetypes.guess_type(str(file_path))
    return web.Response(
        body=file_path.read_bytes(), content_type=ctype or "application/octet-stream"
    )


async def main() -> None:
    app = web.Application()
    app.router.add_post("/api/token", get_ephemeral_token)
    app.router.add_post("/api/submit", submit_form)
    app.router.add_post("/api/log", log_events)
    app.router.add_get("/api/geosearch", geosearch)
    app.router.add_get("/", serve_static)
    app.router.add_get("/{path:.*}", serve_static)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", HTTP_PORT).start()

    key_state = "✅ loaded" if API_KEY else "❌ MISSING — set GEMINI_API_KEY"
    print(
        f"\n  Ramble Form  →  http://localhost:{HTTP_PORT}\n"
        f"  API key: {key_state}  (from {API_KEY_SOURCE})\n"
        f"  Ctrl-C to stop.\n"
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 stopped")
