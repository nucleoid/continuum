# Continuum

Vendor-agnostic memory layer for development teams. Captures, scopes, and serves the institutional knowledge that normally lives in people's heads, chat threads, and lost Slack messages.

Continuum is designed for organisations that want their developers (and the AI agents helping them) to share context across people, projects, and time without locking themselves to any one LLM vendor or IDE.

## What it does

- Captures memory from PRs, work-item comments, branch events, deploy events, terminal session summaries, and (optionally) team chat.
- Organises every memory under one of five scopes: `org`, `team`, `project`, `user`, `role`.
- Serves memory back through three transports: an MCP server (works with Claude Code, Cursor, Copilot Chat, Continue, Zed), a stable HTTP REST API (for internal tooling and CI), and an `AGENTS.md` generator (drops a scope-aware context file into any repo).
- Enforces per-scope ACLs at the API layer and writes a full audit trail for every read and write.
- Storage is Postgres + pgvector. Embeddings are pluggable (local Ollama for sensitive material, hosted models for the rest).

## What it is not

- Not a wiki. Continuum is structured memory with taxonomy and decay rules, not free-form pages.
- Not a notebook. Personal notes live in `user` scope but are first-class citizens of the same system shared knowledge uses, not a sidecar.
- Not coupled to any LLM provider. The data is plain text plus structured metadata; the LLM is just one of several consumers.

## Status

v0 design in progress. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the schema, scope model, capture API, and extension points.

## API contracts

- [Audit query API](./docs/audit-api.md)
- [Knowledge-gap insights](./docs/knowledge-gap-insights.md)
- [API operations, health checks, and shutdown](./docs/api-operations.md)
- [AGENTS.md ETag and freshness checks](./docs/agents-md-freshness.md)
- [Lifecycle sweeper and review queue](./docs/lifecycle.md)

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

OpenAI and Voyage credentials are read only from `OPENAI_API_KEY` and
`VOYAGE_API_KEY`. Inline credentials are rejected. Ollama definitions must
explicitly declare locality; a non-loopback endpoint marked local emits a
startup warning because locality is a deployment assertion, not a URL guess.
The legacy `CONTINUUM_EMBEDDING_PROVIDER` variables remain supported as a
single-provider policy. Existing vectors are never automatically sent to a new
provider. Re-embedding, especially to a hosted provider, must be an explicit
operator action.

## License

Continuum is licensed under the [MIT License](./LICENSE).
