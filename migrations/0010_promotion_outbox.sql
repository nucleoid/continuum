CREATE TABLE promotion_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id         UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  destination_memory_id    UUID NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
  destination_scope_id     UUID NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
  destination_scope_kind   TEXT NOT NULL CHECK (destination_scope_kind IN ('org', 'team', 'project', 'user', 'role')),
  destination_scope_name   TEXT NOT NULL,
  principal_id             UUID NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_memory_id)
);

CREATE TABLE promotion_event_deliveries (
  event_id         UUID NOT NULL REFERENCES promotion_events(id) ON DELETE CASCADE,
  webhook_id       TEXT NOT NULL CHECK (webhook_id ~ '^[a-z][a-z0-9.-]{0,63}$'),
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'delivered', 'dead_letter')),
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error       TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 256),
  delivered_at     TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, webhook_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX promotion_event_deliveries_claim_idx
  ON promotion_event_deliveries (available_at, lease_expires_at)
  WHERE state = 'pending';
