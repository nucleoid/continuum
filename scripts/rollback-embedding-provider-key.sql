-- A provider-key downgrade cannot safely delete completed migration evidence.
-- Restore the verified pre-upgrade database backup, including both migration
-- ledgers, while every memory/embedding writer is stopped.
DO $unsupported$
BEGIN
  RAISE EXCEPTION USING ERRCODE='55000',
    MESSAGE='Embedding schema rollback requires a verified pre-upgrade database backup; in-place migration ledger deletion is not supported';
END;
$unsupported$;
