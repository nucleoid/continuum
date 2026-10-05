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
the stable `github` authority by default. `github-pr` and `github-branch` must
use the same configured activity namespace; startup fails when both are enabled
with different values. This keeps branch and PR thread keys stable even when
their webhooks use different service principals. Separate GitHub installations
whose numeric ID spaces may overlap must configure a shared installation-specific
namespace on both plugins. Mutable logins remain untrusted source content and
do not determine the displayed actor. An
unmapped label may be retained as `source_actor_label` for diagnostics, but it
is non-authoritative and never makes a record standup-eligible. Deploy
and terminal identities use the same immutable namespace pattern (the plugin
ID by default). Their
payload `actorAuthority`, `threadKey`, and `closesThreadKeys` fields are ignored;
the server uses the immutable `actorExternalId` and creates canonical thread
keys inside that authenticated source namespace.

During rollout, actor mapping lookup first checks the stable namespace and then
the legacy `<plugin-id>.<service-principal-uuid>` authority. New thread keys
always use the stable namespace, so accepting a legacy mapping does not fragment
threads. For GitHub branch scope routing, Continuum first checks the numeric
`sender.id` alias and temporarily falls back to an existing login alias. That
fallback preserves capture availability but never grants standup attribution;
new aliases and actor mappings must use the immutable numeric ID. Run
`scripts/preflight-standup-rollout.sql` before removing legacy entries.

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
Deploy events are terminal facts and explicitly close their own canonical
thread in the same capture. They therefore cannot become permanent open work;
the open-thread query also considers only context memories.
Archived or expired closure memories remain historical closure evidence and
do not reopen a thread. Expired activity and expired open-thread candidates
are excluded from standups using the database clock.

## Actor identity mapping

Mapping is a separate org-admin authority from ingestion. Review the provider's
immutable/opaque subject ID and the target user principal UUID, then run:

```sh
psql "$CONTINUUM_DATABASE_URL" \
  -v authority='github' \
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

For deploy and terminal mappings, use the configured activity namespace,
`deploy-event` and `terminal-summary` by default. When multiple independent
identity domains feed one Continuum deployment, configure a distinct validated
namespace for each domain before creating mappings.

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
fields during promotion. A trusted promoted copy also caps its expiry at the
source expiry, even when the destination scope normally lives longer. A
destination scope's fresh lifecycle cannot extend or revive source activity.

## Mapping-enforcement rollout

Ordinary startup applies schema migrations `0010` through `0012`. Migration
`0013_standup_indexes.sql` builds the four potentially large memory indexes
with `CREATE INDEX CONCURRENTLY` outside a transaction. None of these startup
migrations rewrites existing memory rows. Strict readers and promotion already
fail closed for legacy or forged metadata, so destructive cleanup is not a
correctness prerequisite.

Before rollout, run the read-only inventory and retain its output in change
control:

```sh
psql "$CONTINUUM_DATABASE_URL" -f scripts/preflight-standup-rollout.sql
```

The `0010`-`0012` mapping-table sequence is applied under the migrator lock and
must complete before any mapping-aware writer starts; it performs no historical
`audit_log` rewrite. First deploy mapping-aware writers everywhere, verify
stable namespace and numeric alias coverage, and drain old writers. Deploy
strict readers only after that writer gate is complete. If policy requires
removing dormant reserved metadata from a prerelease deployment, schedule a
maintenance window and run
`scripts/run-standup-mapping-enforcement.sql`. It strips reserved fields only,
uses a five-second lock timeout, and processes at most 10,000 invalid rows per
statement. Rerun the preflight and cleanup until `cleanup_candidates` reaches
zero. Do not run the cleanup from application startup, and do not overlap it
with older promotion workers. Already stripped rows remain ordinary memories;
valid rows keep the exact active mapping UUID, authority, actor, and owner.

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
