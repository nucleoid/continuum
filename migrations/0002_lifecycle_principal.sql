-- Internal, noninteractive actor used only by trusted lifecycle job code.
-- It deliberately has no external_id: v0 treats external_id as a bearer token,
-- so a reserved textual value would become an interactive credential for older
-- API replicas during a rolling deployment or rollback.
ALTER TABLE principals ALTER COLUMN external_id DROP NOT NULL;

ALTER TABLE principals ADD CONSTRAINT principals_lifecycle_identity_check CHECK (
  (
    id = '00000000-0000-4000-8000-000000000011'
    AND external_id IS NULL
    AND kind = 'service'
  ) OR (
    id <> '00000000-0000-4000-8000-000000000011'
    AND external_id IS NOT NULL
    AND external_id <> 'system:lifecycle'
  )
);

INSERT INTO principals (id, external_id, kind, display_name)
VALUES (
  '00000000-0000-4000-8000-000000000011',
  NULL,
  'service',
  'system:lifecycle'
);

CREATE FUNCTION reject_lifecycle_principal_membership() RETURNS trigger AS $$
BEGIN
  IF NEW.principal_id = '00000000-0000-4000-8000-000000000011' THEN
    RAISE EXCEPTION 'system:lifecycle cannot have scope memberships';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_lifecycle_principal_membership_trigger
  BEFORE INSERT OR UPDATE ON scope_memberships
  FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_principal_membership();
