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
- [API operations, health checks, and shutdown](./docs/api-operations.md)

## Embedding configuration

The v0 PostgreSQL schema stores `vector(768)`, so
`CONTINUUM_EMBEDDING_DIM` must be the integer `768`. Continuum rejects other
dimensions while creating the configured provider instead of failing later
during capture or recall.

Vector recall uses only rows whose provider ID and dimension exactly match the
active provider. Changing models therefore leaves existing embedding rows
untouched and temporarily makes their memories full-text-only until they are
re-embedded. Switching back to the old model makes those rows usable again.

## License

Continuum is licensed under the [MIT License](./LICENSE).
