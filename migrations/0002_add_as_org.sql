-- Add the client-IP network/ISP name (request.cf.asOrganization) to sessions, so
-- you can tell a residential ISP from a cloud/VPN egress at a glance.
--
--   npx wrangler d1 execute ramble-form-hackathon --remote --file migrations/0002_add_as_org.sql
--
-- Re-running errors with "duplicate column name" — expected and harmless.
ALTER TABLE sessions ADD COLUMN as_org TEXT NOT NULL DEFAULT '';
