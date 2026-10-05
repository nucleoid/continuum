ALTER TABLE ingest_deliveries
  ADD COLUMN payload_sha256 TEXT;

-- A pre-release database can contain rows created by the preceding migration.
-- They have no trustworthy payload fingerprint, so any replay must fail closed.
UPDATE ingest_deliveries
   SET payload_sha256 = 'legacy-unverified'
 WHERE payload_sha256 IS NULL;

ALTER TABLE ingest_deliveries
  ALTER COLUMN payload_sha256 SET NOT NULL;
