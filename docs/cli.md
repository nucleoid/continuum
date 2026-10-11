# Continuum CLI

Org-admin identity, group-binding, and offboarding commands are exposed through
`npm run admin`; see [authentication.md](./authentication.md) and
[offboarding.md](./offboarding.md). These admin commands connect directly to
PostgreSQL, separately from the HTTP `continuum` client. Before using the admin examples:

```sh
export CONTINUUM_DATABASE_URL="$CONTINUUM_OPERATOR_DATABASE_URL"
export CONTINUUM_ADMIN_ACTOR='<bound-org-admin-external-id>'
```

`CONTINUUM_OPERATOR_DATABASE_URL` is a private convenience variable for the
dedicated DB-bound operator connection; the program reads only
`CONTINUUM_DATABASE_URL`. `CONTINUUM_ADMIN_ACTOR` is the approved administrator's
principal `external_id`, not an access token, API key, or the internal principal
UUID supplied as a command argument. The database operator binding and active
manual org-admin authority must agree. Do not use the shared application
connection for irreversible administration.

Offboarding supports a non-mutating `--dry-run` count and bounded UUID evidence
before execution. Execution requires
`--confirm-scope <user-scope-id>` matching the locked mapping and accepts
`--batch-size <1-5000>` for the resumable fenced procedure. The exact final
database proof defaults to 30 seconds; use
`--verification-timeout-ms <1-300000>` only from measured operator evidence.
The admin command loops until `complete: true` by default. Use `--once` for an
external one-batch orchestrator, and `list-incomplete-offboarding` to enumerate
durable unfinished runs before or after maintenance. Every non-dry-run
`offboard-principal` or `repair-coordination-privacy` response with
`complete: false` exits nonzero: status 2 means a resumable single batch,
no-progress stop, or attempt cap; status 3 means a typed blocking condition
such as `live_lease`, `owned_live_lease`, `migration_pending`,
`offboarding_required`, `detached_quota`, or `lock_busy`. Fatal command failures
remain status 1. Automation must inspect both the status and the structured
`incompleteReason`, `reason`, `blockedUntil`, `resumeRecommended`, and
`resumeAfter` fields. `no_progress` is a resumable status 2 stop.
These non-null blocking reasons produce status 3; `no_progress` produces status 2.
That blocking status takes precedence over `--once`: an unblocked incomplete
single batch exits 2, while a typed block exits 3 even with `--once`.
A server verification deadline returns `COORDINATION_TIMEOUT` and exits 2 with
a sanitized error on stderr. Previously committed batches remain durable;
resume using a verification budget chosen from measured database behavior.
Completed-run privacy re-scrubs commit before the subsequent exact proof.
A dry-run preview never claims exact completion from bounded counts and does
not require execution of operator-only verification routines.
`resumeAfter` is populated only when the database supplied a `blockedUntil`
timestamp. Check `complete` and the reason fields directly; a false
`resumeRecommended` alone does not prove completion. A dry-run uses false
without performing completion.
`migration_pending` requires owner migration/backfill completion before retry.
`owned_live_lease` means existing owned-scope privacy work must wait for expiry;
`blockedUntil` may contain one observed live-lease expiry, or may be null. Recheck
the full scope after that time. For `offboarding_required`, use the ordinary
confirmed `offboard-principal` command; coordination-only repair does not prove
the offboarded target's full lifecycle state is erased.
Mapping a legitimately shared personal scope requires the explicit
`map-user-scope ... --allow-other-active-members` acknowledgement.

`list-coordination-privacy-repairs [--limit <1-1000>] [--after <principal-id>]`
returns one bounded discovery window with `repairs`, `nextCursor`, `hasMore`,
and `scannedCount`. The default limit is 100. Follow a non-null `nextCursor` even when `repairs` is empty
or short. Filtered candidates consume scan slots; the command never fills a
page by scanning indefinitely. Migration 0081 and the current operator profile
are required. Missing paging support returns `DEPENDENCY_UNAVAILABLE` instead
of falsely reporting the end of the list.

The `continuum` command uses the authenticated HTTP API. It never connects to
PostgreSQL directly. Install the package, then run `continuum --help`.

## Configuration

Without an explicitly selected profile, configuration precedence is:

1. A complete `--api-url` plus `--token` pair
2. `defaultProfile`, when configured
3. A complete `CONTINUUM_API_URL` plus `CONTINUUM_TOKEN` pair

Host and token values are atomic credential boundaries. The CLI never combines
a flag with an environment value. Supplying either credential flag requires
the other, and supplying either generic environment variable requires the
other. A complete flag pair overrides `defaultProfile`; explicit `--profile`
cannot be combined with either credential flag. The default timeout is 10
seconds and `--timeout` may override it independently.

The default config file is `~/.continuum/config.json`; override it with
`--config`. Profiles may store an API URL and the **name** of an environment
variable containing the token. Token values are rejected in the file. A profile
must define both `apiUrl` and `tokenEnv`; selecting it (with `--profile` or
`defaultProfile`) treats those values as one credential boundary. It cannot be
combined with `--api-url` or `--token`, and never falls back to
`CONTINUUM_API_URL` or `CONTINUUM_TOKEN` when either profile value is missing.

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {
      "apiUrl": "http://127.0.0.1:4000",
      "tokenEnv": "CONTINUUM_LOCAL_TOKEN"
    }
  }
}
```

Bearer tokens are opaque. The CLI does not decode them or include them in
errors. ASCII control characters are rejected. API URLs must not contain a
query or fragment and must use HTTPS, except for loopback development hosts.
Avoid `--token` in shared shell history; environment variables are the
recommended path.

## Commands

```text
continuum capture --scope project:booking-engine --type fact --title "Retry limit" --body "Three attempts"
cat notes.md | continuum capture --scope user:me --type context --title "Session notes"
continuum recall "checkout retry policy" --scopes project:booking-engine,org --types decision,playbook
continuum audit --since 24h --action read --limit 100
continuum scopes list
continuum verify <memory-uuid> --still-true --note "Confirmed in production"
continuum verify <memory-uuid> --no-longer-true
continuum promote <memory-uuid> --to team:payments
continuum agents-md --project booking-engine --team payments > AGENTS.md
```

`capture` accepts `--body` or `--body-file`; when neither is supplied it reads
non-TTY standard input. This lets scripts use explicit body options even when
their stdin is redirected. Files, stdin, requests, responses, and timeouts are
bounded. API errors include a safe request ID when the server provides one.
`audit --since 24h` is converted to a UTC RFC 3339 timestamp; explicit
timestamps must include `Z` or an offset.

All commands accept `--json`. On success, JSON mode writes exactly one JSON
document to stdout. On failure, stdout is empty and stderr contains one document
with the shape `{ "error": { "message": string, "exitCode": number } }`.
Human output is deterministic and strips terminal control characters, including
from rendered `agents-md` content, while preserving its line structure.
Diagnostics go to stderr.

## Installed-package migrations

The npm package includes every SQL migration and exposes an installed migration
entrypoint. Run it with the migration/schema owner's connection, not the
dedicated operator or shared application connection:

```sh
CONTINUUM_DATABASE_URL="$CONTINUUM_MIGRATION_OWNER_URL" continuum-migrate
```

The migrator takes a PostgreSQL advisory lock, applies pending packaged
migrations in filename order, and exits nonzero on failure.
`CONTINUUM_MIGRATION_OWNER_URL` is a private convenience variable; the executable
reads `CONTINUUM_DATABASE_URL`. For a non-public tenant, that connection must
select the reviewed owner-controlled application schema first in its
`search_path`. See [offboarding rollout](./offboarding.md) for exact role and
provider prerequisites.

Apply every packaged migration, including the current 0080 provider and 0081
contract repairs; complete the owner-only backfill before regranting profiles,
verifying identities, and starting current binaries. Rerunning the same command
resumes pending 0081 work even when its SQL filename is ledgered. A migration
ledger entry alone does not prove backfill completion. Runtime and dedicated
operator roles cannot substitute for the owner-only repair or provenance
inspection. Keep admin commands on their operator connection after this step.
REST and MCP startup verify the trusted 0081 readiness capability after the
provider profile check and refuse startup if it is absent or repair is pending.
The standalone provider verifier and identity sync retain their separate
provider checks. `/health/ready` checks database connectivity and runtime
shutdown state. It does not rerun contract verification or replace owner
migration and backfill verification.

## Exit codes

These codes belong to the regular HTTP `continuum` client. The separate
`npm run admin` execution/progress statuses are documented above.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Usage, input, configuration, or other client error |
| `3` | Authentication or authorization failure |
| `4` | Not found or conflict |
| `5` | Network, timeout, dependency, or server failure |

The v0 REST API and CLI expose scope membership as read-only data. They do not
grant, revoke, or alter memberships, including org-admin roles and private user
scopes. Use the checked operator workflow in
[scope-provisioning.md](./scope-provisioning.md) for controlled membership and
scope changes.
