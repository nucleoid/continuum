-- Dedicated durable coordination state. This is intentionally separate from semantic memory.
CREATE TABLE coordination_resources (
  scope_id         UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  resource         TEXT NOT NULL,
  fencing_token    BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  current_lease_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_id, resource),
  CHECK (octet_length(convert_to(resource, 'UTF8')) BETWEEN 1 AND 512),
  CHECK (resource !~ '[[:cntrl:]]'),
  CHECK (left(resource, 1) NOT IN (
    ' ', U&'\00A0', U&'\1680', U&'\2000', U&'\2001', U&'\2002', U&'\2003',
    U&'\2004', U&'\2005', U&'\2006', U&'\2007', U&'\2008', U&'\2009',
    U&'\200A', U&'\2028', U&'\2029', U&'\202F', U&'\205F', U&'\3000',
    U&'\FEFF'
  )),
  CHECK (right(resource, 1) NOT IN (
    ' ', U&'\00A0', U&'\1680', U&'\2000', U&'\2001', U&'\2002', U&'\2003',
    U&'\2004', U&'\2005', U&'\2006', U&'\2007', U&'\2008', U&'\2009',
    U&'\200A', U&'\2028', U&'\2029', U&'\202F', U&'\205F', U&'\3000',
    U&'\FEFF'
  ))
);

CREATE TABLE coordination_leases (
  lease_id       UUID PRIMARY KEY,
  scope_id       UUID NOT NULL,
  resource       TEXT NOT NULL,
  principal_id   UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  run_id         UUID NOT NULL,
  fencing_token  BIGINT NOT NULL CHECK (fencing_token > 0),
  acquired_at    TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  released_at    TIMESTAMPTZ,
  FOREIGN KEY (scope_id, resource)
    REFERENCES coordination_resources(scope_id, resource) ON DELETE RESTRICT,
  UNIQUE (scope_id, resource, fencing_token),
  CHECK (expires_at >= acquired_at),
  CHECK (released_at IS NULL OR released_at >= acquired_at)
);

ALTER TABLE coordination_resources
  ADD CONSTRAINT coordination_resources_current_lease_fk
  FOREIGN KEY (current_lease_id) REFERENCES coordination_leases(lease_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX coordination_leases_resource_history_idx
  ON coordination_leases (scope_id, resource, fencing_token DESC);
CREATE INDEX coordination_leases_terminal_cleanup_idx
  ON coordination_leases (released_at, expires_at)
  WHERE released_at IS NOT NULL;

CREATE TABLE coordination_operation_receipts (
  principal_id        UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  operation           TEXT NOT NULL CHECK (operation IN ('acquire', 'renew', 'release')),
  request_id          UUID NOT NULL,
  payload_hash        BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  outcome             TEXT NOT NULL CHECK (outcome IN ('acquired', 'contended', 'renewed', 'released')),
  scope_id            UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  resource            TEXT NOT NULL,
  lease_id            UUID,
  run_id              UUID,
  fencing_token       BIGINT CHECK (fencing_token > 0),
  expires_at          TIMESTAMPTZ,
  server_time         TIMESTAMPTZ NOT NULL,
  retry_after_seconds INTEGER CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  retain_until        TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (scope_id, resource)
    REFERENCES coordination_resources(scope_id, resource) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id)
    REFERENCES coordination_leases(lease_id) ON DELETE RESTRICT,
  PRIMARY KEY (principal_id, operation, request_id),
  CHECK (retain_until >= server_time),
  CHECK (
    (outcome = 'contended' AND lease_id IS NULL AND run_id IS NULL
      AND fencing_token IS NULL AND expires_at IS NOT NULL
      AND retry_after_seconds IS NOT NULL)
    OR
    (outcome IN ('acquired', 'renewed') AND lease_id IS NOT NULL AND run_id IS NOT NULL
      AND fencing_token IS NOT NULL AND expires_at IS NOT NULL
      AND retry_after_seconds IS NULL)
    OR
    (outcome = 'released' AND lease_id IS NOT NULL AND run_id IS NOT NULL
      AND fencing_token IS NOT NULL AND expires_at IS NULL
      AND retry_after_seconds IS NULL)
  )
);

CREATE INDEX coordination_receipts_cleanup_idx
  ON coordination_operation_receipts (principal_id, retain_until, operation, request_id);
CREATE INDEX coordination_receipts_lease_idx
  ON coordination_operation_receipts (lease_id)
  WHERE lease_id IS NOT NULL;

CREATE TABLE coordination_scope_usage (
  scope_id       UUID PRIMARY KEY REFERENCES scopes(id) ON DELETE RESTRICT,
  resource_count INTEGER NOT NULL DEFAULT 0 CHECK (resource_count BETWEEN 0 AND 10000),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE coordination_principal_usage (
  principal_id  UUID PRIMARY KEY REFERENCES principals(id) ON DELETE RESTRICT,
  receipt_count INTEGER NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND 10000),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
