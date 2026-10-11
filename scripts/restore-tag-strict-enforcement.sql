-- Run as the application schema owner once every application instance is
-- vocabulary-aware, before paused writers resume. Preserve migration 0083's
-- strict 32-tag bound, matching-row locks and protected provenance checks.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE memories IN EXCLUSIVE MODE;
UPDATE continuum_tag_write_policy SET legacy_compat=FALSE WHERE singleton;
COMMIT;
