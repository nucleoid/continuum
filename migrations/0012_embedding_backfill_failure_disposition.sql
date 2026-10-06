ALTER TABLE embedding_backfill_failures
  ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'durable';

ALTER TABLE embedding_backfill_failures
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'EMBEDDING_ITEM_FAILED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'embedding_backfill_failures'::regclass
       AND conname = 'embedding_backfill_failures_disposition_check'
  ) THEN
    ALTER TABLE embedding_backfill_failures
      ADD CONSTRAINT embedding_backfill_failures_disposition_check
      CHECK (disposition IN ('durable', 'suspect')) NOT VALID;
  END IF;
END $$;

ALTER TABLE embedding_backfill_failures
  VALIDATE CONSTRAINT embedding_backfill_failures_disposition_check;
