-- Canonicalize UUID-shaped principal identities before enforcing the storage
-- invariant. Opaque development and service identities remain unchanged.

DO $$
BEGIN
  IF EXISTS (
    SELECT lower(external_id)
      FROM principals
     WHERE external_id ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     GROUP BY lower(external_id)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'UUID-shaped principal external_id values collide after lowercase canonicalization';
  END IF;
END;
$$;

UPDATE principals
   SET external_id = lower(external_id)
 WHERE external_id ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   AND external_id <> lower(external_id);

ALTER TABLE principals ADD CONSTRAINT principals_uuid_external_id_canonical
  CHECK (
    external_id IS NULL
    OR external_id !~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    OR external_id = lower(external_id)
  );
