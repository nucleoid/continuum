-- Keep the ACCESS EXCLUSIVE principal-table change in its own short transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE principals
  ADD COLUMN offboarded_at TIMESTAMPTZ,
  ADD COLUMN reactivated_at TIMESTAMPTZ;
