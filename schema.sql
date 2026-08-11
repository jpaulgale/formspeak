-- Submissions table for the FormSpeak (NYC benefits) form.
CREATE TABLE IF NOT EXISTS submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name       TEXT NOT NULL DEFAULT '',
  last_name        TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  date_of_birth    TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  household_size   TEXT NOT NULL DEFAULT '',
  household_income TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT '',
  feedback         TEXT NOT NULL DEFAULT '',
  session_id       TEXT NOT NULL DEFAULT '',   -- links a saved row back to its telemetry session
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------
-- Telemetry: one row per voice session + an append-only event stream,
-- so you can review how people use the form (including the ones who
-- never submit) and where they run into trouble.
-- ------------------------------------------------------------------

-- One row per browser voice session. IP is stored ONLY as a salted hash
-- (set LOG_SALT as a secret) so sessions from the same person can be grouped
-- without retaining the raw address. Geo/UA come from Cloudflare's edge.
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  ip_hash      TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  colo         TEXT NOT NULL DEFAULT '',
  as_org       TEXT NOT NULL DEFAULT '',   -- network/ISP behind the client IP (cloud/VPN tell)
  user_agent   TEXT NOT NULL DEFAULT '',
  event_count  INTEGER NOT NULL DEFAULT 0,
  submitted    INTEGER NOT NULL DEFAULT 0,      -- 1 once a submit_form/submit_saved event lands
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_ip   ON sessions(ip_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen);

-- Append-only event log. `payload` is a JSON blob whose shape depends on `type`
-- (tool_call, turn, ws_close, error, session_start, session_end, ...).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,       -- client-assigned ordering within a session
  type        TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '',
  client_ts   INTEGER,                          -- Date.now() on the client
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
