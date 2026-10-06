-- Preserve valid historical attribution while separating replacement trust
-- generations and enforcing expiry and promotion invariants for old binaries.
ALTER TABLE actor_principal_mappings
  ADD COLUMN revocation_reason TEXT;

UPDATE actor_principal_mappings
   SET revocation_reason = 'legacy revocation before reason enforcement'
 WHERE revoked_at IS NOT NULL;

ALTER TABLE actor_principal_mappings
  DROP CONSTRAINT actor_principal_mappings_revocation_check,
  ADD CONSTRAINT actor_principal_mappings_revocation_check CHECK (
    (revoked_at IS NULL
      AND revoked_by_principal_id IS NULL
      AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL
      AND revoked_by_principal_id IS NOT NULL
      AND length(btrim(revocation_reason)) BETWEEN 1 AND 500)
  );

CREATE OR REPLACE FUNCTION guard_actor_principal_mapping_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'actor principal mapping history cannot be deleted';
  END IF;
  IF OLD.mapping_id IS DISTINCT FROM NEW.mapping_id
     OR OLD.authority IS DISTINCT FROM NEW.authority
     OR OLD.external_actor_id IS DISTINCT FROM NEW.external_actor_id
     OR OLD.principal_id IS DISTINCT FROM NEW.principal_id
     OR OLD.mapped_by_principal_id IS DISTINCT FROM NEW.mapped_by_principal_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'actor principal mapping identity and target are immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     OR OLD.revoked_by_principal_id IS NOT NULL
     OR OLD.revocation_reason IS NOT NULL THEN
    RAISE EXCEPTION 'actor principal mapping is already revoked';
  END IF;
  IF NEW.revoked_by_principal_id IS NULL
     OR NEW.revocation_reason IS NULL
     OR length(btrim(NEW.revocation_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'actor identity revocation requires an explicit reason';
  END IF;
  PERFORM 1
      FROM scope_memberships sm
      JOIN scopes s ON s.id = sm.scope_id
     WHERE sm.principal_id = NEW.revoked_by_principal_id
       AND sm.role = 'admin' AND s.kind = 'org'
     FOR SHARE OF sm, s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'actor identity revoker must be an org admin';
  END IF;
  NEW.revocation_reason := btrim(NEW.revocation_reason);
  NEW.revoked_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_actor_principal_mapping_revocation() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    NEW.revoked_by_principal_id,
    'write',
    jsonb_build_object(
      'operation', 'revoke_actor_principal_mapping',
      'mapping_id', NEW.mapping_id,
      'authority', NEW.authority,
      'principal_id', NEW.principal_id,
      'reason', NEW.revocation_reason
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE memory_activity_attributions
  ADD COLUMN received_at TIMESTAMPTZ;
DROP TRIGGER reject_memory_activity_attribution_mutation_trigger
  ON memory_activity_attributions;
UPDATE memory_activity_attributions SET received_at = created_at;
ALTER TABLE memory_activity_attributions
  ALTER COLUMN received_at SET NOT NULL,
  ALTER COLUMN received_at SET DEFAULT clock_timestamp();
CREATE TRIGGER reject_memory_activity_attribution_mutation_trigger
  BEFORE UPDATE OR DELETE ON memory_activity_attributions
  FOR EACH ROW EXECUTE FUNCTION reject_activity_history_mutation();

CREATE OR REPLACE FUNCTION validate_memory_activity_attribution() RETURNS trigger AS $$
DECLARE
  mapping_active BOOLEAN;
  promoted_source UUID;
BEGIN
  NEW.received_at := clock_timestamp();
  SELECT CASE
    WHEN memory.metadata->>'promoted_from'
           ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    THEN (memory.metadata->>'promoted_from')::uuid
    ELSE NULL
  END
    INTO promoted_source
    FROM memories memory
   WHERE memory.id = NEW.memory_id;

  IF promoted_source IS NULL THEN
    NEW.activity_at := least(
      NEW.received_at,
      greatest(NEW.activity_at, NEW.received_at - interval '7 days')
    );
  ELSE
    PERFORM 1
      FROM memory_activity_attributions source
     WHERE source.memory_id = promoted_source
       AND source.mapping_id = NEW.mapping_id
       AND source.mapping_authority = NEW.mapping_authority
       AND source.actor_principal_id = NEW.actor_principal_id
       AND source.thread_key = NEW.thread_key
       AND source.activity_at = NEW.activity_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promoted activity attribution must match its trusted source';
    END IF;
  END IF;

  SELECT mapping.revoked_at IS NULL
    INTO mapping_active
    FROM actor_principal_mappings mapping
   WHERE mapping.mapping_id = NEW.mapping_id
     AND mapping.authority = NEW.mapping_authority
     AND mapping.principal_id = NEW.actor_principal_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activity attribution requires an exact actor mapping';
  END IF;
  IF NOT mapping_active AND promoted_source IS NULL THEN
    RAISE EXCEPTION 'activity attribution requires an active exact actor mapping';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_standup_thread_closure() RETURNS trigger AS $$
BEGIN
  SELECT attribution.activity_at
    INTO NEW.closed_at
    FROM memory_activity_attributions attribution
   WHERE attribution.memory_id = NEW.source_memory_id
     AND attribution.actor_principal_id = NEW.actor_principal_id
     AND attribution.mapping_id = NEW.mapping_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread closure requires its trusted source attribution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION clamp_memory_activity_expiry() RETURNS trigger AS $$
DECLARE
  ceiling TIMESTAMPTZ;
BEGIN
  SELECT trust_expires_at INTO ceiling
    FROM memory_activity_attributions
   WHERE memory_id = NEW.id;
  IF ceiling IS NOT NULL AND (NEW.expires_at IS NULL OR NEW.expires_at > ceiling) THEN
    NEW.expires_at := ceiling;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clamp_memory_activity_expiry_trigger
  BEFORE UPDATE OF expires_at ON memories
  FOR EACH ROW EXECUTE FUNCTION clamp_memory_activity_expiry();

CREATE FUNCTION clamp_new_activity_expiry() RETURNS trigger AS $$
BEGIN
  IF NEW.trust_expires_at IS NOT NULL THEN
    UPDATE memories
       SET expires_at = NEW.trust_expires_at
     WHERE id = NEW.memory_id
       AND (expires_at IS NULL OR expires_at > NEW.trust_expires_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clamp_new_activity_expiry_trigger
  AFTER INSERT ON memory_activity_attributions
  FOR EACH ROW EXECUTE FUNCTION clamp_new_activity_expiry();

CREATE FUNCTION require_promoted_activity_attribution() RETURNS trigger AS $$
BEGIN
  IF NEW.state = 'promoted'
     AND (OLD.state IS DISTINCT FROM NEW.state
          OR OLD.promoted_to_id IS DISTINCT FROM NEW.promoted_to_id)
     AND EXISTS (
       SELECT 1 FROM memory_activity_attributions WHERE memory_id = OLD.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM memory_activity_attributions source
         JOIN memory_activity_attributions destination
           ON destination.memory_id = NEW.promoted_to_id
          AND destination.actor_principal_id = source.actor_principal_id
          AND destination.mapping_id = source.mapping_id
          AND destination.mapping_authority = source.mapping_authority
          AND destination.thread_key = source.thread_key
          AND destination.activity_at = source.activity_at
        WHERE source.memory_id = OLD.id
          AND (
            source.trust_expires_at IS NULL
            OR destination.trust_expires_at <= source.trust_expires_at
          )
     ) THEN
    RAISE EXCEPTION 'promotion of trusted activity requires destination trusted attribution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER require_promoted_activity_attribution_trigger
  BEFORE UPDATE OF state, promoted_to_id ON memories
  FOR EACH ROW EXECUTE FUNCTION require_promoted_activity_attribution();
