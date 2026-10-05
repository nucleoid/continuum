-- Rows created before provenance enforcement are intentionally not backfilled:
-- caller-controlled reserved metadata cannot be distinguished from trusted
-- capture history. New captures receive the marker only after authorization.

DROP INDEX memories_standup_actor_created_idx;
CREATE INDEX memories_standup_actor_created_idx
  ON memories ((metadata->>'actor_principal_id'), created_at DESC, id)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'actor_principal_id';

DROP INDEX memories_standup_thread_idx;
CREATE INDEX memories_standup_thread_idx
  ON memories ((metadata->>'thread_key'), created_at DESC, id)
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'thread_key';

DROP INDEX memories_standup_closures_gin;
CREATE INDEX memories_standup_closures_gin
  ON memories USING gin ((metadata->'closes_thread_keys'))
  WHERE metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'closes_thread_keys';

DROP INDEX memories_standup_open_threads_idx;
CREATE INDEX memories_standup_open_threads_idx
  ON memories ((COALESCE(metadata->>'thread_owner_principal_id',
                         metadata->>'actor_principal_id')), created_at, id)
  WHERE state = 'live' AND type = 'context'
    AND metadata->>'_continuum_activity_provenance' = 'capture-v1'
    AND metadata ? 'thread_key';

DROP TRIGGER validate_actor_principal_mapping_trigger ON actor_principal_mappings;
CREATE TRIGGER validate_actor_principal_mapping_trigger
  BEFORE INSERT ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_actor_principal_mapping();

CREATE FUNCTION audit_actor_principal_mapping_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (principal_id, action, metadata)
  VALUES (
    NEW.mapped_by_principal_id,
    'write',
    jsonb_build_object(
      'operation', 'set_actor_principal_mapping',
      'authority', NEW.authority,
      'external_actor_id', NEW.external_actor_id,
      'principal_id', NEW.principal_id
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_actor_principal_mapping_insert_trigger
  AFTER INSERT ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION audit_actor_principal_mapping_insert();

CREATE FUNCTION reject_actor_principal_mapping_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'actor principal mappings are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_actor_principal_mapping_mutation_trigger
  BEFORE UPDATE OR DELETE ON actor_principal_mappings
  FOR EACH ROW EXECUTE FUNCTION reject_actor_principal_mapping_mutation();
