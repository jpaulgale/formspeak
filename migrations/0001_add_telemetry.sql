-- One-time migration for the EXISTING remote D1 (which already has `submissions`).
-- Adds the telemetry tables and a session_id column to submissions.
--
-- Apply once:
--   npx wrangler d1 execute ramble-form-hackathon --remote --file migrations/0001_add_telemetry.sql
--
-- Note: the ALTER below errors with "duplicate column name" if re-run — that's
-- expected and harmless; the CREATE … IF NOT EXISTS statements are idempotent.

ALTER TABLE submissions ADD COLUMN session_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  ip_hash      TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  colo         TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  event_count  INTEGER NOT NULL DEFAULT 0,
  submitted    INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_ip   ON sessions(ip_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  type        TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL DEFAULT '',
  client_ts   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
