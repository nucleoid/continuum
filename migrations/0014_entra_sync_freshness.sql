-- Durable fail-closed freshness state for Entra-sourced access.
CREATE TABLE entra_sync_state (
  singleton             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_success_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failure_at       TIMESTAMPTZ,
  last_failure_code     TEXT,
  max_staleness         INTERVAL NOT NULL DEFAULT interval '24 hours',
  CHECK (max_staleness >= interval '1 hour' AND max_staleness <= interval '168 hours'),
  CHECK ((last_failure_at IS NULL) = (last_failure_code IS NULL))
);

INSERT INTO entra_sync_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Existing active sourced rows receive one rollout grace window. New syncs
-- refresh the durable state; access checks deny all Entra rows after expiry.
UPDATE scope_memberships
   SET synced_at = COALESCE(synced_at, now())
 WHERE source_kind = 'entra' AND active;

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
