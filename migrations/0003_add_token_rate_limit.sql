-- Per-IP rate limit for /api/token (each token opens an expensive Gemini Live
-- session). One row per IP per one-minute bucket; the Function upserts a count and
-- refuses once it crosses the limit. Replaces the deleted password gate as the thing
-- that stops a script from minting sessions in a loop. Cloudflare's `ratelimits`
-- binding isn't supported on Pages, hence this D1-backed counter.
--
--   npx wrangler d1 execute ramble-form-hackathon --remote --file migrations/0003_add_token_rate_limit.sql
--
-- Re-running is harmless (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS token_rate_limit (
  ip      TEXT    NOT NULL,
  bucket  INTEGER NOT NULL,            -- unix-minute bucket: floor(epoch_ms / 60000)
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, bucket)
);
