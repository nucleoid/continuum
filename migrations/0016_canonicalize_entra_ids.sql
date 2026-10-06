-- Canonicalize Entra object IDs. Case-colliding legacy bindings are ambiguous,
-- so their sourced access is quarantined while one inactive binding is retained
-- for explicit operator review and reprovisioning.

CREATE TEMP TABLE continuum_entra_case_collisions ON COMMIT DROP AS
SELECT lower(external_id) AS external_id
  FROM entra_groups
 GROUP BY lower(external_id)
HAVING count(*) > 1;

CREATE TEMP TABLE continuum_entra_memberships_to_restore ON COMMIT DROP AS
SELECT principal_id, scope_id, lower(source_id) AS source_id
  FROM scope_memberships
 WHERE source_kind = 'entra'
   AND active
   AND source_id <> lower(source_id)
   AND lower(source_id) NOT IN (
     SELECT external_id FROM continuum_entra_case_collisions
   );

UPDATE scope_memberships
   SET active = FALSE,
       deactivated_at = COALESCE(deactivated_at, now()),
       synced_at = now()
 WHERE source_kind = 'entra'
   AND active
   AND (source_id <> lower(source_id)
        OR lower(source_id) IN (
          SELECT external_id FROM continuum_entra_case_collisions
        ));

UPDATE entra_groups
   SET active = FALSE,
       deactivated_at = COALESCE(deactivated_at, now())
 WHERE lower(external_id) IN (
   SELECT external_id FROM continuum_entra_case_collisions
 );

DELETE FROM scope_memberships m
 USING (
   SELECT ctid,
          row_number() OVER (
            PARTITION BY principal_id, scope_id, source_kind, lower(source_id)
            ORDER BY (source_id = lower(source_id)) DESC, source_id
          ) AS position
     FROM scope_memberships
    WHERE source_kind = 'entra'
 ) duplicate
 WHERE m.ctid = duplicate.ctid
   AND duplicate.position > 1;

DELETE FROM entra_groups g
 USING (
   SELECT external_id,
          row_number() OVER (
            PARTITION BY lower(external_id)
            ORDER BY (external_id = lower(external_id)) DESC, external_id
          ) AS position
     FROM entra_groups
 ) duplicate
 WHERE g.external_id = duplicate.external_id
   AND duplicate.position > 1;

UPDATE entra_groups
   SET external_id = lower(external_id)
 WHERE external_id <> lower(external_id);

UPDATE scope_memberships
   SET source_id = lower(source_id)
 WHERE source_kind = 'entra'
   AND source_id <> lower(source_id);

UPDATE scope_memberships m
   SET active = TRUE,
       deactivated_at = NULL,
       synced_at = now()
  FROM continuum_entra_memberships_to_restore restore
 WHERE m.principal_id = restore.principal_id
   AND m.scope_id = restore.scope_id
   AND m.source_kind = 'entra'
   AND m.source_id = restore.source_id;

ALTER TABLE entra_groups ADD CONSTRAINT entra_groups_external_id_canonical
  CHECK (external_id = lower(external_id));
ALTER TABLE scope_memberships ADD CONSTRAINT scope_memberships_entra_source_id_canonical
  CHECK (
    source_kind <> 'entra'
    OR (source_id = lower(source_id)
        AND source_id ~ '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  );
