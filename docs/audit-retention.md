# Audit retention operations

Continuum keeps audit records indefinitely by default. Audit retention is an
external, one-shot maintenance command. Schedule it with the platform scheduler
of your choice. Do not run it as an API or MCP process timer.

## Configuration

Set `CONTINUUM_AUDIT_RETENTION_DAYS` to a positive integer to enable retention.
Unset or empty keeps retention disabled. Disabled mode ignores retention tuning
and export settings because none of them can affect a disabled run. The runner
derives one cutoff from PostgreSQL's transaction clock in a repeatable-read
transaction, renders it explicitly in UTC regardless of the database session
timezone, and removes only rows with `at` strictly before that cutoff. Dry-run
authority, cutoff, and count all use that same database snapshot, so concurrent
inserts cannot produce a count assembled from different points in time.

The following controls bound every invocation:

- `CONTINUUM_AUDIT_RETENTION_BATCH_SIZE`, default 100, maximum 1,000
- `CONTINUUM_AUDIT_RETENTION_MAX_BATCHES`, default 10, maximum 1,000
- `CONTINUUM_AUDIT_RETENTION_MAX_ROWS`, default 1,000, maximum 100,000

Set `CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID` to an existing principal
that currently has `admin` membership on the singleton org scope. The runner
checks this authority before inspecting audit records and again inside each
delete transaction. Until the credential redesign in issue #24 lands, this
configured external ID is permitted only for trusted local or pilot operation.
It is not a credential and must not be treated as production authentication.

## Optional JSONL export

Set `CONTINUUM_AUDIT_RETENTION_EXPORT_DIR` to an absolute, normalized directory
owned by the runner user with mode `0700` or stricter. It must be outside the
application and any web root. The runner rejects symlinks and path aliases.
Operators are responsible for encryption, backup, access control, and a separate
retention policy for exported files. Exports contain sensitive complete audit
rows, including queries and metadata.

Durable JSONL export is supported on POSIX hosts only. Windows runs without an
export directory remain supported, but configuring export on Windows fails
before a database connection is opened. Node does not expose the Windows
directory-handle semantics needed to uphold the same file-and-directory fsync
contract, so Windows export is not claimed as durable.

Each batch is serialized in stable `(at, id)` order to deterministic, versioned
JSONL (`archive_format: "continuum-audit-v1"`). Timestamps are database-rendered
UTC strings with all six PostgreSQL fractional digits. PostgreSQL's `-infinity`
and `infinity` timestamp values are preserved as those exact strings.
`metadata_json` is the canonical PostgreSQL `jsonb` text stored as a JSON string;
restore it by casting that string to `jsonb`. This avoids JavaScript timestamp
truncation, special-key assignment (including `__proto__`), and JSON-number
rounding during export or by a generic parser reading the outer JSONL record.

A temporary owner-only file is flushed and closed, then published with an atomic
same-filesystem no-replace hard-link operation and the temporary name is removed.
An existing final file is reused only when its complete bytes and SHA-256 digest
match. Every new or reused path fsyncs both the file and its containing directory
before deletion proceeds. The content-addressed filename contains the exact
selected ID range and digest, so retry lookup is one direct path operation rather
than a directory scan and a restarted process can reuse the file even though its
newly captured cutoff differs. A mismatch stops the run without deleting the
selected database rows.

Export happens before database deletion. A crash after file publication but
before commit can therefore leave an extra file, but the next invocation safely
reuses it. This at-least-once export contract avoids audit data loss across the
filesystem and PostgreSQL transaction boundary.

## Running and scheduling

Build first, then preview the exact fixed-cutoff eligible count:

```sh
npm run build
npm run audit-retention -- --dry-run
```

Run one bounded maintenance invocation:

```sh
npm run audit-retention
```

Development uses `npm run audit-retention:dev`. Command-line overrides are
available for `--batch-size`, `--max-batches`, and `--max-rows`. All output is a
single structured JSON summary. A disabled or lock-busy invocation exits without
mutation. Failures exit nonzero and do not log credentials or audit payloads.

Only one runner can hold the dedicated advisory lock. Successful batches delete
exactly their selected IDs and verify the deleted values still byte-match the
selected export candidate. A concurrent row change rolls the delete back. The
runner then writes one sanitized `action='archive'` summary in the same
transaction. The summary includes the cutoff, ID and time
range, row count, run and batch identifiers, and only the export basename and
digest. It never includes raw queries, metadata, payloads, or credentials.

Keep normal autovacuum enabled and monitor dead tuples, table size, command
duration, and replica lag. Increase limits only from measured evidence. This
feature does not partition `audit_log`, implement issue #27 erasure, or invent
the issue #24 credential model.
