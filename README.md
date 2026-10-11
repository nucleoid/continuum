# Continuum

Vendor-agnostic memory layer for development teams. Captures, scopes, and serves the institutional knowledge that normally lives in people's heads, chat threads, and lost Slack messages.

Continuum is designed for organisations that want their developers (and the AI agents helping them) to share context across people, projects, and time without locking themselves to any one LLM vendor or IDE.

## What it does

- Captures memory from PRs, work-item comments, branch events, deploy events, terminal session summaries, and (optionally) team chat.
- Organises every memory under one of five scopes: `org`, `team`, `project`, `user`, `role`.
- Serves memory back through the `continuum` CLI, an MCP server (works with Claude Code, Cursor, Copilot Chat, Continue, Zed), a stable HTTP REST API (for internal tooling and CI), and an `AGENTS.md` generator (drops a scope-aware context file into any repo).
- Enforces per-scope ACLs at the API layer and writes a full audit trail for every read and write.
- Storage is Postgres + pgvector. Embeddings are pluggable (local Ollama for sensitive material, hosted models for the rest).
- Provides durable, scope-authorized coordination leases as a separate non-memory domain.

## What it is not

- Not a wiki. Continuum is structured memory with taxonomy and decay rules, not free-form pages.
- Not a notebook. Personal notes live in `user` scope but are first-class citizens of the same system shared knowledge uses, not a sidecar.
- Not coupled to any LLM provider. The data is plain text plus structured metadata; the LLM is just one of several consumers.

## Status

v0 design in progress. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the schema, scope model, capture API, and extension points.

## API contracts

- [Webhook ingestion](./docs/webhook-ingestion.md)
- [CLI commands, configuration, and exit codes](./docs/cli.md)
- [Authentication and Entra membership sync](./docs/authentication.md)
- [Audit query API](./docs/audit-api.md)
- [Knowledge-gap insights](./docs/knowledge-gap-insights.md)
- [API operations, health checks, and shutdown](./docs/api-operations.md)
- [AGENTS.md ETag and freshness checks](./docs/agents-md-freshness.md)
- [Lifecycle sweeper and review queue](./docs/lifecycle.md)
- [Offboarding and right to erasure](./docs/offboarding.md)
- [Audit retention operations](./docs/audit-retention.md)
- [Memory fetch and browse API](./docs/memory-api.md)
- [Atomic scoped coordination leases](./docs/coordination.md)

## CLI quick start

```bash
export CONTINUUM_API_URL=http://127.0.0.1:4000
export CONTINUUM_TOKEN='your-opaque-bearer-token'
continuum recall "deployment rollback" --json
```

Installed packages also expose `continuum-migrate`; set
`CONTINUUM_DATABASE_URL` and run it as a trusted operator before starting a
newly installed application version. Production uses a migration-owner URL for
that command and a distinct non-owner application URL for running Continuum;
the offboarding completion ledger relies on that PostgreSQL privilege boundary.

The CLI supports capture, recall, audit, scope membership administration,
promotion, verification, and AGENTS.md generation through the same authenticated
HTTP API used by other clients.

## Embedding configuration

The v0 PostgreSQL schema stores `vector(768)`, so
`CONTINUUM_EMBEDDING_DIM` must be the integer `768`. Continuum rejects other
dimensions while creating the configured provider instead of failing later
during capture or recall.

Vector recall uses only rows whose provider ID and dimension exactly match the
active provider. Changing models therefore leaves existing embedding rows
untouched and temporarily makes their memories full-text-only until they are
re-embedded. Switching back to the old model makes those rows usable again.

For per-scope routing, set `CONTINUUM_EMBEDDING_CONFIG` to a JSON object with
provider definitions and a routing policy:

```json
{
  "providers": [
    {
      "alias": "local",
      "kind": "ollama",
      "model": "nomic-embed-text",
      "dim": 768,
      "endpoint": "http://localhost:11434",
      "local": true
    },
    {
      "alias": "hosted",
      "kind": "openai",
      "model": "text-embedding-3-small",
      "dim": 768,
      "local": false
    }
  ],
  "routing": {
    "default": "hosted",
    "rules": [
      { "match": { "kind": "user" }, "provider": "local-only" },
      { "match": { "kind": "team", "name": "security" }, "provider": "local-only" }
    ]
  }
}
```

Exact `kind` plus `name` rules take precedence over `kind` rules, then the
default applies. `local-only` selects the single provider explicitly marked
`local: true`. If none is configured or it is unavailable, capture and recall
remain full-text-only for those scopes and never fall back to a hosted
provider. Provider outages affect only their routed vector group. Full-text
recall remains available and vector searches retain exact provider and
dimension filters.

Every provider HTTP call has a validated deadline (`timeout_ms` per provider,
or `CONTINUUM_EMBEDDING_TIMEOUT_MS` for the legacy Ollama configuration). The
default is 10000 ms and the maximum is 300000 ms. Cancellation is forwarded to
`fetch`; a provider implementation that ignores cancellation is still bounded
by the local deadline.

OpenAI and Voyage credentials are read only from `OPENAI_API_KEY` and
`VOYAGE_API_KEY`. Inline credentials are rejected. Ollama definitions must
explicitly declare locality; a non-loopback endpoint marked local emits a
startup warning because locality is a deployment assertion, not a URL guess.
The legacy `CONTINUUM_EMBEDDING_PROVIDER` variables remain supported as a
single-provider policy. Existing vectors are never automatically sent to a new
provider. Re-embedding, especially to a hosted provider, must be an explicit
operator action.

The v0 `vector(768)` schema supports OpenAI `text-embedding-3-small` and
`text-embedding-3-large` with an explicit 768-dimensional output. Current
Voyage text models document only 256, 512, 1024, or 2048 dimensions, so Voyage
configuration is rejected at startup instead of accepting a configuration that
will fail on its first response. Voyage becomes configurable when storage gains
a supported dimension; the client remains available for that migration.

Knowledge-gap semantic clustering applies the same routing policy to the exact
scope IDs recorded by each zero-hit recall. A candidate is sent only when every
scope still exists and all scopes resolve to the same provider. Mixed-provider,
empty, malformed, unknown, or legacy scope fidelity remains exact-text-only;
in particular, a query involving any local-only scope cannot fall through to a
hosted provider. This restriction applies to offline gap clustering of one
historical recall candidate. Live recall still routes each readable scope to
its provider group and safely fuses the separate results. Provider outages
degrade to exact/FTS behavior with explicit, content-free status and counts in
the report audit.

## License

Continuum is licensed under the [MIT License](./LICENSE).
