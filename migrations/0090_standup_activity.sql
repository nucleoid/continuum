SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Preserve valid exact role profiles before extending the reader contract.
CREATE TEMP TABLE continuum_standup_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$
DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT profile.database_role_oid,role.rolname,profile.profile_kind
    FROM continuum_pgvector_role_profiles profile JOIN pg_catalog.pg_roles role ON role.oid=profile.database_role_oid
    WHERE profile.profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_standup_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Continuum skipped standup grants for role OID % (SQLSTATE %); explicit regrant and startup validation are required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END;
$$;

-- No historical JSON metadata is converted into trusted activity.
CREATE TABLE actor_principal_mappings(
  mapping_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  authority TEXT NOT NULL CHECK(length(authority) BETWEEN 1 AND 100),
  external_actor_id TEXT NOT NULL CHECK(length(external_actor_id) BETWEEN 1 AND 200),
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapped_by_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  revoked_at TIMESTAMPTZ,
  revoked_by_principal_id UUID REFERENCES principals(id) ON DELETE RESTRICT,
  revocation_reason TEXT CHECK(length(revocation_reason)<=500),
  CHECK((revoked_at IS NULL)=(revoked_by_principal_id IS NULL))
);
CREATE UNIQUE INDEX actor_principal_mappings_active_identity_unique
  ON actor_principal_mappings(authority,external_actor_id) WHERE revoked_at IS NULL;
CREATE INDEX actor_principal_mappings_principal_idx ON actor_principal_mappings(principal_id,mapping_id);
CREATE TABLE memory_activity_attributions(
  memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  thread_owner_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapping_id UUID NOT NULL REFERENCES actor_principal_mappings(mapping_id) ON DELETE RESTRICT,
  mapping_authority TEXT NOT NULL,
  actor_label TEXT NOT NULL CHECK(length(actor_label) BETWEEN 1 AND 200),
  thread_key TEXT NOT NULL CHECK(length(thread_key) BETWEEN 1 AND 500),
  activity_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  trust_expires_at TIMESTAMPTZ,
  CHECK(thread_owner_principal_id=actor_principal_id)
);
CREATE INDEX memory_activity_attributions_actor_time_idx
  ON memory_activity_attributions(actor_principal_id,activity_at,memory_id);
CREATE INDEX memory_activity_attributions_mapping_thread_idx
  ON memory_activity_attributions(mapping_id,thread_key,activity_at,memory_id);
CREATE TABLE standup_thread_closures(
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  actor_principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  mapping_id UUID NOT NULL REFERENCES actor_principal_mappings(mapping_id) ON DELETE RESTRICT,
  thread_key TEXT NOT NULL CHECK(length(thread_key) BETWEEN 1 AND 500),
  closed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(source_memory_id,thread_key)
);
CREATE INDEX standup_thread_closures_generation_idx
  ON standup_thread_closures(actor_principal_id,mapping_id,thread_key,closed_at);
REVOKE ALL ON actor_principal_mappings,memory_activity_attributions,standup_thread_closures FROM PUBLIC;
-- Runtime readers receive no raw attribution, closure or mapping mutation rights.
DO $$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema();
BEGIN
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''promotion_events'',''SELECT'')',
    '(''promotion_events'',''SELECT''),(''actor_principal_mappings'',''SELECT''),(''memory_activity_attributions'',''SELECT''),(''standup_thread_closures'',''SELECT'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup reader allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_standup_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT ON %I.actor_principal_mappings,%I.memory_activity_attributions,%I.standup_thread_closures TO %I',
      schema_name,schema_name,schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$$;


-- A shared APP session is not proof of an authenticated producer. Only an
-- explicitly bound actual LOGIN session can publish activity for its family.
CREATE TABLE standup_producer_bindings(
  binding_id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  role_oid OID NOT NULL, role_name NAME NOT NULL,
  principal_id UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  authority TEXT NOT NULL CHECK(authority~'^[a-z][a-z0-9.-]{0,99}$'),
  source_family TEXT NOT NULL CHECK(source_family IN ('github','deploy-event','terminal-summary')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX standup_producer_active_role_idx ON standup_producer_bindings(role_oid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX standup_producer_active_name_idx ON standup_producer_bindings(role_name) WHERE revoked_at IS NULL;
-- Retain only the number of identity generations, without subject, mapping or
-- timestamp links. Erasure can destroy the reversible alias on mapping rows
-- without making a later replacement appear to be the first generation.
CREATE TABLE standup_identity_generation_counts(
  authority TEXT NOT NULL,
  external_actor_hash TEXT NOT NULL,
  generation_count BIGINT NOT NULL CHECK(generation_count>0),
  PRIMARY KEY(authority,external_actor_hash)
);
REVOKE ALL ON standup_identity_generation_counts FROM PUBLIC;
REVOKE ALL ON standup_producer_bindings FROM PUBLIC;
CREATE FUNCTION continuum_require_standup_operator(actor_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM continuum_require_trusted_database_identity(actor_id,'approve');
  IF NOT EXISTS(SELECT 1 FROM principals actor JOIN scope_memberships membership ON membership.principal_id=actor.id
    WHERE actor.id=actor_id AND actor.disabled_at IS NULL AND membership.scope_id=continuum_org_scope_id()
      AND membership.active AND membership.role='admin' AND membership.source_kind='manual' AND membership.source_id='manual') THEN
    RAISE insufficient_privilege USING MESSAGE='standup configuration requires a current manual organization administrator';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_standup_operator(UUID) FROM PUBLIC;
CREATE FUNCTION continuum_operator_bind_standup_producer(actor_id UUID,database_role NAME,producer_id UUID,namespace TEXT,family TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout='1s' AS $$
DECLARE role_id OID; existing standup_producer_bindings%ROWTYPE; result UUID;
BEGIN
  PERFORM continuum_require_standup_operator(actor_id);
  -- Revocation operates on the immutable stored identity even when its role
  -- was dropped, recreated, renamed or acquired dangerous privileges.
  SELECT * INTO existing FROM standup_producer_bindings WHERE role_name=database_role AND revoked_at IS NULL FOR UPDATE;
  IF producer_id IS NULL THEN
    IF existing.binding_id IS NULL THEN RAISE check_violation USING MESSAGE='standup producer binding does not exist'; END IF;
    UPDATE standup_producer_bindings SET revoked_at=statement_timestamp() WHERE binding_id=existing.binding_id;
    result:=existing.binding_id;
  ELSE
    SELECT oid INTO role_id FROM pg_catalog.pg_roles WHERE rolname=database_role AND rolcanlogin
      AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls;
    IF role_id IS NULL THEN RAISE check_violation USING MESSAGE='standup producer requires a least-privilege LOGIN role'; END IF;
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE (edge.member=role_id OR edge.roleid=role_id)
      AND NOT (edge.roleid=role_id AND edge.member=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='principals'::regclass)
        AND edge.admin_option AND NOT edge.set_option AND NOT edge.inherit_option)) THEN
      RAISE check_violation USING MESSAGE='standup producer requires an isolated database role';
    END IF;
    IF namespace IS NULL OR namespace!~'^[a-z][a-z0-9.-]{0,99}$' OR family IS NULL OR family NOT IN ('github','deploy-event','terminal-summary') THEN
      RAISE check_violation USING MESSAGE='standup producer namespace or source family is invalid';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('standup-family:'||namespace,0));
    IF EXISTS(SELECT 1 FROM standup_producer_bindings historical
      WHERE historical.authority=namespace AND historical.source_family<>family) THEN
      RAISE check_violation USING MESSAGE='standup namespace source family is immutable';
    END IF;
    PERFORM continuum_assert_standup_application_role_allowlist(database_role,FALSE);
    PERFORM 1 FROM principals WHERE id=producer_id AND kind='service' AND disabled_at IS NULL FOR KEY SHARE;
    IF NOT FOUND THEN RAISE check_violation USING MESSAGE='standup producer requires an enabled service principal'; END IF;
    IF existing.binding_id IS NOT NULL THEN
      IF existing.role_oid<>role_id OR existing.principal_id<>producer_id OR existing.authority<>namespace OR existing.source_family<>family THEN
        RAISE check_violation USING MESSAGE='standup producer identity is immutable; revoke before replacement';
      END IF;
      RETURN existing.binding_id;
    END IF;
    INSERT INTO standup_producer_bindings(role_oid,role_name,principal_id,authority,source_family)
      VALUES(role_id,database_role,producer_id,namespace,family) RETURNING binding_id INTO result;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor_id,'write',continuum_org_scope_id(),
    jsonb_build_object('operation','standup_producer_binding_changed','binding_id',result,'revoked',producer_id IS NULL));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_bind_standup_producer(UUID,NAME,UUID,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION continuum_operator_map_standup_actor(actor_id UUID,namespace TEXT,external_id TEXT,target_id UUID,reason TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout='1s' AS $$
DECLARE identity_hash TEXT; previous actor_principal_mappings%ROWTYPE; result UUID;
BEGIN
  PERFORM continuum_require_standup_operator(actor_id);
  IF namespace IS NULL OR namespace!~'^[a-z][a-z0-9.-]{0,99}$' OR external_id IS NULL
    OR length(external_id) NOT BETWEEN 1 AND 200 OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 500 THEN
    RAISE check_violation USING MESSAGE='standup actor mapping is outside the supported bounds';
  END IF;
  identity_hash:=encode(sha256(convert_to(namespace||':'||external_id,'UTF8')),'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(namespace||':'||identity_hash,0));
  SELECT * INTO previous FROM actor_principal_mappings WHERE authority=namespace AND external_actor_id=identity_hash AND revoked_at IS NULL FOR UPDATE;
  IF target_id IS NULL AND previous.mapping_id IS NULL THEN
    RAISE check_violation USING MESSAGE='standup actor mapping does not exist';
  END IF;
  IF target_id IS NOT NULL THEN
    PERFORM 1 FROM principals WHERE id=target_id AND kind='user' AND disabled_at IS NULL FOR KEY SHARE;
    IF NOT FOUND THEN RAISE check_violation USING MESSAGE='standup actor mapping requires an enabled user'; END IF;
  END IF;
  IF previous.mapping_id IS NOT NULL THEN
    UPDATE actor_principal_mappings SET revoked_at=statement_timestamp(),revoked_by_principal_id=actor_id,revocation_reason=reason
      WHERE mapping_id=previous.mapping_id;
  END IF;
  IF target_id IS NOT NULL THEN
    INSERT INTO standup_identity_generation_counts(authority,external_actor_hash,generation_count)
      VALUES(namespace,identity_hash,1)
      ON CONFLICT(authority,external_actor_hash) DO UPDATE
        SET generation_count=standup_identity_generation_counts.generation_count+1;
    INSERT INTO actor_principal_mappings(authority,external_actor_id,principal_id,mapped_by_principal_id)
      VALUES(namespace,identity_hash,target_id,actor_id) RETURNING mapping_id INTO result;
  ELSE result:=previous.mapping_id;
  END IF;
  INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(actor_id,'write',continuum_org_scope_id(),
    jsonb_build_object('operation','standup_actor_mapping_changed','mapping_id',result,'principal_id',target_id,'revoked',target_id IS NULL));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_map_standup_actor(UUID,TEXT,TEXT,UUID,TEXT) FROM PUBLIC;

CREATE FUNCTION continuum_record_standup_activity(target_memory UUID,proof JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET lock_timeout='1s' AS $$
DECLARE producer standup_producer_bindings%ROWTYPE; mapping actor_principal_mappings%ROWTYPE;
  memory memories%ROWTYPE; actor_name TEXT; source_time TIMESTAMPTZ; identity_hash TEXT; thread TEXT; branch TEXT;
  closes TEXT[]:='{}'; artifact TEXT; source_kind_value TEXT; mapping_count BIGINT;
BEGIN
  IF pg_catalog.current_setting('role')<>'none' THEN
    RAISE insufficient_privilege USING MESSAGE='standup activity requires the actual bound producer session';
  END IF;
  SELECT binding.* INTO producer FROM standup_producer_bindings binding JOIN pg_catalog.pg_roles role
    ON role.oid=binding.role_oid AND role.rolname=binding.role_name
    WHERE role.rolname=session_user AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreaterole
      AND NOT role.rolcreatedb AND NOT role.rolreplication AND NOT role.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE (edge.member=role.oid OR edge.roleid=role.oid)
        AND NOT (edge.roleid=role.oid AND edge.member=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='principals'::regclass)
          AND edge.admin_option AND NOT edge.set_option AND NOT edge.inherit_option))
      AND binding.revoked_at IS NULL FOR SHARE OF binding;
  IF producer.binding_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='standup activity requires a bound producer'; END IF;
  IF jsonb_typeof(proof)<>'object' OR proof IS NULL OR octet_length(proof::text)>8192 THEN
    RAISE check_violation USING MESSAGE='standup source proof is outside the supported bounds';
  END IF;
  SELECT * INTO memory FROM memories WHERE id=target_memory FOR UPDATE;
  IF memory.id IS NULL OR memory.author_id<>producer.principal_id OR memory.state<>'live'
    OR (memory.expires_at IS NOT NULL AND memory.expires_at<=clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM principals WHERE id=producer.principal_id AND disabled_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM scope_memberships membership WHERE membership.principal_id=producer.principal_id
      AND membership.scope_id=memory.scope_id AND membership.role IN ('writer','admin')
      AND continuum_membership_is_effective(membership.active,membership.source_kind)) THEN
    RAISE insufficient_privilege USING MESSAGE='standup source is unavailable to its producer';
  END IF;
  source_kind_value:=memory.source;
  IF (producer.source_family='github' AND source_kind_value NOT IN ('github-pr','github-branch'))
    OR (producer.source_family<>'github' AND source_kind_value<>producer.source_family) THEN
    RAISE insufficient_privilege USING MESSAGE='standup source family does not match its producer';
  END IF;
  IF proof->>'external_actor_id' IS NULL OR length(proof->>'external_actor_id') NOT BETWEEN 1 AND 200 THEN
    RAISE check_violation USING MESSAGE='standup source actor identity is invalid';
  END IF;
  IF producer.source_family='github' AND (proof->>'external_actor_id'!~'^[1-9][0-9]{0,19}$'
    OR COALESCE(proof->>'repository_id','')!~'^[1-9][0-9]{0,19}$') THEN
    RAISE check_violation USING MESSAGE='GitHub standup identity requires stable numeric IDs';
  END IF;
  identity_hash:=encode(sha256(convert_to(producer.authority||':'||(proof->>'external_actor_id'),'UTF8')),'hex');
  SELECT * INTO mapping FROM actor_principal_mappings WHERE authority=producer.authority
    AND external_actor_id=identity_hash AND revoked_at IS NULL FOR SHARE;
  IF mapping.mapping_id IS NULL THEN RETURN FALSE; END IF;
  SELECT principals.display_name INTO actor_name FROM principals WHERE principals.id=mapping.principal_id AND principals.kind='user' AND principals.disabled_at IS NULL FOR KEY SHARE;
  IF actor_name IS NULL THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM scopes WHERE scopes.id=memory.scope_id AND scopes.kind='user') AND NOT EXISTS(
    SELECT 1 FROM principal_user_scopes ownership WHERE ownership.scope_id=memory.scope_id AND ownership.principal_id=mapping.principal_id) THEN
    RETURN FALSE;
  END IF;
  IF proof->>'event_time' IS NULL THEN
    SELECT generation_count INTO mapping_count FROM standup_identity_generation_counts WHERE authority=producer.authority AND external_actor_hash=identity_hash;
    IF mapping_count IS DISTINCT FROM 1 THEN RETURN FALSE; END IF;
    source_time:=memory.created_at;
  ELSE
    BEGIN source_time:=(proof->>'event_time')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN FALSE; END;
  END IF;
  IF NOT isfinite(source_time) OR source_time>statement_timestamp() OR source_time<mapping.created_at THEN RETURN FALSE; END IF;
  -- Canonical key material is derived here, never from a caller closure array.
  IF source_kind_value IN ('github-pr','github-branch') THEN
    IF COALESCE(proof->>'branch','')='' OR length(proof->>'branch')>500 THEN
      RAISE check_violation USING MESSAGE='standup branch identity is invalid';
    END IF;
    branch:=producer.authority||':branch:'||(proof->>'repository_id')||':'||(proof->>'branch');
    IF source_kind_value='github-pr' THEN
      IF COALESCE(proof->>'pull_request_number','')!~'^[1-9][0-9]{0,19}$' THEN
        RAISE check_violation USING MESSAGE='standup pull request identity is invalid';
      END IF;
      artifact:=producer.authority||':pr:'||(proof->>'repository_id')||':'||(proof->>'pull_request_number');
      IF proof->'merged'='true'::jsonb THEN
        closes:=ARRAY[artifact];
        -- A PR repository is the base repository. Only a known head repository
        -- identifies the branch; a missing/deleted fork cannot close its base.
        IF COALESCE(proof->>'head_repository_id','')~'^[1-9][0-9]{0,19}$' THEN
          branch:=producer.authority||':branch:'||(proof->>'head_repository_id')||':'||(proof->>'branch');
          closes:=array_append(closes,branch);
        END IF;
      END IF;
    ELSE artifact:=branch; END IF;
  ELSE
    IF COALESCE(proof->>'artifact_id','')='' OR length(proof->>'artifact_id')>500 THEN
      RAISE check_violation USING MESSAGE='standup source artifact identity is invalid';
    END IF;
    artifact:=producer.authority||':'||source_kind_value||':'||(proof->>'artifact_id');
    IF source_kind_value='deploy-event' OR proof->'finished'='true'::jsonb THEN closes:=ARRAY[artifact]; END IF;
  END IF;
  thread:='sha256:'||encode(sha256(convert_to(artifact,'UTF8')),'hex');
  INSERT INTO memory_activity_attributions(memory_id,actor_principal_id,thread_owner_principal_id,mapping_id,mapping_authority,
    actor_label,thread_key,activity_at,trust_expires_at)
    VALUES(memory.id,mapping.principal_id,mapping.principal_id,mapping.mapping_id,mapping.authority,left(actor_name,200),thread,source_time,memory.expires_at);
  INSERT INTO standup_thread_closures(source_memory_id,actor_principal_id,mapping_id,thread_key,closed_at)
    SELECT memory.id,mapping.principal_id,mapping.mapping_id,'sha256:'||encode(sha256(convert_to(value,'UTF8')),'hex'),source_time FROM unnest(closes) value;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION continuum_record_standup_activity(UUID,JSONB) FROM PUBLIC;

DO $$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema(); function_record RECORD;
BEGIN
  FOR function_record IN SELECT proname,pg_catalog.pg_get_function_identity_arguments(oid) arguments FROM pg_catalog.pg_proc
    WHERE pronamespace=(SELECT namespace.oid FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname=schema_name)
      AND proname=ANY(ARRAY['continuum_require_standup_operator','continuum_operator_bind_standup_producer',
        'continuum_operator_map_standup_actor','continuum_record_standup_activity']) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
  END LOOP;
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''continuum_promotion_outbox_is_ready()'')',
    '(''continuum_promotion_outbox_is_ready()''),(''continuum_record_standup_activity(uuid,jsonb)'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup producer capability allowlist'; END IF;
  definition:=revised;
  revised:=replace(definition,'(''continuum_operator_set_promotion_webhook_ids(uuid,text[])'')',
    '(''continuum_operator_set_promotion_webhook_ids(uuid,text[])''),(''continuum_operator_bind_standup_producer(uuid,name,uuid,text,text)''),(''continuum_operator_map_standup_actor(uuid,text,text,uuid,text)'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup operator allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_standup_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_record_standup_activity(UUID,JSONB) TO %I',schema_name,candidate.role_name);
    IF candidate.operator THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_bind_standup_producer(UUID,NAME,UUID,TEXT,TEXT),%I.continuum_operator_map_standup_actor(UUID,TEXT,TEXT,UUID,TEXT) TO %I',schema_name,schema_name,candidate.role_name);
    END IF;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$$;

-- The published validator deliberately authorizes its invoking session as the
-- migration owner. Keep it unchanged. This private owner-only copy evaluates
-- the same complete catalog contract inside the checked operator capability.
DO $$
DECLARE definition TEXT; revised TEXT;
  caller_marker CONSTANT TEXT:=E'IF (SELECT oid FROM pg_roles WHERE rolname = continuum_invoking_database_role()) <> owner_oid\n    AND (SELECT oid FROM pg_roles WHERE rolname = continuum_invoking_database_role()) <> (SELECT oid FROM pg_roles WHERE rolname = target_database_role) THEN';
BEGIN
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'continuum_assert_application_role_allowlist','continuum_assert_standup_application_role_allowlist');
  IF revised=definition THEN RAISE EXCEPTION 'unable to install standup private profile verification'; END IF;
  definition:=revised;
  revised:=replace(definition,caller_marker,'IF (SELECT oid FROM pg_roles WHERE rolname = current_user) <> owner_oid THEN');
  IF revised=definition THEN RAISE EXCEPTION 'unable to anchor standup private profile verification to its owner'; END IF;
  EXECUTE revised;
END;
$$;
REVOKE ALL ON FUNCTION continuum_assert_standup_application_role_allowlist(NAME,BOOLEAN) FROM PUBLIC;


-- Trusted expiry can narrow, but neither verification nor a promoted copy can
-- turn the original bounded activity into an unlimited activity record.
CREATE FUNCTION continuum_guard_standup_memory_lifetime() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE attribution memory_activity_attributions%ROWTYPE; source_memory memories%ROWTYPE; source_id UUID;
BEGIN
  -- Canonical archived erasure remains terminal and unreadable. Preserve the
  -- immutable trust ceiling without obstructing its cleared memory expiry.
  IF NEW.state='archived' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    SELECT * INTO attribution FROM memory_activity_attributions WHERE memory_id=OLD.id FOR UPDATE;
  ELSIF jsonb_typeof(NEW.metadata->'promoted_from')='string' THEN
    BEGIN source_id:=(NEW.metadata->>'promoted_from')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
    SELECT * INTO source_memory FROM memories WHERE id=source_id FOR SHARE;
    SELECT * INTO attribution FROM memory_activity_attributions WHERE memory_id=source_id FOR SHARE;
    IF source_memory.expires_at IS NOT NULL AND attribution.memory_id IS NOT NULL THEN
      NEW.expires_at:=LEAST(NEW.expires_at,source_memory.expires_at);
    END IF;
  END IF;
  IF attribution.memory_id IS NOT NULL AND attribution.trust_expires_at IS NOT NULL THEN
    NEW.expires_at:=LEAST(NEW.expires_at,attribution.trust_expires_at);
  END IF;
  IF TG_OP='UPDATE' AND attribution.memory_id IS NOT NULL AND NEW.expires_at IS NOT NULL
    AND (attribution.trust_expires_at IS NULL OR NEW.expires_at<attribution.trust_expires_at) THEN
    UPDATE memory_activity_attributions SET trust_expires_at=NEW.expires_at WHERE memory_id=OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_standup_memory_lifetime() FROM PUBLIC;
CREATE TRIGGER guard_standup_memory_lifetime BEFORE INSERT OR UPDATE OF expires_at ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_guard_standup_memory_lifetime();
CREATE FUNCTION continuum_clone_standup_promotion() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id UUID; source_memory memories%ROWTYPE; attribution memory_activity_attributions%ROWTYPE;
BEGIN
  IF jsonb_typeof(NEW.metadata->'promoted_from')<>'string' OR NEW.metadata->>'promoted_from' IS NULL THEN RETURN NEW; END IF;
  BEGIN source_id:=(NEW.metadata->>'promoted_from')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
  SELECT * INTO source_memory FROM memories WHERE id=source_id FOR SHARE;
  SELECT original.* INTO attribution FROM memory_activity_attributions original JOIN actor_principal_mappings mapping
    ON mapping.mapping_id=original.mapping_id AND mapping.authority=original.mapping_authority AND mapping.principal_id=original.actor_principal_id
    WHERE original.memory_id=source_id AND (mapping.revoked_at IS NULL OR mapping.revoked_at>=original.received_at) FOR SHARE OF original,mapping;
  IF attribution.memory_id IS NULL OR source_memory.state<>'live'
    OR (source_memory.expires_at IS NOT NULL AND source_memory.expires_at<=clock_timestamp())
    OR (attribution.trust_expires_at IS NOT NULL AND attribution.trust_expires_at<=clock_timestamp()) THEN RETURN NEW; END IF;
  INSERT INTO memory_activity_attributions(memory_id,actor_principal_id,thread_owner_principal_id,mapping_id,mapping_authority,
    actor_label,thread_key,activity_at,received_at,trust_expires_at)
    VALUES(NEW.id,attribution.actor_principal_id,attribution.thread_owner_principal_id,attribution.mapping_id,attribution.mapping_authority,
      attribution.actor_label,attribution.thread_key,attribution.activity_at,attribution.received_at,
      LEAST(attribution.trust_expires_at,source_memory.expires_at,NEW.expires_at));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION continuum_clone_standup_promotion() FROM PUBLIC;
CREATE TRIGGER clone_standup_promotion AFTER INSERT ON memories FOR EACH ROW EXECUTE FUNCTION continuum_clone_standup_promotion();
CREATE FUNCTION continuum_require_standup_promotion_lineage() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE source_id UUID; source_memory memories%ROWTYPE; attribution memory_activity_attributions%ROWTYPE;
BEGIN
  SELECT * INTO attribution FROM memory_activity_attributions WHERE memory_id=NEW.id;
  IF attribution.memory_id IS NULL OR jsonb_typeof(NEW.metadata->'promoted_from')<>'string'
    OR NEW.metadata->>'promoted_from' IS NULL THEN RETURN NULL; END IF;
  BEGIN source_id:=(NEW.metadata->>'promoted_from')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE check_violation USING MESSAGE='standup promotion requires canonical source lineage'; END;
  SELECT * INTO source_memory FROM memories WHERE id=source_id;
  IF NEW.scope_id=source_memory.scope_id
    OR ROW(NEW.type,NEW.title,NEW.body,NEW.source_ref,NEW.tags) IS DISTINCT FROM
       ROW(source_memory.type,source_memory.title,source_memory.body,source_memory.source_ref,source_memory.tags)
    OR NEW.source IS DISTINCT FROM 'promote:'||source_memory.source
    OR NEW.metadata IS DISTINCT FROM ((source_memory.metadata-ARRAY['related','actor','actor_principal_id',
      'thread_owner_principal_id','thread_key','closes_thread_keys','_continuum_activity_provenance','_continuum_activity_epoch_ms',
      '_continuum_actor_mapping_id','_continuum_actor_mapping_authority']::text[])||jsonb_build_object('promoted_from',source_id::text))
    OR NOT EXISTS(SELECT 1 FROM principals promoter WHERE promoter.id=NEW.author_id AND promoter.disabled_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM scope_memberships membership WHERE membership.principal_id=NEW.author_id
      AND membership.scope_id=source_memory.scope_id AND membership.role IN ('writer','admin')
      AND continuum_membership_is_effective(membership.active,membership.source_kind))
    OR NOT EXISTS(SELECT 1 FROM scope_memberships membership JOIN scopes destination ON destination.id=membership.scope_id
      WHERE membership.principal_id=NEW.author_id AND membership.scope_id=NEW.scope_id
        AND (membership.role='admin' OR (destination.kind<>'org' AND membership.role='writer'))
        AND continuum_membership_is_effective(membership.active,membership.source_kind)) THEN
    RAISE check_violation USING MESSAGE='standup promotion requires an authorized canonical source copy',CONSTRAINT='standup_promotion_canonical_copy';
  END IF;
  IF source_memory.state<>'promoted' OR source_memory.promoted_to_id IS DISTINCT FROM NEW.id
    OR NOT EXISTS(SELECT 1 FROM memory_activity_attributions original WHERE original.memory_id=source_id
      AND original.actor_principal_id=attribution.actor_principal_id AND original.mapping_id=attribution.mapping_id
      AND original.thread_key=attribution.thread_key AND original.activity_at=attribution.activity_at)
    OR (source_memory.expires_at IS NOT NULL AND (attribution.trust_expires_at IS NULL OR attribution.trust_expires_at>source_memory.expires_at)) THEN
    RAISE check_violation USING MESSAGE='standup promotion requires reciprocal bounded source lineage';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION continuum_require_standup_promotion_lineage() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER require_standup_promotion_lineage AFTER INSERT ON memories
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION continuum_require_standup_promotion_lineage();
DO $$
DECLARE function_record RECORD; schema_name TEXT:=current_schema();
BEGIN
  FOR function_record IN SELECT proname,pg_catalog.pg_get_function_identity_arguments(oid) arguments FROM pg_catalog.pg_proc
    WHERE pronamespace=(SELECT namespace.oid FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname=schema_name)
      AND proname=ANY(ARRAY['continuum_guard_standup_memory_lifetime','continuum_clone_standup_promotion','continuum_require_standup_promotion_lineage']) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
  END LOOP;
END;
$$;


-- Active attribution cites this captured source. Ordinary memory mutation may
-- change lifecycle and advisory metadata, not replace its author or evidence.
CREATE FUNCTION continuum_guard_standup_source_provenance() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE approved_actor UUID; schema_name TEXT:=current_schema();
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_activity_attributions WHERE memory_id=OLD.id) THEN RETURN NEW; END IF;
  IF ROW(NEW.scope_id,NEW.author_id,NEW.type,NEW.title,NEW.body,NEW.source,NEW.source_ref)
    IS NOT DISTINCT FROM ROW(OLD.scope_id,OLD.author_id,OLD.type,OLD.title,OLD.body,OLD.source,OLD.source_ref) THEN RETURN NEW; END IF;
  IF NEW.scope_id=OLD.scope_id AND NEW.author_id=OLD.author_id AND NEW.type='context'
    AND NEW.title='[erased]' AND NEW.body='[erased]' AND NEW.state='archived'
    AND NEW.metadata='{}'::jsonb AND NEW.tags='{}'::text[] AND NEW.source='erased' AND NEW.source_ref IS NULL
    AND NEW.expires_at IS NULL AND NEW.last_verified IS NULL AND NEW.supersedes_id IS NULL AND NEW.promoted_to_id IS NULL THEN
    SELECT COALESCE((SELECT takeover.to_actor FROM principal_offboarding_takeover_events takeover
      WHERE takeover.run_id=run.run_id ORDER BY takeover.id DESC LIMIT 1),run.initiated_by)
      INTO approved_actor FROM principal_offboarding_runs run
      JOIN principal_user_scopes ownership ON ownership.principal_id=run.principal_id AND ownership.scope_id=run.scope_id
      JOIN principals target ON target.id=run.principal_id
      WHERE run.scope_id=OLD.scope_id AND run.completed_at IS NULL AND target.disabled_at IS NOT NULL
      ORDER BY run.started_at DESC LIMIT 1;
    IF approved_actor IS NOT NULL THEN
      PERFORM continuum_require_trusted_database_identity(approved_actor,'approve');
      RETURN NEW;
    END IF;
  END IF;
  RAISE check_violation USING MESSAGE='trusted activity source provenance is immutable',CONSTRAINT='standup_source_immutable';
END;
$$;
REVOKE ALL ON FUNCTION continuum_guard_standup_source_provenance() FROM PUBLIC;
CREATE TRIGGER guard_standup_source_provenance BEFORE UPDATE ON memories
FOR EACH ROW EXECUTE FUNCTION continuum_guard_standup_source_provenance();
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.continuum_guard_standup_source_provenance() SET search_path=pg_catalog,%I,pg_temp',current_schema(),current_schema());
END;
$$;


CREATE FUNCTION continuum_standup_producer_context() RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT CASE WHEN pg_catalog.current_setting('role')='none' THEN (
    SELECT jsonb_build_object('principal_id',binding.principal_id,'authority',binding.authority,'source_family',binding.source_family)
      FROM standup_producer_bindings binding JOIN pg_catalog.pg_roles role ON role.oid=binding.role_oid AND role.rolname=binding.role_name
      JOIN principals producer ON producer.id=binding.principal_id AND producer.disabled_at IS NULL
      WHERE role.rolname=session_user AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreaterole
      AND NOT role.rolcreatedb AND NOT role.rolreplication AND NOT role.rolbypassrls
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members edge WHERE (edge.member=role.oid OR edge.roleid=role.oid)
        AND NOT (edge.roleid=role.oid AND edge.member=(SELECT relowner FROM pg_catalog.pg_class WHERE oid='principals'::regclass)
          AND edge.admin_option AND NOT edge.set_option AND NOT edge.inherit_option))
      AND binding.revoked_at IS NULL
  ) ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION continuum_standup_producer_context() FROM PUBLIC;
CREATE FUNCTION continuum_standup_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT to_regclass('actor_principal_mappings') IS NOT NULL AND to_regclass('memory_activity_attributions') IS NOT NULL
    AND to_regclass('standup_thread_closures') IS NOT NULL AND to_regclass('standup_producer_bindings') IS NOT NULL
    AND to_regprocedure('continuum_record_standup_activity(uuid,jsonb)') IS NOT NULL
    AND to_regprocedure('continuum_operator_map_standup_actor(uuid,text,text,uuid,text)') IS NOT NULL
    AND to_regprocedure('continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)') IS NOT NULL
    AND to_regprocedure('continuum_guard_standup_source_provenance()') IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION continuum_standup_is_ready() FROM PUBLIC;
DO $$
DECLARE definition TEXT; revised TEXT; candidate RECORD; schema_name TEXT:=current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.continuum_standup_producer_context() SET search_path=pg_catalog,%I,pg_temp',schema_name,schema_name);
  EXECUTE format('ALTER FUNCTION %I.continuum_standup_is_ready() SET search_path=pg_catalog,%I,pg_temp',schema_name,schema_name);
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''continuum_record_standup_activity(uuid,jsonb)'')',
    '(''continuum_record_standup_activity(uuid,jsonb)''),(''continuum_standup_producer_context()''),(''continuum_standup_is_ready()'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup readiness allowlist'; END IF;
  EXECUTE revised;
  -- Keep the private target-profile checker synchronized with this forward extension.
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_standup_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''continuum_record_standup_activity(uuid,jsonb)'')',
    '(''continuum_record_standup_activity(uuid,jsonb)''),(''continuum_standup_producer_context()''),(''continuum_standup_is_ready()'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup private readiness allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_standup_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_standup_producer_context(),%I.continuum_standup_is_ready() TO %I',schema_name,schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END;
$$;


CREATE INDEX standup_attribution_privacy_actor_idx ON memory_activity_attributions(actor_principal_id,memory_id) WHERE actor_label<>'[erased]';
CREATE FUNCTION continuum_operator_scrub_standup_scope(authorization_principal_id UUID,target_principal_id UUID,target_scope_id UUID,batch_limit INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE labels_processed INTEGER; mappings_processed INTEGER; clean BOOLEAN; privacy_run principal_offboarding_runs%ROWTYPE;
BEGIN
  IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 1000 THEN RAISE check_violation USING MESSAGE='standup privacy batch is outside the supported range'; END IF;
  PERFORM * FROM continuum_operator_coordination_scope_privacy_state(authorization_principal_id,target_scope_id);
  IF NOT EXISTS(SELECT 1 FROM principal_user_scopes WHERE principal_id=target_principal_id AND scope_id=target_scope_id) THEN
    RAISE insufficient_privilege USING MESSAGE='standup privacy requires the approved target mapping';
  END IF;
  SELECT * INTO privacy_run FROM principal_offboarding_runs WHERE principal_id=target_principal_id AND scope_id=target_scope_id FOR UPDATE;
  IF privacy_run.run_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='standup privacy requires an authorized lifecycle run'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT memory_id FROM (
      (SELECT memory_id FROM memory_activity_attributions WHERE actor_principal_id=target_principal_id AND actor_label<>'[erased]' ORDER BY memory_id LIMIT batch_limit)
      UNION
      (SELECT attribution.memory_id FROM memories memory JOIN memory_activity_attributions attribution ON attribution.memory_id=memory.id
        WHERE memory.scope_id=target_scope_id AND attribution.actor_label<>'[erased]' ORDER BY attribution.memory_id LIMIT batch_limit)
    ) raw ORDER BY memory_id LIMIT batch_limit
  ), locked AS MATERIALIZED (
    SELECT attribution.memory_id FROM memory_activity_attributions attribution JOIN candidates USING(memory_id)
      WHERE attribution.actor_label<>'[erased]' ORDER BY attribution.memory_id FOR UPDATE OF attribution SKIP LOCKED
  ) UPDATE memory_activity_attributions attribution SET actor_label='[erased]'
      FROM locked WHERE attribution.memory_id=locked.memory_id;
  GET DIAGNOSTICS labels_processed=ROW_COUNT;
  WITH candidates AS MATERIALIZED (
    SELECT mapping_id FROM actor_principal_mappings WHERE principal_id=target_principal_id
      AND (revoked_at IS NULL OR revocation_reason IS DISTINCT FROM '[erased]' OR external_actor_id IS DISTINCT FROM 'erased:'||mapping_id::text) ORDER BY mapping_id LIMIT batch_limit FOR UPDATE SKIP LOCKED
  ) UPDATE actor_principal_mappings mapping SET revoked_at=COALESCE(mapping.revoked_at,statement_timestamp()),
      revoked_by_principal_id=COALESCE(mapping.revoked_by_principal_id,authorization_principal_id),revocation_reason='[erased]',
      external_actor_id='erased:'||mapping.mapping_id::text
      FROM candidates WHERE mapping.mapping_id=candidates.mapping_id;
  GET DIAGNOSTICS mappings_processed=ROW_COUNT;
  clean:=NOT EXISTS(SELECT 1 FROM memory_activity_attributions attribution JOIN memories memory ON memory.id=attribution.memory_id
      WHERE (attribution.actor_principal_id=target_principal_id OR memory.scope_id=target_scope_id) AND attribution.actor_label<>'[erased]')
    AND NOT EXISTS(SELECT 1 FROM actor_principal_mappings WHERE principal_id=target_principal_id
      AND (revoked_at IS NULL OR revocation_reason IS DISTINCT FROM '[erased]' OR external_actor_id IS DISTINCT FROM 'erased:'||mapping_id::text));
  IF labels_processed+mappings_processed>0 THEN
    INSERT INTO audit_log(principal_id,action,scope_id,metadata) VALUES(authorization_principal_id,'archive',target_scope_id,
      jsonb_build_object('operation','principal_standup_privacy_repaired','principal_id',target_principal_id,'run_id',privacy_run.run_id,
        'approval_id',privacy_run.approval_id::text,'acknowledged_evidence_hash',privacy_run.approval_evidence_hash,'rows_processed',labels_processed+mappings_processed));
  END IF;
  RETURN jsonb_build_object('complete',clean,'processed',labels_processed+mappings_processed,
    'batch_full',labels_processed=batch_limit OR mappings_processed=batch_limit);
END;
$$;
REVOKE ALL ON FUNCTION continuum_operator_scrub_standup_scope(UUID,UUID,UUID,INTEGER) FROM PUBLIC;
ALTER FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID) RENAME TO continuum_offboarding_lifecycle_state_is_erased_pre_standup;
CREATE FUNCTION continuum_offboarding_lifecycle_state_is_erased(target_run_id UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_offboarding_lifecycle_state_is_erased_pre_standup(target_run_id)
    AND NOT EXISTS(SELECT 1 FROM principal_offboarding_runs run JOIN memory_activity_attributions attribution ON attribution.actor_principal_id=run.principal_id
      WHERE run.run_id=target_run_id AND attribution.actor_label<>'[erased]')
    AND NOT EXISTS(SELECT 1 FROM principal_offboarding_runs run JOIN memories memory ON memory.scope_id=run.scope_id
      JOIN memory_activity_attributions attribution ON attribution.memory_id=memory.id
      WHERE run.run_id=target_run_id AND attribution.actor_label<>'[erased]')
    AND NOT EXISTS(SELECT 1 FROM principal_offboarding_runs run JOIN actor_principal_mappings mapping ON mapping.principal_id=run.principal_id
      WHERE run.run_id=target_run_id AND (mapping.revoked_at IS NULL OR mapping.revocation_reason IS DISTINCT FROM '[erased]'
        OR mapping.external_actor_id IS DISTINCT FROM 'erased:'||mapping.mapping_id::text));
$$;
REVOKE ALL ON FUNCTION continuum_offboarding_lifecycle_state_is_erased(UUID),continuum_offboarding_lifecycle_state_is_erased_pre_standup(UUID) FROM PUBLIC;
DO $$
DECLARE definition TEXT; revised TEXT; signature TEXT; schema_name TEXT:=current_schema(); function_record RECORD; candidate RECORD;
BEGIN
  definition:=pg_catalog.pg_get_functiondef('continuum_guard_promotion_privacy_audit()'::regprocedure);
  revised:=replace(replace(definition,'continuum_guard_promotion_privacy_audit','continuum_guard_standup_privacy_audit'),
    'principal_promotion_privacy_repaired','principal_standup_privacy_repaired');
  IF revised=definition THEN RAISE EXCEPTION 'unable to install standup privacy receipt authority'; END IF;
  EXECUTE revised;
  definition:=pg_catalog.pg_get_functiondef('continuum_offboarding_expected_audit_metadata(jsonb)'::regprocedure);
  revised:=replace(definition,'  SELECT CASE',$branch$  SELECT CASE
    WHEN audit_metadata->>'operation'='principal_standup_privacy_repaired' THEN
      (SELECT COALESCE(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb) FROM jsonb_each(audit_metadata) entry
        WHERE entry.key=ANY(ARRAY['operation','principal_id','run_id','approval_id','acknowledged_evidence_hash','rows_processed']::text[]))$branch$);
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup audit classifier'; END IF;
  EXECUTE revised;
  definition:=pg_catalog.pg_get_functiondef('continuum_reject_offboarded_principal_audit()'::regprocedure);
  revised:=replace(definition,'IF NEW.metadata->>''operation''=''principal_promotion_privacy_repaired'' THEN RETURN NEW; END IF;',
    'IF NEW.metadata->>''operation'' IN (''principal_promotion_privacy_repaired'',''principal_standup_privacy_repaired'') THEN RETURN NEW; END IF;');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup audit admission'; END IF;
  EXECUTE revised;
  FOREACH signature IN ARRAY ARRAY['continuum_redact_offboarding_audit(uuid,uuid,bigint[])',
    'continuum_protect_offboarded_audit_tombstone()',
    'continuum_apply_audit_retention_internal_v44(uuid,timestamp with time zone,integer,uuid,integer,jsonb,text,text)'] LOOP
    definition:=pg_catalog.pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'''principal_offboarding_access_revoked''','''principal_offboarding_access_revoked'', ''principal_standup_privacy_repaired''');
    IF revised=definition THEN RAISE EXCEPTION 'unable to preserve standup erasure receipts'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR function_record IN SELECT proname,pg_catalog.pg_get_function_identity_arguments(oid) arguments FROM pg_catalog.pg_proc
    WHERE pronamespace=(SELECT namespace.oid FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname=schema_name)
      AND proname=ANY(ARRAY['continuum_operator_scrub_standup_scope','continuum_guard_standup_privacy_audit',
        'continuum_offboarding_lifecycle_state_is_erased','continuum_offboarding_lifecycle_state_is_erased_pre_standup']) LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path=pg_catalog,%I,pg_temp',schema_name,function_record.proname,function_record.arguments,schema_name);
  END LOOP;
  EXECUTE format('REVOKE ALL ON FUNCTION %I.continuum_guard_standup_privacy_audit() FROM PUBLIC',schema_name);
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)'')',
    '(''continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)''),(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend standup privacy operator allowlist'; END IF;
  EXECUTE revised;
  definition:=pg_catalog.pg_get_functiondef('continuum_assert_standup_application_role_allowlist(name,boolean)'::regprocedure);
  revised:=replace(definition,'(''continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)'')',
    '(''continuum_operator_scrub_promotion_scope(uuid,uuid,uuid,integer)''),(''continuum_operator_scrub_standup_scope(uuid,uuid,uuid,integer)'')');
  IF revised=definition THEN RAISE EXCEPTION 'unable to extend private standup privacy allowlist'; END IF;
  EXECUTE revised;
  FOR candidate IN SELECT * FROM continuum_standup_upgrade_roles WHERE operator LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.continuum_operator_scrub_standup_scope(UUID,UUID,UUID,INTEGER) TO %I',schema_name,candidate.role_name);
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,TRUE);
  END LOOP;
END;
$$;
CREATE TRIGGER standup_privacy_audit_capability BEFORE INSERT OR UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION continuum_guard_standup_privacy_audit();
