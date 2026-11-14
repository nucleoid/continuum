-- Explicit manual event annotations. Payload bytes use the existing managed
-- evidence store, so current/history/copy erasure uses its physical proof.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE continuum_event_upgrade_roles(role_oid OID PRIMARY KEY,role_name NAME,operator BOOLEAN) ON COMMIT DROP;
DO $$ DECLARE candidate RECORD;
BEGIN
  FOR candidate IN SELECT p.*,r.rolname FROM continuum_pgvector_role_profiles p JOIN pg_roles r ON r.oid=p.database_role_oid
    WHERE profile_kind IN ('application','operator') LOOP
    BEGIN
      PERFORM continuum_assert_application_role_allowlist(candidate.rolname,candidate.profile_kind='operator');
      INSERT INTO continuum_event_upgrade_roles VALUES(candidate.database_role_oid,candidate.rolname,candidate.profile_kind='operator');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Continuum skipped event grants for role OID % (SQLSTATE %); explicit regrant required',candidate.database_role_oid,SQLSTATE;
    END;
  END LOOP;
END $$;

-- Only machine provenance is stored here. Original notation, candidates and
-- UTC comparison bounds all remain erasable managed payload bytes.
CREATE TABLE memory_event_annotations(
  version_id UUID PRIMARY KEY REFERENCES evidence_versions(id),
  source_version UUID NOT NULL REFERENCES evidence_versions(id),
  memory_id UUID NOT NULL
);
CREATE INDEX memory_event_annotations_source_idx ON memory_event_annotations(source_version,version_id);
CREATE TABLE memory_event_current(
  memory_id UUID PRIMARY KEY,
  node_id UUID UNIQUE NOT NULL REFERENCES evidence_roots(id),
  version_id UUID NOT NULL REFERENCES memory_event_annotations(version_id)
);
REVOKE ALL ON memory_event_annotations,memory_event_current FROM PUBLIC;
CREATE TRIGGER memory_event_annotation_immutable BEFORE UPDATE OR DELETE ON memory_event_annotations
  FOR EACH ROW EXECUTE FUNCTION continuum_evidence_immutable();

CREATE FUNCTION continuum_event_valid(value JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item JSONB; key TEXT; stamp TEXT; point TIMESTAMPTZ; start_at TIMESTAMPTZ; end_at TIMESTAMPTZ;
  local_start TIMESTAMP; local_end TIMESTAMP; zone TEXT; shift INTERVAL;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR octet_length(value::text)>8192 OR value->>'status' IS NULL THEN RETURN FALSE; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN ('status','assertion','precision','instant','start','end','original','timezone','candidates')) THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['original','timezone'] LOOP
    IF value ? key AND (jsonb_typeof(value->key)<>'string' OR octet_length(value->>key) NOT BETWEEN 1 AND CASE WHEN key='original' THEN 1024 ELSE 100 END) THEN RETURN FALSE; END IF;
  END LOOP;
  IF value->>'status'='unknown' THEN RETURN NOT(value ?| ARRAY['assertion','precision','instant','start','end','candidates']); END IF;
  IF value->>'status'='ambiguous' THEN
    IF value ?| ARRAY['assertion','precision','instant','start','end'] OR jsonb_typeof(value->'candidates') IS DISTINCT FROM 'array'
      OR jsonb_array_length(value->'candidates') NOT BETWEEN 1 AND 8 THEN RETURN FALSE; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(value->'candidates') LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'notation') IS DISTINCT FROM 'string'
        OR octet_length(item->>'notation') NOT BETWEEN 1 AND 256
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('notation','timezone'))
        OR (item ? 'timezone' AND (jsonb_typeof(item->'timezone')<>'string' OR octet_length(item->>'timezone') NOT BETWEEN 1 AND 100)) THEN RETURN FALSE; END IF;
    END LOOP;
    RETURN TRUE;
  END IF;
  IF value->>'status'<>'known' OR value->>'assertion' IS NULL OR value->>'assertion' NOT IN ('asserted','mentioned') OR value ? 'candidates'
    OR value->>'precision' IS NULL OR value->>'precision' NOT IN ('instant','day','month','year','range') THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['instant','start','end'] LOOP
    IF value ? key THEN
      stamp:=value->>key;
      IF jsonb_typeof(value->key)<>'string' OR stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN FALSE; END IF;
      point:=stamp::timestamptz;
      IF NOT isfinite(point) OR to_char(point AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>stamp THEN RETURN FALSE; END IF;
    END IF;
  END LOOP;
  IF value->>'precision'='instant' THEN RETURN value ? 'instant' AND NOT(value ?| ARRAY['start','end']); END IF;
  IF value ? 'instant' OR NOT(value ?| ARRAY['start','end']) OR (value->>'precision'<>'range' AND NOT(value ?& ARRAY['start','end'])) THEN RETURN FALSE; END IF;
  start_at:=(value->>'start')::timestamptz; end_at:=(value->>'end')::timestamptz;
  IF value->>'precision'<>'range' THEN
    zone:=value->>'timezone';
    IF zone IS NULL THEN RETURN FALSE; END IF;
    IF zone='Z' OR zone ~ '^[+-](0[0-9]|1[0-4]):[0-5][0-9]$' THEN
      IF zone ~ '^[+-]14:' AND right(zone,2)<>'00' OR zone='-00:00' THEN RETURN FALSE; END IF;
      shift:=CASE WHEN zone='Z' THEN interval '0 seconds' ELSE zone::interval END;
      local_start:=(start_at AT TIME ZONE 'UTC')+shift; local_end:=(end_at AT TIME ZONE 'UTC')+shift;
    ELSE
      local_start:=start_at AT TIME ZONE zone; local_end:=end_at AT TIME ZONE zone;
    END IF;
    IF local_start<>date_trunc(value->>'precision',local_start)
      OR local_end<>local_start+(CASE value->>'precision' WHEN 'day' THEN interval '1 day' WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END) THEN RETURN FALSE; END IF;
  END IF;
  RETURN start_at IS NULL OR end_at IS NULL OR start_at<end_at;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;

CREATE FUNCTION continuum_event_write(actor UUID,memory_id UUID,value JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE memory memories%ROWTYPE; source UUID; current memory_event_current%ROWTYPE; version UUID; node UUID;
BEGIN
  IF NOT continuum_event_valid(value) THEN RAISE check_violation USING MESSAGE='invalid event annotation'; END IF;
  SELECT * INTO memory FROM memories WHERE id=memory_id FOR UPDATE;
  IF memory.id IS NULL OR memory.state<>'live' OR NOT continuum_evidence_can_access(actor,memory.scope_id,TRUE) THEN
    RAISE insufficient_privilege USING MESSAGE='event annotation unavailable'; END IF;
  source:=continuum_evidence_source(actor,memory_id);
  SELECT * INTO current FROM memory_event_current c WHERE c.memory_id=memory.id FOR UPDATE;
  node:=COALESCE(current.node_id,gen_random_uuid());
  version:=continuum_evidence_register(actor,node,current.version_id,memory.scope_id,'derived-observation',
    jsonb_build_array(jsonb_build_object('versionId',source,'kind','source')),
    '{"transform":"manual-event-v1","model":"none","prompt":"none","schema":"event-v1"}'::jsonb,value::text);
  INSERT INTO memory_event_annotations VALUES(version,source,memory.id);
  INSERT INTO memory_event_current VALUES(memory.id,node,version)
    ON CONFLICT ON CONSTRAINT memory_event_current_pkey DO UPDATE SET version_id=EXCLUDED.version_id;
  INSERT INTO audit_log(principal_id,action,memory_id,scope_id,metadata)
    VALUES(actor,'write',memory.id,memory.scope_id,jsonb_build_object('operation','event_annotation_written','version',version,'source_version',source));
  RETURN jsonb_build_object('annotation',value,'version',version,'sourceVersion',source);
END $$;

-- Unlocked operation-local admission runs before every candidate LIMIT. Final
-- hydration/delivery passes locked=TRUE in its owned current transaction.
CREATE FUNCTION continuum_event_metadata(actor UUID,memory_id UUID,locked BOOLEAN) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE memory RECORD; annotation memory_event_annotations%ROWTYPE; bytes INTEGER;
BEGIN
  IF locked THEN SELECT id,scope_id,state,expires_at INTO memory FROM memories WHERE id=memory_id FOR SHARE;
  ELSE SELECT id,scope_id,state,expires_at INTO memory FROM memories WHERE id=memory_id; END IF;
  IF memory.id IS NULL OR memory.state<>'live' OR NOT continuum_evidence_can_access(actor,memory.scope_id,FALSE)
    OR (memory.expires_at IS NOT NULL AND memory.expires_at<=clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT a.* INTO annotation FROM memory_event_current c JOIN memory_event_annotations a ON a.version_id=c.version_id
    WHERE c.memory_id=memory.id;
  IF annotation.version_id IS NULL THEN RETURN jsonb_build_object('version',NULL,'sourceVersion',NULL,'bytes',128); END IF;
  IF locked THEN PERFORM continuum_evidence_lock(actor,ARRAY[annotation.version_id]); END IF;
  IF NOT continuum_evidence_eligible(actor,annotation.version_id,NULL)
    OR NOT EXISTS(SELECT 1 FROM evidence_roots WHERE source_memory_id=memory.id AND current_version=annotation.source_version) THEN RETURN NULL; END IF;
  SELECT octet_length(payload) INTO bytes FROM evidence_payloads WHERE version_id=annotation.version_id;
  IF bytes IS NULL OR bytes>8192 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('bytes',bytes+256,'version',annotation.version_id,'sourceVersion',annotation.source_version);
END $$;
CREATE FUNCTION continuum_event_read(actor UUID,memory_id UUID,locked BOOLEAN) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE metadata JSONB; content TEXT;
BEGIN
  metadata:=continuum_event_metadata(actor,memory_id,locked);
  IF metadata IS NULL THEN RETURN NULL; END IF;
  IF metadata->>'version' IS NULL THEN RETURN jsonb_build_object('annotation',jsonb_build_object('status','unknown'),'version',NULL,'sourceVersion',NULL); END IF;
  SELECT payload INTO content FROM evidence_payloads WHERE version_id=(metadata->>'version')::uuid;
  RETURN (metadata-'bytes')||jsonb_build_object('annotation',content::jsonb);
END $$;

-- Ordinary source reads need no historical-unknown projection. Check the empty
-- annotation index first, preserving their source-only admission costs.
CREATE FUNCTION continuum_event_optional_metadata(actor UUID,memory_id UUID,locked BOOLEAN) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_event_current c WHERE c.memory_id=continuum_event_optional_metadata.memory_id) THEN RETURN NULL; END IF;
  RETURN continuum_event_metadata(actor,memory_id,locked);
END $$;
CREATE FUNCTION continuum_event_optional_read(actor UUID,memory_id UUID,locked BOOLEAN) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM memory_event_current c WHERE c.memory_id=continuum_event_optional_read.memory_id) THEN RETURN NULL; END IF;
  RETURN continuum_event_read(actor,memory_id,locked);
END $$;

CREATE FUNCTION continuum_event_overlap(value JSONB,window_spec JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE at_time TIMESTAMPTZ:=(window_spec->>'at')::timestamptz; from_time TIMESTAMPTZ:=(window_spec->>'from')::timestamptz;
  to_time TIMESTAMPTZ:=(window_spec->>'to')::timestamptz; point TIMESTAMPTZ; start_at TIMESTAMPTZ; end_at TIMESTAMPTZ;
BEGIN
  IF value IS NULL OR value->>'status'<>'known' OR value->>'assertion'<>'asserted' THEN RETURN COALESCE((window_spec->>'includeUnknown')::boolean,FALSE); END IF;
  point:=(value->>'instant')::timestamptz; start_at:=(value->>'start')::timestamptz; end_at:=(value->>'end')::timestamptz;
  IF at_time IS NOT NULL THEN RETURN CASE WHEN point IS NOT NULL THEN point=at_time ELSE (start_at IS NULL OR start_at<=at_time) AND (end_at IS NULL OR at_time<end_at) END; END IF;
  IF point IS NOT NULL THEN RETURN (from_time IS NULL OR from_time<=point) AND (to_time IS NULL OR point<to_time); END IF;
  RETURN (from_time IS NULL OR end_at IS NULL OR from_time<end_at) AND (to_time IS NULL OR start_at IS NULL OR start_at<to_time);
END $$;
CREATE FUNCTION continuum_event_matches(actor UUID,memory_id UUID,window_spec JSONB) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$
DECLARE inspection JSONB;
BEGIN
  inspection:=continuum_event_read(actor,memory_id,FALSE);
  RETURN inspection IS NOT NULL AND continuum_event_overlap(inspection->'annotation',window_spec);
END $$;

-- Canonical promotion attests both reciprocal source identity and its current
-- post-transition evidence generation. Caller JSON is never copy provenance.
CREATE FUNCTION continuum_event_promote(actor UUID,source_id UUID,destination_id UUID,annotation_version UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE destination memories%ROWTYPE; source memories%ROWTYPE; content TEXT;
BEGIN
  IF annotation_version IS NULL THEN RETURN; END IF;
  SELECT * INTO source FROM memories WHERE id=source_id FOR UPDATE;
  SELECT * INTO destination FROM memories WHERE id=destination_id FOR UPDATE;
  IF continuum_evidence_promotion_parent(destination) IS DISTINCT FROM source.id
    OR NOT continuum_evidence_can_access(actor,source.scope_id,TRUE)
    OR NOT continuum_evidence_can_access(actor,destination.scope_id,TRUE)
    OR NOT EXISTS(SELECT 1 FROM memory_event_current c JOIN memory_event_annotations a ON a.version_id=c.version_id
      JOIN evidence_versions v ON v.id=a.source_version JOIN evidence_roots r ON r.id=v.root_id
      JOIN evidence_versions current_source ON current_source.id=r.current_version AND current_source.previous_version=a.source_version
      JOIN evidence_payloads p ON p.version_id=a.source_version
      WHERE c.memory_id=source.id AND c.version_id=annotation_version AND r.source_memory_id=source.id
        AND p.payload=continuum_evidence_canonical(source)) THEN RAISE check_violation USING MESSAGE='event promotion unavailable'; END IF;
  -- The old annotation is invalidated by the legitimate promotion transition;
  -- only its exact canonical source proof permits this bounded manual copy.
  SELECT payload INTO content FROM evidence_payloads WHERE version_id=annotation_version;
  IF content IS NULL THEN RAISE check_violation USING MESSAGE='event promotion unavailable'; END IF;
  PERFORM continuum_event_write(actor,destination.id,content::jsonb);
END $$;

CREATE TABLE memory_event_contract_functions(signature TEXT PRIMARY KEY,body_hash TEXT NOT NULL,definer BOOLEAN NOT NULL,volatility "char" NOT NULL);
REVOKE ALL ON memory_event_contract_functions FROM PUBLIC;
CREATE FUNCTION continuum_event_is_ready() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT continuum_evidence_is_ready() AND continuum_extraction_is_ready()
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='memory_event_annotations'::regclass AND tgname='memory_event_annotation_immutable'
      AND tgenabled='O' AND tgtype=27 AND tgfoid='continuum_evidence_immutable()'::regprocedure)
    AND EXISTS(SELECT 1 FROM memory_event_contract_functions)
    AND NOT EXISTS(SELECT 1 FROM memory_event_contract_functions c LEFT JOIN pg_proc f ON f.oid=to_regprocedure(c.signature)
      WHERE f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>c.body_hash OR f.prosecdef<>c.definer OR f.provolatile<>c.volatility
      OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='memories'::regclass)
      OR NOT(f.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',(SELECT n.nspname FROM pg_namespace n JOIN pg_class m ON m.relnamespace=n.oid WHERE m.oid='memories'::regclass))])
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'));
$$;
DO $$
DECLARE schema_name TEXT:=current_schema(); f RECORD; signature TEXT; definition TEXT; revised TEXT; candidate RECORD;
  app_signatures TEXT[]:=ARRAY['continuum_event_write(uuid,uuid,jsonb)','continuum_event_read(uuid,uuid,boolean)','continuum_event_metadata(uuid,uuid,boolean)',
    'continuum_event_optional_metadata(uuid,uuid,boolean)','continuum_event_optional_read(uuid,uuid,boolean)',
    'continuum_event_matches(uuid,uuid,jsonb)','continuum_event_promote(uuid,uuid,uuid,uuid)','continuum_event_is_ready()'];
BEGIN
  FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace=quote_ident(schema_name)::regnamespace AND proname LIKE 'continuum_event_%' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,pg_temp',f.signature,schema_name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['continuum_assert_application_role_allowlist(name,boolean)','continuum_assert_standup_application_role_allowlist(name,boolean)'] LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    revised:=replace(definition,'(''continuum_standup_is_ready()'')','(''continuum_standup_is_ready()''),('''||replace(array_to_string(app_signatures,'''),('''),' ','')||''')');
    IF revised=definition THEN RAISE EXCEPTION 'unable to extend event allowlist'; END IF;
    EXECUTE revised;
  END LOOP;
  FOR candidate IN SELECT * FROM continuum_event_upgrade_roles LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=candidate.role_oid AND rolname=candidate.role_name) THEN CONTINUE; END IF;
    FOREACH signature IN ARRAY app_signatures LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',schema_name,signature,candidate.role_name); END LOOP;
    PERFORM continuum_assert_application_role_allowlist(candidate.role_name,candidate.operator);
  END LOOP;
END $$;
INSERT INTO memory_event_contract_functions SELECT oid::regprocedure::text,encode(sha256(convert_to(prosrc,'UTF8')),'hex'),prosecdef,provolatile
  FROM pg_proc WHERE pronamespace=quote_ident(current_schema())::regnamespace AND proname LIKE 'continuum_event_%';
