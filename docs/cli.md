# Continuum CLI

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
entrypoint. Set `CONTINUUM_DATABASE_URL` for the target PostgreSQL database,
then run:

```text
continuum-migrate
```

The migrator takes a PostgreSQL advisory lock, applies pending packaged
migrations in filename order, and exits nonzero on failure. Run it as a trusted
operator before starting a newly installed application version.

## Exit codes

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
