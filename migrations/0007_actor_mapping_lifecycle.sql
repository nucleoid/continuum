-- Preserve actor mapping history while allowing explicit, audited revocation
-- and replacement. Identity keys and targets remain immutable after insert.
ALTER TABLE actor_principal_mappings
  ADD COLUMN mapping_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_by_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT;

ALTER TABLE actor_principal_mappings
  DROP CONSTRAINT actor_principal_mappings_pkey,
  ADD CONSTRAINT actor_principal_mappings_pkey PRIMARY KEY (mapping_id),
  ADD CONSTRAINT actor_principal_mappings_revocation_check CHECK (
    (revoked_at IS NULL) = (revoked_by_principal_id IS NULL)
  );

CREATE UNIQUE INDEX actor_principal_mappings_active_identity_unique
  ON actor_principal_mappings (authority, external_actor_id)
  WHERE revoked_at IS NULL;

DROP TRIGGER reject_actor_principal_mapping_mutation_trigger
  ON actor_principal_mappings;
DROP FUNCTION reject_actor_principal_mapping_mutation();

CREATE FUNCTION guard_actor_principal_mapping_mutation() RETURNS trigger AS $$
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
  IF OLD.revoked_at IS NOT NULL OR OLD.revoked_by_principal_id IS NOT NULL THEN
    RAISE EXCEPTION 'actor principal mapping is already revoked';
  END IF;
  IF NEW.revoked_by_principal_id IS NULL OR NOT EXISTS (
    SELECT 1
      FROM scope_memberships sm
      JOIN scopes s ON s.id = sm.scope_id
     WHERE sm.principal_id = NEW.revoked_by_principal_id
       AND sm.role = 'admin' AND s.kind = 'org'
  ) THEN
    RAISE EXCEPTION 'actor identity revoker must be an org admin';
  END IF;
  NEW.revoked_at := statement_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER guard_actor_principal_mapping_mutation_trigger
  BEFORE UPDATE OR DELETE ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION guard_actor_principal_mapping_mutation();

CREATE FUNCTION audit_actor_principal_mapping_revocation() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    NEW.revoked_by_principal_id,
    'write',
    jsonb_build_object(
      'operation', 'revoke_actor_principal_mapping',
      'mapping_id', NEW.mapping_id,
      'authority', NEW.authority,
      'external_actor_id', NEW.external_actor_id,
      'principal_id', NEW.principal_id
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_actor_principal_mapping_revocation_trigger
  AFTER UPDATE OF revoked_by_principal_id ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION audit_actor_principal_mapping_revocation();
