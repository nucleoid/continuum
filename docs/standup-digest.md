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
- `actor`: bounded source-system actor label for display.
- `thread_key`: stable, source-qualified thread identity.
- `closes_thread_keys`: explicit list of stable thread keys closed by this capture.
- `merged_by` and `reviewers`: optional PR participants, distinct from `actor`.

The GitHub PR plugin uses the PR author as `actor`; a merger remains
`merged_by`. Deploy activity uses the deploy actor. Capture authorship is not a
fallback for activity attribution. Missing ownership, actor ID, actor label, or
thread key makes a record ineligible rather than triggering a name-based guess.

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
