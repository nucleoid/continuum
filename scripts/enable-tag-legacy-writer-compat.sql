-- Run as the application schema owner after pausing intake and draining all
-- memory writes. Keep migration 0083 installed during application rollback.
-- Only the normalization mode changes; caller provenance checks, pinned
-- definer functions, role grants and deferred promotion guards remain intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE memories IN EXCLUSIVE MODE;
UPDATE continuum_tag_write_policy SET legacy_compat=TRUE WHERE singleton;
COMMIT;
