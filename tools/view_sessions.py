# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Review FormSpeak telemetry — voice sessions and their event streams.

Reads via the already-authenticated `wrangler` CLI — no API token needed.
This is how you see how people use the form (including the ones who never
submit) and where they run into trouble.

    uv run tools/view_sessions.py                    # latest 30 sessions, one line each
    uv run tools/view_sessions.py --limit 100         # more sessions
    uv run tools/view_sessions.py --abandoned         # only sessions that never submitted
    uv run tools/view_sessions.py --closes            # ws_close code breakdown (where it breaks)
    uv run tools/view_sessions.py <session_id>        # full event timeline for one session (replay)
    uv run tools/view_sessions.py --json              # raw JSON for piping

The browser never touches this; it's a local admin view of demo telemetry.
(Shared plumbing in d1.py; the database name comes from wrangler.jsonc.)
"""

import argparse
import json
import sys

import d1


def query(sql: str) -> list[dict]:
    """Run a read-only SQL statement against the remote D1 and return rows."""
    try:
        return d1.query_one(sql)
    except RuntimeError as e:
        sys.exit(f"wrangler failed:\n{e}")


def table(rows: list[dict], cols: list[str]) -> None:
    cols = [c for c in cols if any(c in r for r in rows)]
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "")).ljust(widths[c]) for c in cols))


def summarize_event(ev: dict) -> str:
    """One readable line per event for a session replay."""
    t = ev.get("type", "")
    try:
        d = json.loads(ev.get("payload") or "{}")
    except json.JSONDecodeError:
        d = {}
    if t == "turn":
        parts = []
        if d.get("user"):
            parts.append(f"user: {d['user']}")
        if d.get("asst"):
            parts.append(f"asst: {d['asst']}")
        return " | ".join(parts)
    if t == "tool_call":
        args = d.get("args", {})
        arg_s = ", ".join(f"{k}={v!r}" for k, v in args.items())
        return f"{d.get('name', '?')}({arg_s}) -> {d.get('result', '')}"
    if t == "ws_close":
        return f"code={d.get('code')} reason={d.get('reason', '')!r} shown={d.get('shown', '')!r}"
    if t == "error":
        return f"{d.get('where', '')}: {d.get('name', '')} {d.get('message', '')}".strip()
    if t in ("session_start", "session_end"):
        return json.dumps(d)
    return json.dumps(d) if d else ""


def show_session(session_id: str, as_json: bool) -> None:
    # Accept a prefix — the list view shows a truncated id, so match on LIKE 'id%'.
    like = d1.sql_str(session_id + "%")
    sess = query(f"SELECT * FROM sessions WHERE session_id LIKE {like};")
    events = query(
        f"SELECT seq, type, payload, client_ts, created_at FROM events "
        f"WHERE session_id LIKE {like} ORDER BY seq ASC;"
    )
    if as_json:
        print(json.dumps({"session": sess[0] if sess else None, "events": events}, indent=2))
        return
    if not sess:
        print(f"No session {session_id}.")
        if not events:
            return
    else:
        s = sess[0]
        verdict = "SUBMITTED" if s.get("submitted") else "no submit"
        loc = " / ".join(x for x in (s.get("city"), s.get("region"), s.get("country")) if x)
        print(f"session {session_id}  [{verdict}]")
        print(f"  ip_hash {s.get('ip_hash', '')[:12]}…  geo {loc or '?'}  colo {s.get('colo', '')}")
        print(f"  {s.get('started_at')} → {s.get('last_seen')}  ({s.get('event_count')} events)")
        print(f"  ua {s.get('user_agent', '')}")
        print()
    for ev in events:
        line = summarize_event(ev)
        print(f"  #{str(ev.get('seq', '')).rjust(3)}  {ev.get('type', ''):<14} {line}")
    print(f"\n{len(events)} event(s).")


def closes_breakdown() -> None:
    rows = query(
        "SELECT json_extract(payload,'$.code') AS code, "
        "json_extract(payload,'$.shown') AS shown, COUNT(*) AS n "
        "FROM events WHERE type='ws_close' GROUP BY code, shown ORDER BY n DESC;"
    )
    if not rows:
        print("No ws_close events yet.")
        return
    table(rows, ["n", "code", "shown"])


def main() -> None:
    ap = argparse.ArgumentParser(description="Review FormSpeak telemetry sessions.")
    ap.add_argument("session_id", nargs="?", help="show full event timeline for one session")
    ap.add_argument("--limit", type=int, default=30, help="max sessions (default 30)")
    ap.add_argument("--abandoned", action="store_true", help="only sessions that never submitted")
    ap.add_argument(
        "--test", action="store_true", help="only test/QA sessions (default hides them)"
    )
    ap.add_argument("--closes", action="store_true", help="ws_close code breakdown")
    ap.add_argument("--json", action="store_true", help="print raw JSON")
    args = ap.parse_args()

    if args.session_id:
        show_session(args.session_id, args.json)
        return
    if args.closes:
        closes_breakdown()
        return

    conds = ["is_test = 1" if args.test else "is_test = 0"]
    if args.abandoned:
        conds.append("submitted = 0")
    where = "WHERE " + " AND ".join(conds)
    rows = query(
        f"SELECT session_id, submitted, event_count, country, region, city, colo, "
        f"substr(ip_hash,1,10) AS ip_hash, started_at, last_seen "
        f"FROM sessions {where} ORDER BY last_seen DESC LIMIT {args.limit};"
    )

    if args.json:
        print(json.dumps(rows, indent=2))
        return
    if not rows:
        print("No sessions found.")
        return

    for r in rows:
        r["ok"] = "✓" if r.pop("submitted", 0) else "·"
        r["session"] = r.pop("session_id", "")[:8]
    table(
        rows,
        [
            "ok",
            "session",
            "event_count",
            "city",
            "region",
            "country",
            "colo",
            "ip_hash",
            "started_at",
            "last_seen",
        ],
    )
    done = sum(1 for r in rows if r["ok"] == "✓")
    print(
        f"\n{len(rows)} session(s) — {done} submitted, {len(rows) - done} not. "
        f"Pass a session id to replay its events."
    )


if __name__ == "__main__":
    main()
