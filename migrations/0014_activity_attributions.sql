-- Trusted activity is intentionally separate from caller-controlled memory
-- metadata. No legacy metadata is backfilled: it cannot be proven authentic.
CREATE TABLE memory_activity_attributions (
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  thread_owner_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapping_id UUID NOT NULL REFERENCES actor_principal_mappings(mapping_id) ON DELETE RESTRICT,
  mapping_authority TEXT NOT NULL,
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 200),
  thread_key TEXT NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 500),
  activity_at TIMESTAMPTZ NOT NULL,
  trust_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (thread_owner_principal_id = actor_principal_id)
);

CREATE TABLE standup_thread_closures (
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapping_id UUID NOT NULL REFERENCES actor_principal_mappings(mapping_id) ON DELETE RESTRICT,
  thread_key TEXT NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 500),
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (source_memory_id, thread_key)
);

CREATE FUNCTION validate_memory_activity_attribution() RETURNS trigger AS $$
BEGIN
  PERFORM 1
    FROM actor_principal_mappings mapping
   WHERE mapping.mapping_id = NEW.mapping_id
     AND mapping.authority = NEW.mapping_authority
     AND mapping.principal_id = NEW.actor_principal_id
     AND mapping.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activity attribution requires an active exact actor mapping';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_memory_activity_attribution_trigger
  BEFORE INSERT ON memory_activity_attributions
  FOR EACH ROW EXECUTE FUNCTION validate_memory_activity_attribution();

CREATE FUNCTION validate_standup_thread_closure() RETURNS trigger AS $$
BEGIN
  PERFORM 1
    FROM memory_activity_attributions attribution
   WHERE attribution.memory_id = NEW.source_memory_id
     AND attribution.actor_principal_id = NEW.actor_principal_id
     AND attribution.mapping_id = NEW.mapping_id
     AND attribution.activity_at = NEW.closed_at
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'thread closure requires its trusted source attribution';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validate_standup_thread_closure_trigger
  BEFORE INSERT ON standup_thread_closures
  FOR EACH ROW EXECUTE FUNCTION validate_standup_thread_closure();

CREATE FUNCTION reject_activity_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trusted activity history is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_memory_activity_attribution_mutation_trigger
  BEFORE UPDATE OR DELETE ON memory_activity_attributions
  FOR EACH ROW EXECUTE FUNCTION reject_activity_history_mutation();
CREATE TRIGGER reject_standup_thread_closure_mutation_trigger
  BEFORE UPDATE OR DELETE ON standup_thread_closures
  FOR EACH ROW EXECUTE FUNCTION reject_activity_history_mutation();

CREATE FUNCTION reject_reserved_memory_activity_provenance() RETURNS trigger AS $$
BEGIN
  IF current_setting('continuum.maintenance_restore', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.metadata ?| ARRAY[
    '_continuum_activity_provenance', '_continuum_activity_epoch_ms',
    '_continuum_actor_mapping_id', '_continuum_actor_mapping_authority'
  ] THEN
    RAISE EXCEPTION 'reserved activity provenance must use memory_activity_attributions';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_reserved_memory_activity_provenance_trigger
  BEFORE INSERT OR UPDATE OF metadata ON memories
  FOR EACH ROW EXECUTE FUNCTION reject_reserved_memory_activity_provenance();

-- Alias kind is part of identity. Existing aliases remain explicitly legacy
-- and are not silently reinterpreted as numeric provider IDs.
ALTER TABLE principal_aliases ADD COLUMN alias_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE principal_aliases DROP CONSTRAINT principal_aliases_pkey;
ALTER TABLE principal_aliases ADD CONSTRAINT principal_aliases_alias_kind_check
  CHECK (alias_kind IN ('id', 'login', 'subject', 'legacy'));
ALTER TABLE principal_aliases ADD PRIMARY KEY (provider, alias_kind, external_actor);
