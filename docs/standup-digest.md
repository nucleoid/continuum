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
- `thread_owner_principal_id`: optional explicit user UUID that owns the thread.
- `closes_thread_keys`: explicit list of stable thread keys closed by this capture.
- `_continuum_activity_provenance`: internal trust marker written only after
  attribution authorization; capture callers cannot supply it.
- `_continuum_activity_epoch_ms`: internal original activity time carried only
  when trusted activity is promoted; capture callers cannot supply it.
- `merged_by` and `reviewers`: optional PR participants, distinct from `actor`.

The GitHub PR plugin uses the PR author as `actor`; a merger remains
`merged_by`. Deploy activity uses the deploy actor. The production
`capturePluginEvent` path resolves only `(authority, external_actor_id)` pairs
that an org administrator explicitly provisioned in
`actor_principal_mappings`. GitHub webhook `user.id` values are looked up under
`github.<authenticated-service-principal-uuid>`; this separates GitHub.com or
GitHub Enterprise producers whose numeric ID spaces may overlap. Mutable logins
remain untrusted source content and do not determine the displayed actor. Deploy
and terminal identities use the same immutable
producer pattern (`<plugin-id>.<principal-uuid>`). Their
payload `actorAuthority`, `threadKey`, and `closesThreadKeys` fields are ignored;
the server uses the immutable `actorExternalId` and creates canonical thread
keys inside that authenticated source namespace.

The authenticated ingestion service principal remains the capture author and
must have writer access to the destination scope. It is not the activity actor
and is never used as a fallback. An absent mapping, missing deploy actor, or
mapping to anything other than an existing user stores a normal non-standup
record without `actor_principal_id`. Missing ownership, actor ID, actor label,
thread key, or the internal provenance marker makes a record ineligible rather
than triggering a display-name guess. Pre-migration rows are deliberately not
backfilled because their reserved metadata was caller-controlled and cannot be
retrospectively authenticated.

Raw REST and MCP capture reject every actor, thread, closure, provenance, and
activity-time field for both users and services. Service ingestion must use
`capturePluginEvent`, which removes untrusted plugin activity metadata,
resolves the event's immutable external identity through the admin-controlled
mapping, and verifies that mapping again in the write transaction. Unmapped
events and plugins not explicitly trusted for activity cannot create activity
or close threads. Terminal and deploy producers can close only
canonical threads generated for their own authenticated source namespace;
caller-supplied closure keys are ignored. A supplied principal UUID, authority,
or actor label is never accepted as identity or as the displayed actor.

Open threads use `thread_owner_principal_id`, falling back to the actor ID only
for historical records. A capture by another actor may close a thread only
when it explicitly carries the same thread owner. Closures after a requested
historical window do not rewrite that historical view. Terminal summaries
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
internal provenance marker, and carry the original activity time so the digest
does not re-date the work. Legacy rows without that marker lose actor, thread,
closure, provenance, and activity-time fields during promotion. Expired
promoted activity remains excluded.

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
