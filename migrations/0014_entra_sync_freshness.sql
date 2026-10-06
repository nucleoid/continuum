-- Durable fail-closed freshness state for Entra-sourced access.
CREATE TABLE entra_sync_state (
  singleton             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_success_at       TIMESTAMPTZ NOT NULL DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
  last_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failure_at       TIMESTAMPTZ,
  last_failure_code     TEXT,
  max_staleness         INTERVAL NOT NULL DEFAULT interval '48 hours',
  CHECK (max_staleness >= interval '1 hour' AND max_staleness <= interval '168 hours'),
  CHECK ((last_failure_at IS NULL) = (last_failure_code IS NULL))
);

INSERT INTO entra_sync_state (singleton, last_success_at)
SELECT TRUE, COALESCE(
  max(at) FILTER (WHERE metadata->>'operation' = 'entra_membership_sync'),
  TIMESTAMPTZ '1970-01-01 00:00:00+00'
)
FROM audit_log
ON CONFLICT (singleton) DO NOTHING;

-- A migration is not a successful Graph sync. Existing access remains fresh
-- only when a durable successful-sync audit proves the authoritative snapshot.

CREATE OR REPLACE FUNCTION continuum_membership_is_effective(
  membership_active BOOLEAN,
  membership_source_kind TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT membership_active AND (
    membership_source_kind <> 'entra'
    OR EXISTS (
      SELECT 1
        FROM entra_sync_state
       WHERE singleton
         AND now() < last_success_at + max_staleness
    )
  )
$$;
