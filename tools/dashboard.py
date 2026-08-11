# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""FormSpeak telemetry dashboard — a clean local web view of voice sessions.

    uv run tools/dashboard.py      # starts http://localhost:8787 and opens it

Reads the remote D1 through the already-authenticated `wrangler` CLI (no API
token; see d1.py). Click a session in the sidebar to replay the whole
conversation as a chat transcript — user/assistant bubbles, every tool call
with its outcome, and problems (errors, ws closes, unconfirmed fields) flagged
in red. The UI lives in dashboard.html next to this script. Stdlib only.

The pulled data is snapshotted to .dashboard_cache.json at the repo root, so
after the first run the dashboard opens instantly from disk and only fetches
events NEWER than the cached high-water mark (events.id is append-only). Pass
--fresh to discard the snapshot and re-pull everything.
"""

import json
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from d1 import REPO_ROOT, query, sql_str

PORT = 8787
CACHE_FILE = REPO_ROOT / ".dashboard_cache.json"
INDEX_HTML = (Path(__file__).with_name("dashboard.html")).read_text()


# In-memory mirror of the remote D1, backed by CACHE_FILE on disk. Events are append-only
# with an autoincrement id, so refresh() only pulls rows past max_event_id and merges them
# in; sessions are refetched whole (one small row each — and their last_seen/event_count/
# submitted mutate in place, so a delta fetch would miss updates). /api/refresh re-pulls.
_CACHE: dict = {"sessions_by_id": {}, "events_by_id": {}, "max_event_id": 0}
_REFRESH_LOCK = threading.Lock()
_REFRESHING = False  # surfaced to the frontend so it can show "syncing…" and re-poll


def load_cache_file() -> bool:
    try:
        d = json.loads(CACHE_FILE.read_text())
        if not isinstance(d.get("sessions_by_id"), dict):
            return False
        _CACHE["sessions_by_id"] = d["sessions_by_id"]
        _CACHE["events_by_id"] = d.get("events_by_id") or {}
        _CACHE["max_event_id"] = int(d.get("max_event_id") or 0)
        return bool(_CACHE["sessions_by_id"])
    except (OSError, ValueError):
        return False


def save_cache_file() -> None:
    tmp = CACHE_FILE.with_name(CACHE_FILE.name + ".tmp")
    tmp.write_text(json.dumps(_CACHE, separators=(",", ":")))
    tmp.replace(CACHE_FILE)  # atomic — a crash mid-write never corrupts the snapshot


def refresh() -> None:
    global _REFRESHING
    with _REFRESH_LOCK:
        _REFRESHING = True
        try:
            since = int(_CACHE.get("max_event_id") or 0)
            sess_rows, event_rows = query(
                "SELECT session_id, submitted, event_count, country, region, city, colo, as_org, "
                "substr(ip_hash,1,10) AS ip_hash, user_agent, started_at, last_seen, is_test "
                "FROM sessions ORDER BY last_seen DESC;",
                "SELECT id, session_id, seq, type, payload, client_ts FROM events "
                f"WHERE id > {since} ORDER BY id ASC;",
            )
            events_by_id = _CACHE["events_by_id"]
            touched = set()
            for e in event_rows:
                try:
                    e["data"] = json.loads(e.get("payload") or "{}")
                except json.JSONDecodeError:
                    e["data"] = {}
                e.pop("payload", None)
                events_by_id.setdefault(e["session_id"], []).append(e)
                touched.add(e["session_id"])
                _CACHE["max_event_id"] = max(_CACHE["max_event_id"], int(e.get("id") or 0))
            # New events arrive ordered by id (insert order); a late batch flush can land
            # after a later seq, so re-sort just the sessions that actually got rows.
            for sid in touched:
                events_by_id[sid].sort(key=lambda e: (e.get("seq") or 0, e.get("id") or 0))
            _CACHE["sessions_by_id"] = {s["session_id"]: s for s in sess_rows}
            save_cache_file()
        finally:
            _REFRESHING = False


def sessions() -> list[dict]:
    # Skip single-event sessions: a lone session_start (or a bot's one-off hit) with no
    # real activity is just noise in the list, never a conversation worth replaying.
    # Also hide test/QA sessions (is_test — eval-harness runs, ?test=1 demos); their
    # detail pages stay reachable by session id.
    rows = [
        s
        for s in _CACHE["sessions_by_id"].values()
        if (s.get("event_count") or 0) > 1 and not s.get("is_test")
    ]
    return rows[:500]  # already sorted by last_seen DESC at fetch time


def session_detail(sid: str) -> dict:
    sess = _CACHE["sessions_by_id"].get(sid, {"session_id": sid})
    return {"session": sess, "events": _CACHE["events_by_id"].get(sid, [])}


def delete_sessions(ids: list[str]) -> int:
    """Delete sessions + their event streams from remote D1 and the local cache.
    Deliberately does NOT touch `submissions` — those are the captured form
    records; a deleted garbage/test session has none anyway."""
    ids = [str(s)[:64] for s in ids if isinstance(s, str) and s.strip()][:200]
    if not ids:
        return 0
    id_list = ", ".join(sql_str(s) for s in ids)
    with _REFRESH_LOCK:  # don't race a refresh() writing the same cache
        query(
            f"DELETE FROM events WHERE session_id IN ({id_list});",
            f"DELETE FROM sessions WHERE session_id IN ({id_list});",
        )
        for sid in ids:
            _CACHE["sessions_by_id"].pop(sid, None)
            _CACHE["events_by_id"].pop(sid, None)
        save_cache_file()
    return len(ids)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/" or path == "/index.html":
                return self._send(200, INDEX_HTML, "text/html; charset=utf-8")
            if path == "/api/sessions":
                return self._send(
                    200, json.dumps({"sessions": sessions(), "refreshing": _REFRESHING})
                )
            if path == "/api/refresh":
                refresh()
                return self._send(200, json.dumps({"sessions": sessions(), "refreshing": False}))
            if path.startswith("/api/session/"):
                sid = path.rsplit("/", 1)[-1]
                return self._send(200, json.dumps(session_detail(sid)))
            self._send(404, json.dumps({"error": "not found"}))
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}))

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/delete":
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                deleted = delete_sessions(body.get("session_ids") or [])
                return self._send(
                    200,
                    json.dumps(
                        {"deleted": deleted, "sessions": sessions(), "refreshing": _REFRESHING}
                    ),
                )
            self._send(404, json.dumps({"error": "not found"}))
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}))


def _refresh_in_background() -> None:
    try:
        refresh()
    except Exception as e:
        print(f"background refresh failed (serving cached snapshot): {e}", file=sys.stderr)


def main() -> None:
    if "--fresh" in sys.argv:
        CACHE_FILE.unlink(missing_ok=True)
    if load_cache_file():
        # Open instantly from the disk snapshot; pull only new events in the background.
        print(f"loaded snapshot from {CACHE_FILE.name} — syncing new events in background")
        threading.Thread(target=_refresh_in_background, daemon=True).start()
    else:
        try:
            refresh()  # first run: one full pull; fail fast if wrangler/auth is broken
        except Exception as e:
            sys.exit(f"Couldn't read D1 via wrangler:\n{e}")
    # Bind all interfaces so the dashboard is reachable over Tailscale, not just
    # localhost. (127.0.0.1 is invisible to the tailnet.)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"FormSpeak telemetry dashboard → {url}  (Ctrl-C to stop)")
    # If Tailscale is up, surface the tailnet URL so it can be opened from any device.
    try:
        ts_ip = (
            subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
            .stdout.strip()
            .splitlines()
        )
        if ts_ip:
            print(f"  via Tailscale → http://{ts_ip[0]}:{PORT}")
    except Exception:
        pass
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
