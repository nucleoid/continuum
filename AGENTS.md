# Continuum: Agent Bootstrap

This file is the canonical entry point for any AI coding agent working in this repository. Read it before doing anything else.

## What this repo is

Continuum is a standalone, vendor-agnostic memory layer for development teams. It is **not** part of Engram, but it exposes extension points that make Engram integration straightforward. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Working style

- Stay vendor-agnostic. No hard dependencies on Anthropic, OpenAI, or any specific embedding provider. Everything pluggable behind interfaces.
- All shared docs target `AGENTS.md` first; `CLAUDE.md` (if it ever appears) is a thin pointer that says "see AGENTS.md".
- Never reference Total Recall as prior art in commits, comments, or docs. Continuum borrows ideas from many systems; the lineage stays unattributed in source.
- No client-specific code in core. Per-tenant capture plugins live under `src/plugins/tenants/{TenantName}/`. Core stays multi-tenant.
- No em-dashes in user-facing text (docs, READMEs, API error messages, commit subjects).
- No speculative complexity. Build what the next milestone needs. Future-proofing is an anti-pattern until a real second use case shows up.
- AGENTS.md output (the generator transport) is a first-class product surface. If you touch retrieval, also touch the AGENTS.md generator.

## Layout (target)

```
src/
  api/            REST + MCP transports
  capture/        Capture plugin interfaces and built-ins
  storage/        Postgres + pgvector schema and queries
  scopes/         Scope model and ACL enforcement
  embeddings/     Pluggable embedding providers
  audit/          Audit log
  plugins/
    tenants/      Per-tenant capture plugins (e.g. ExampleOrg)
  cli/            `continuum` CLI
docs/             Public-facing docs
ARCHITECTURE.md   v0 schema and design
README.md         Marketing-facing summary
AGENTS.md         This file
```

## What to do first when working here

1. Read [ARCHITECTURE.md](./ARCHITECTURE.md) cover-to-cover.
2. Check open issues / current milestone before adding scope.
3. If you are unsure whether a change is in scope, ask before building.
