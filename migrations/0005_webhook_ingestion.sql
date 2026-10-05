CREATE TABLE principal_aliases (
  provider        TEXT NOT NULL,
  external_actor  TEXT NOT NULL,
  principal_id    UUID NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, external_actor),
  CHECK (provider <> ''),
  CHECK (external_actor <> '')
);

CREATE INDEX principal_aliases_principal_idx ON principal_aliases (principal_id);

CREATE TABLE ingest_deliveries (
  plugin_id    TEXT NOT NULL,
  delivery_id  TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
  memory_ids   UUID[] NOT NULL DEFAULT '{}',
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (plugin_id, delivery_id),
  CHECK (
    (state = 'processing' AND completed_at IS NULL)
    OR (state = 'completed' AND completed_at IS NOT NULL)
  )
);
