-- Flag test/QA sessions (model-eval harness runs, ?test=1 in-app demos) so they
-- can be excluded from real-usage analytics. Sessions whose session_id starts
-- with 'test-' are marked at write time by log.js / serve.py; the UPDATE
-- backfills any test sessions already logged.
--
--   npx wrangler d1 execute ramble-form-hackathon --remote --file migrations/0004_add_is_test.sql
--
-- Re-running errors with "duplicate column name" — expected and harmless.
ALTER TABLE sessions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET is_test = 1 WHERE session_id LIKE 'test-%';
