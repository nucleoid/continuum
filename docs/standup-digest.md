# Standup digest

Continuum composes a personal standup from records that carry explicit
identity and thread metadata. It does not summarize with an LLM and does not
post or schedule the result.

## Ownership and activity contract

Every newly provisioned `user` scope requires `owner_principal_id`. The
database permits null only so existing scopes can be reviewed and backfilled;
an unowned scope is never considered personal activity. Ownership is unique,
so one principal cannot own two user scopes. Non-user scopes cannot have an
owner.

Standup-eligible captures use these reserved metadata fields:

- `actor_principal_id`: UUID of the actual person who performed the activity.
- `actor`: bounded mapped-principal display label loaded inside the write transaction.
- `thread_key`: stable, source-qualified thread identity.
- `thread_owner_principal_id`: required actor UUID, equal to `actor_principal_id`.
- `closes_thread_keys`: explicit list of stable thread keys closed by this capture.
- `_continuum_activity_provenance`: internal trust marker written only after
  attribution authorization; capture callers cannot supply it.
- `_continuum_activity_epoch_ms`: internal original activity time carried only
  when trusted activity is promoted; capture callers cannot supply it.
- `_continuum_actor_mapping_id`: UUID of the exact mapping that authorized capture.
- `_continuum_actor_mapping_authority`: authenticated producer namespace on
  that exact mapping.
- `merged_by` and `reviewers`: optional PR participants, distinct from `actor`.

The GitHub PR plugin uses the PR author as `actor`; a merger remains
`merged_by`. Deploy activity uses the deploy actor. The production
`capturePluginEvent` path resolves only `(authority, external_actor_id)` pairs
that an org administrator explicitly provisioned in
`actor_principal_mappings`. GitHub webhook `user.id` values are looked up under
`github.<authenticated-service-principal-uuid>`; this separates GitHub.com or
GitHub Enterprise producers whose numeric ID spaces may overlap. Mutable logins
remain untrusted source content and do not determine the displayed actor. An
unmapped label may be retained as `source_actor_label` for diagnostics, but it
is non-authoritative and never makes a record standup-eligible. Deploy
and terminal identities use the same immutable
producer pattern (`<plugin-id>.<principal-uuid>`). Their
payload `actorAuthority`, `threadKey`, and `closesThreadKeys` fields are ignored;
the server uses the immutable `actorExternalId` and creates canonical thread
keys inside that authenticated source namespace.

The authenticated ingestion service principal remains the capture author and
must have writer access to the destination scope. It is not the activity actor
and is never used as a fallback. An absent mapping, missing deploy actor ID, or
mapping to anything other than an existing user stores a normal non-standup
record without `actor_principal_id`. A mapped event does not need a caller
label: the displayed actor is loaded solely from the mapped principal. Missing
ownership, actor ID, thread key, provenance, mapping UUID, mapping authority,
or an active exact mapping for that authority and principal makes a record
ineligible rather than triggering a display-name guess. Pre-migration rows are
never backfilled because their reserved metadata was caller-controlled and
cannot be retrospectively authenticated.

Raw REST and MCP capture reject every actor, thread, closure, provenance, and
activity-time field for both users and services. Service ingestion must use
`capturePluginEvent`, which removes untrusted plugin activity metadata,
resolves the event's immutable external identity through the admin-controlled
mapping, and verifies that mapping again in the write transaction. Unmapped
events and plugins not explicitly trusted for activity cannot create activity
or close threads. Terminal and deploy producers can close only
canonical threads generated for their own authenticated source namespace.
Oversized terminal session IDs use a deterministic SHA-256 thread-key suffix;
caller-supplied closure keys are ignored. A supplied principal UUID, authority,
or actor label is never accepted as identity or as the displayed actor.

Thread ownership is not delegation. Standup rows require
`thread_owner_principal_id` to equal `actor_principal_id`; missing or mismatched
historical metadata is ineligible. Only that actor's later trusted captures can
close the thread. Closures after a requested historical window do not rewrite
that historical view. Terminal summaries
close their session thread by default; producers must set `keepThreadOpen`
when the summarized session intentionally remains actionable.
Archived or expired closure memories remain historical closure evidence and
do not reopen a thread. Expired activity and expired open-thread candidates
are excluded from standups using the database clock.

## Actor identity mapping

Mapping is a separate org-admin authority from ingestion. Review the provider's
immutable/opaque subject ID and the target user principal UUID, then run:

```sh
psql "$CONTINUUM_DATABASE_URL" \
  -v authority='github.<authenticated-service-principal-uuid>' \
  -v external_actor_id='<exact provider actor id>' \
  -v principal_id='<user principal UUID>' \
  -v admin_principal_id='<reviewing org-admin UUID>' \
  -f scripts/set-actor-principal-mapping.sql
```

The database trigger requires the target to remain a user and the mapper to be
an org admin. Every insert is audited by the database itself. Mapping identity,
target, creator, and history rows are immutable, and history can never be
deleted. To revoke an active mapping, run
`scripts/revoke-actor-principal-mapping.sql`; to atomically revoke and replace
one, run `scripts/update-actor-principal-mapping.sql`. Both require the exact
authority and external ID plus a current org-admin UUID. The database stamps
the revocation time, records a revocation audit, retains the old row, and lets
resolution see only the single active row. Never use `display_name`, scope
names, email labels, or a service principal's identity to infer the human actor.
Mapping and capture audits reference the internal mapping UUID and authority;
they do not duplicate the provider's opaque actor ID. Capture holds a shared
mapping lock through persistence, while revocation/replacement takes an update
lock, so a capture cannot commit against a concurrently revoked mapping.

Revocation retires all standup activity and closure semantics authorized by
that exact historical mapping UUID. Replacing a mapping does not reactivate old
rows, even when the replacement points to the same principal. Only captures
written after replacement carry the new mapping UUID and become eligible.
Memory bodies and ordinary metadata remain available through their normal ACLs.

For deploy and terminal mappings, use the generated authority shown above,
for example `terminal-summary.<authenticated-service-principal-uuid>`. This
prevents one ingestion service from reusing another producer's actor mappings.

## REST and MCP

`GET /api/v0/standup?since=24h` returns JSON. `since` accepts 1 through 168
hours. To request a local calendar day, use both `date=YYYY-MM-DD` and an IANA
`timezone`, for example:

```text
GET /api/v0/standup?date=2026-10-05&timezone=Pacific%2FAuckland
```

`date` and `since` are mutually exclusive. `limit` is 1 through 100, `offset`
is at most 10000, `openThreadDays` is 1 through 30, and `openThreadLimit` is 1
through 100. Open-thread candidates are limited to the preceding 90 days.
Responses are private and non-cacheable. They contain titles and citations,
not memory bodies.

`continuum.standup` accepts the equivalent MCP arguments and returns escaped,
deterministic Markdown with a source, memory UUID, and source reference for
each item. Both transports audit the request and every delivered memory before
returning data. If auditing fails, no digest is returned.

Only the caller's explicitly owned user scope and explicitly readable project
scopes are searched. Every returned record must have
`actor_principal_id` equal to the caller. Team, role, org, unowned user, and
other actors' records are excluded.

Promotion moves knowledge between scopes but is not a new activity event.
Promoted copies preserve activity metadata only when the source has Continuum's
internal provenance marker and its exact mapping UUID, authority, and principal
still identify an active mapping. Promotion holds a shared lock on that mapping
through the destination write and carries the original activity time so the
digest does not re-date the work. Legacy, forged, revoked-mapping, or already
expired rows lose actor, thread, closure, provenance, mapping, and activity-time
fields during promotion. A destination scope's fresh lifecycle cannot revive
expired activity.

## Mapping-enforcement rollout

Migration `0010_standup_mapping_enforcement.sql` strips all reserved activity,
thread, closure, provenance, and mapping keys from rows that do not match one
active mapping UUID, authority, and actor principal, or whose explicit thread
owner is missing or differs from the actor. It retains the memory body and all
ordinary metadata. This cleanup is intentionally fail-closed: legacy
reserved fields are not copied into a quarantine metadata object where an old
reader or later promotion could treat them as active semantics.

For a mixed-version deployment, first deploy the `0009` mapping-aware capture
writers everywhere and verify that no older writer can create standup rows
without mapping UUID and authority. Then drain old application instances (or
quiesce capture, promotion, and standup reads), apply `0010`, deploy the strict
reader/promotion version to every instance, and resume traffic. Do not let an
older promotion worker overlap the cleanup because it can copy a provenance-only
legacy row after the migration has scanned it. If instances run migrations at
startup, use a maintenance rollout so the first strict instance applies `0010`
only after old instances are drained. The migration is safe to rerun during
verification: already stripped rows remain ordinary memories and valid mapped
rows remain unchanged.

## Existing user-scope backfill

Inventory unowned user scopes and identify owners from reviewed identity-system
records. Never map by `scopes.name`, `principals.display_name`, or membership.
For each approved one-to-one mapping, run:

```sh
psql "$CONTINUUM_DATABASE_URL" \
  -v scope_id='<user scope UUID>' \
  -v owner_principal_id='<user principal UUID>' \
  -v admin_principal_id='<reviewing org-admin UUID>' \
  -f scripts/set-user-scope-owner.sql
```

The script locks the target, verifies the owner is a user, verifies the
reviewer is an org admin, refuses conflicting ownership, and writes an audit
row. Leave uncertain scopes unowned; they remain excluded from standups.
