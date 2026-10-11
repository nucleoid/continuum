\set ON_ERROR_STOP on
\if :{?continuum_schema}
\else
  \set continuum_schema public
\endif
\if :{?continuum_preflight_limit}
\else
  \set continuum_preflight_limit 100
\endif
\if :{?continuum_after_principal_id}
\else
  \set continuum_after_principal_id ''
\endif
\if :{?continuum_after_scope_id}
\else
  \set continuum_after_scope_id ''
\endif

-- Owner-only, bounded, read-only baseline before0081. Pause writers first.
-- No quota, privilege, provider or migration ledger changes are made here.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';
SELECT set_config('continuum.preflight_schema',:'continuum_schema',TRUE),
  set_config('continuum.preflight_limit',:'continuum_preflight_limit',TRUE),
  set_config('continuum.preflight_principal_after',:'continuum_after_principal_id',TRUE),
  set_config('continuum.preflight_scope_after',:'continuum_after_scope_id',TRUE);
DO $report$
DECLARE schema_name TEXT:=current_setting('continuum.preflight_schema');
DECLARE page_limit INTEGER:=current_setting('continuum.preflight_limit')::integer;
DECLARE principal_after UUID:=NULLIF(current_setting('continuum.preflight_principal_after'),'')::uuid;
DECLARE scope_after UUID:=NULLIF(current_setting('continuum.preflight_scope_after'),'')::uuid;
DECLARE candidate RECORD; scanned INTEGER:=0; last_id UUID;
BEGIN
  IF page_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'coordination preflight limit must be between 1 and 100'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid=pg_catalog.to_regclass(pg_catalog.format('%I.memories',schema_name))
      AND relation.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN
    RAISE EXCEPTION 'coordination preflight requires the tenant migration owner on an existing application schema';
  END IF;
  IF pg_catalog.to_regclass(pg_catalog.format('%I.coordination_principal_usage',schema_name)) IS NULL THEN
    RAISE NOTICE 'no coordination usage table; no existing quota baseline to reinterpret'; RETURN;
  END IF;
  FOR candidate IN EXECUTE pg_catalog.format($principals$
    WITH candidates AS MATERIALIZED (
      SELECT usage.* FROM %I.coordination_principal_usage usage
      WHERE usage.principal_id>=COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
        AND ($1 IS NULL OR usage.principal_id>$1)
      ORDER BY usage.principal_id LIMIT $2+1
    )
    SELECT usage.principal_id,
      (to_jsonb(usage)->>'acquire_receipt_limit')::integer AS configured_acquire_limit,
      (to_jsonb(usage)->>'contended_receipt_limit')::integer AS legacy_contended_limit,
      LEAST(COALESCE((to_jsonb(usage)->>'acquire_receipt_limit')::integer,10000),10000) AS proposed_combined_limit,
      receipts.stored_rows,receipts.acquired_rows,receipts.contended_rows,receipts.renew_release_rows,
      receipts.recent_expired_rows
    FROM candidates usage
    CROSS JOIN LATERAL (
      SELECT count(*) AS stored_rows,
        count(*) FILTER(WHERE operation='acquire' AND outcome='acquired') AS acquired_rows,
        count(*) FILTER(WHERE outcome='contended') AS contended_rows,
        count(*) FILTER(WHERE operation IN ('renew','release')) AS renew_release_rows,
        count(*) FILTER(WHERE retain_until<=clock_timestamp()
          AND server_time>clock_timestamp()-interval '24 hours') AS recent_expired_rows
      FROM %I.coordination_operation_receipts WHERE principal_id=usage.principal_id
    ) receipts
    ORDER BY usage.principal_id
  $principals$,schema_name,schema_name) USING principal_after,page_limit LOOP
    scanned:=scanned+1;
    IF scanned>page_limit THEN EXIT; END IF;
    last_id:=candidate.principal_id;
    RAISE NOTICE '%',to_jsonb(candidate)||jsonb_build_object('report','principal',
      'at_or_above_proposed_limit',candidate.stored_rows>=candidate.proposed_combined_limit);
  END LOOP;
  RAISE NOTICE '%',jsonb_build_object('report','principal_page','next_cursor',CASE WHEN scanned>page_limit THEN last_id END);
  scanned:=0; last_id:=NULL;
  FOR candidate IN EXECUTE pg_catalog.format($scopes$
    WITH candidates AS MATERIALIZED (
      SELECT usage.* FROM %I.coordination_scope_usage usage
      WHERE usage.scope_id>=COALESCE($1,'00000000-0000-0000-0000-000000000000'::uuid)
        AND ($1 IS NULL OR usage.scope_id>$1)
      ORDER BY usage.scope_id LIMIT $2+1
    )
    SELECT usage.scope_id,(to_jsonb(usage)->>'resource_limit')::integer AS configured_resource_limit,
      LEAST(COALESCE((to_jsonb(usage)->>'resource_limit')::integer,10000),10000) AS proposed_resource_limit,
      (SELECT count(*) FROM %I.coordination_resources resource WHERE resource.scope_id=usage.scope_id) AS stored_keys
    FROM candidates usage ORDER BY usage.scope_id
  $scopes$,schema_name,schema_name) USING scope_after,page_limit LOOP
    scanned:=scanned+1;
    IF scanned>page_limit THEN EXIT; END IF;
    last_id:=candidate.scope_id;
    RAISE NOTICE '%',to_jsonb(candidate)||jsonb_build_object('report','scope',
      'at_or_above_proposed_limit',candidate.stored_keys>=candidate.proposed_resource_limit);
  END LOOP;
  RAISE NOTICE '%',jsonb_build_object('report','scope_page','next_cursor',CASE WHEN scanned>page_limit THEN last_id END);
END;
$report$;
COMMIT;
