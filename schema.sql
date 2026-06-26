-- Submissions table for the FormSpeak (NYC benefits) form.
CREATE TABLE IF NOT EXISTS submissions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name       TEXT NOT NULL DEFAULT '',
  last_name        TEXT NOT NULL DEFAULT '',
  address          TEXT NOT NULL DEFAULT '',
  date_of_birth    TEXT NOT NULL DEFAULT '',
  ssn              TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  household_size   TEXT NOT NULL DEFAULT '',
  household_income TEXT NOT NULL DEFAULT '',
  preferred_language TEXT NOT NULL DEFAULT '',
  feedback         TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
