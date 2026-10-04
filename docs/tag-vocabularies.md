# Controlled tag vocabularies

Continuum validates capture tags against a global vocabulary for the target
scope kind. Input is trimmed and lowercased. Tags must contain 1 to 64
lowercase letters or numbers separated by single hyphens. A request may contain
at most 32 tags, and duplicates after normalization are rejected.

Unknown tags fail before embedding or persistence with HTTP 422. The response
contains `code: "UNKNOWN_TAGS"`, the scope kind, sorted unknown tags, and up to
100 allowed tags. MCP capture returns the same fields in its service error.

The built-in vocabulary contains `ado`, `branch`, `decision`, `deploy`,
`github`, `merged`, `pr`, `session`, and `terminal` for every scope kind.
Azure DevOps state and custom tags, plus deployment environment and status,
remain available in capture metadata but are not taxonomy tags.

## REST management

Any authenticated principal can list a vocabulary:

```text
GET /api/v0/tag-vocabularies?scopeKind=project
```

Only a principal with explicit `admin` membership on the singleton org scope
can mutate entries:

```text
POST   /api/v0/tag-vocabularies
PATCH  /api/v0/tag-vocabularies/:scopeKind/:tag
DELETE /api/v0/tag-vocabularies/:scopeKind/:tag
```

Create accepts `{ "scopeKind", "tag", "description"? }`. Update accepts
`{ "description" }`. A tag cannot be deleted while any memory in the same
scope kind uses it. Every successful mutation writes a `write` audit entry with
the operation, actor, scope kind, tag, and bounded before/after metadata.

## CLI

Set `CONTINUUM_BEARER` to the calling principal's external ID and optionally
set `CONTINUUM_API_URL` (default `http://localhost:4000`), then run:

```text
npm run tags -- list project
npm run tags -- add project release-ready "Approved for release"
npm run tags -- update project release-ready "Ready to deploy"
npm run tags -- remove project release-ready
```

Installed packages also expose the `continuum-tags` executable with the same
arguments.
