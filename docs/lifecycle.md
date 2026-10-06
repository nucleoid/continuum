# Lifecycle operations

Continuum's lifecycle sweeper is a one-shot operator command. Run it from a
scheduler such as cron, systemd, or a container job:

```sh
npm run build
npm run sweep
```

The command processes bounded transactions until no full batch remains. Each
transaction uses `FOR UPDATE SKIP LOCKED`, so overlapping jobs can share work
without transitioning or auditing a memory twice. Run a non-mutating preview
before first deployment:

```sh
npm run sweep -- --dry-run
```

Preview output groups eligible rows as `archive:context`, `stale:fact`, and
`stale:relationship`. Decisions and playbooks are never changed by the sweep.
Playbooks become review-due in the review queue 180 days after creation or the
last verification.

## Configuration

- `CONTINUUM_LIFECYCLE_BATCH_SIZE` sets the transaction batch size. Default
  `100`, minimum `1`, maximum `1000`. `--batch-size N` overrides it.
- `CONTINUUM_REVIEW_HORIZON_DAYS` sets the default expiring-soon horizon for
  REST and MCP. Default `14`, minimum `0`, maximum `365`. Callers may provide a
  bounded per-request override.

There is no in-process timer. One-shot execution keeps scheduling, retries, and
deployment ownership visible to operators and avoids duplicate timer ownership
across API replicas.

The migration seeds the reserved `system:lifecycle` service principal for audit
attribution. It has no external login identifier, and a database trigger rejects
membership grants to its reserved UUID. It therefore remains noninteractive
across rolling deploys and code rollbacks; REST and MCP also reject its UUID as
defense in depth. Every state transition, embedding deletion for an archived
context, and audit row commits atomically.

Migration `0023_offboarding_erasure.sql` generalizes embedding cleanup: every
transition to `archived`, including supersession, direct maintenance, and
offboarding, deletes the derived row. New embedding writes lock and recheck the
parent and are rejected unless it remains live. Migration
`0024_offboarding_embedding_cleanup.sql` installs a bounded cleanup function and
runs one 1,000-row upgrade batch. Operators call the function in committed
batches until it returns zero; the migration does not claim a complete backfill.
The sweeper excludes expired rows in offboarding-fenced owned scopes, which are
the offboarding run's responsibility, so one incomplete erasure cannot stall
lifecycle work in other scopes.

## Review queue

`GET /api/v0/review-queue` accepts repeated `scope` and `type` query parameters,
plus `limit`, `offset`, and `horizonDays`. `continuum.review_queue` accepts the
equivalent `scopes`, `types`, `limit`, `offset`, and `horizon_days` fields.

The queue includes stale facts and relationships, review-due playbooks, and
live memories expiring within the horizon. A result must be currently readable,
and the caller must either be its author or hold an explicit writer/admin role
on its scope. Implicit org readability alone does not create review work.
