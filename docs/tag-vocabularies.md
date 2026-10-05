# Controlled tag vocabularies

Continuum validates capture tags against a global vocabulary for the target
scope kind. Input is trimmed and lowercased. Tags must contain 1 to 64
lowercase letters or numbers separated by single hyphens. A request may contain
at most 32 tags, and duplicates after normalization are rejected.

Unknown tags fail before embedding or persistence with HTTP 422. The response
contains `code: "UNKNOWN_TAGS"`, the scope kind, sorted unknown tags, and up to
100 allowed tags. MCP capture returns the same fields under the stable service
error `details` object.

The built-in vocabulary contains `ado`, `branch`, `decision`, `deploy`,
`github`, `knowledge-gap`, `merged`, `pr`, `session`, and `terminal` for every scope kind.
Azure DevOps state and custom tags, plus deployment environment and status,
remain available in capture metadata but are not taxonomy tags.

## Upgrade behavior

Migration `0010_tag_vocabularies.sql` is a one-way rewrite of historical
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

Use this mixed-version webhook rollout sequence:

1. Pause webhook intake at the provider or ingress. Return a retryable response
   or retain deliveries in the provider queue; do not acknowledge and discard
   ADO or deployment events.
2. Drain in-flight webhook deliveries and all other memory-writing requests.
   Confirm no old application transaction remains open on `memories`.
3. Back up the database.
4. Run `continuum-migrate` to completion. Confirm
   `0010_tag_vocabularies.sql` is recorded in `_continuum_migrations`.
5. Deploy the vocabulary-aware application to every instance.
6. Resume webhook intake only after every instance is compatible.
7. Replay retained deliveries with their original delivery identities and
   unchanged payload bytes. Replay is idempotent: ADO uses the envelope `id`,
   deploy events use the original `Idempotency-Key`, and completed deliveries
   return their original memory IDs instead of creating duplicates.

The migration sets a five-second `lock_timeout`, then takes an `EXCLUSIVE` lock
on `memories` before it scans historical rows, rewrites changed rows, and
installs the database trigger in the same transaction. `EXCLUSIVE` drains
writers that first took row locks with `SELECT ... FOR UPDATE`, avoiding a lock
upgrade deadlock. `ACCESS SHARE` remains compatible, so reads continue. If the
write drain exceeds five seconds, the migration rolls back without rewriting
rows; finish or end the long transaction and retry `continuum-migrate`.

Once the migration commits, PostgreSQL rejects duplicate or out-of-vocabulary
tags with a check-violation error. The trigger locks only matching vocabulary
rows, so a concurrent delete cannot remove a tag after an old writer has
validated it. Keep webhook intake paused until the compatible deploy finishes:
old ADO and deploy plugins emit dynamic tags that this strict trigger rejects.
Do not deploy the new application before the migration, because its vocabulary
queries require the new table.

### Application rollback after migration

If the application must be rolled back to a version whose ADO/deploy plugins
emit dynamic tags, use this exact procedure:

1. Pause webhook intake and drain in-flight webhook and memory writes.
2. From the installed Continuum package root, enable the bounded compatibility
   trigger before the application rollback:

   ```sh
   psql "$CONTINUUM_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f scripts/enable-tag-legacy-writer-compat.sql
   ```

3. Roll back every application instance, then resume webhook intake.
4. Replay retained events with the original delivery identities and payloads.

The rollback trigger remains strict for manual and all non-ADO/deploy writers.
For legacy `ado-workitem` and `deploy-event` rows only, it keeps unique allowed
tags active and appends unknown or duplicate values to that memory's private
`metadata.continuum_legacy_tags`. It takes an `EXCLUSIVE` lock with the same
five-second timeout, so reads continue and failure is atomic. A later forward
application deployment may leave this compatibility trigger installed: current
application validation rejects unknown tags before persistence, while the
trigger continues protecting direct and legacy database writers.

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
