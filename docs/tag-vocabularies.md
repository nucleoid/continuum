# Controlled tag vocabularies

Continuum validates capture tags against a global vocabulary for the target
scope kind. Input is trimmed and lowercased. Tags must contain 1 to 64
lowercase letters or numbers separated by single hyphens. A request may contain
at most 32 tags, and duplicates after normalization are rejected.

Unknown tags fail before embedding or persistence with HTTP 422. The response
contains `code: "UNKNOWN_TAGS"`, the scope kind, sorted unknown tags, and up to
100 allowed tags. MCP capture returns the same fields in its service error.

The built-in vocabulary contains `ado`, `branch`, `decision`, `deploy`,
`github`, `knowledge-gap`, `merged`, `pr`, `session`, and `terminal` for every scope kind.
Azure DevOps state and custom tags, plus deployment environment and status,
remain available in capture metadata but are not taxonomy tags.

## Upgrade behavior

Migration `0007_tag_vocabularies.sql` is a one-way rewrite of historical
memory tags. Only the ten built-in tags listed above remain active. Every other
original value is removed from `tags` and retained, unchanged and in order, in
`metadata.continuum_legacy_tags`; this includes well-formed private tags,
plugin dimensions, malformed values, and null array elements. Built-in values
are normalized and deduplicated. Non-object metadata inserted outside the
application is preserved under `metadata.continuum_legacy_metadata`.

Continuum has no memory-tag editing or automatic restoration operation. Adding
a quarantined tag to the vocabulary later does **not** put it back on existing
memories. Back up the database before upgrading; restoring that backup is the
only supported way to undo the rewrite.

Use this rolling-deploy sequence:

1. Back up the database.
2. Run `continuum-migrate` to completion while existing application processes
   remain online.
3. Deploy the vocabulary-aware application version only after migration
   `0007_tag_vocabularies.sql` is recorded in `_continuum_migrations`.

The migration rewrites historical rows and installs a database trigger in one
transaction. Once it commits, an old application process can continue writing
empty or built-in tags, but PostgreSQL rejects any out-of-vocabulary tag with
a check-violation error. The trigger locks only matching vocabulary rows, so a
concurrent delete cannot remove a tag after an old writer has validated it.
This fail-closed boundary prevents old-writer corruption during step 3. Do not
deploy the new application before the migration, because its vocabulary
queries require the new table.

Legacy values remain private to each memory instead of entering the shared
scope-kind vocabulary. Promotion deliberately copies source metadata,
including `continuum_legacy_tags`, to the destination memory because promotion
is an explicit copy by a caller authorized for both scopes.

`metadata.continuum_legacy_tags` is reserved for migration-owned provenance.
Capture requests and ingestion plugins cannot set it directly.

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
`{ "description" }`. A system tag cannot be deleted. A custom tag cannot be
deleted while any memory in the same scope kind uses it. Every successful
mutation writes a `write` audit entry with the operation, actor, scope kind,
tag, and bounded before/after metadata.

Promotion validates active source tags against the destination scope kind's
vocabulary. If the destination does not allow every tag, promotion returns
`UNKNOWN_TAGS` (HTTP 422). Add the required custom tags to the destination
vocabulary before retrying.

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
