# Continuum CLI

The `continuum` command uses the authenticated HTTP API. It never connects to
PostgreSQL directly. Install the package, then run `continuum --help`.

## Configuration

Configuration precedence is:

1. `--api-url`, `--token`, `--profile`, and `--timeout` flags
2. The selected named profile in the config file
3. `CONTINUUM_API_URL` and `CONTINUUM_TOKEN`
4. `http://127.0.0.1:4000` and a 10 second timeout

The default config file is `~/.continuum/config.json`; override it with
`--config`. Profiles may store an API URL and the **name** of an environment
variable containing the token. Token values are rejected in the file.
A selected profile that names `tokenEnv` fails closed when that variable is
unset; it never falls back to `CONTINUUM_TOKEN` for a different API host.

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
errors. Avoid `--token` in shared shell history; environment variables are the
recommended path.

## Commands

```text
continuum capture --scope project:booking-engine --type fact --title "Retry limit" --body "Three attempts"
cat notes.md | continuum capture --scope user:me --type context --title "Session notes"
continuum recall "checkout retry policy" --scopes project:booking-engine,org --types decision,playbook
continuum audit --since 24h --action read --limit 100
continuum scopes list
continuum scopes grant <principal-uuid> project:booking-engine writer
continuum scopes revoke <principal-uuid> project:booking-engine
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

All commands accept `--json`. JSON mode writes exactly one JSON document to
stdout. Human output is deterministic and strips terminal control characters.
Diagnostics go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `2` | Usage, input, configuration, or other client error |
| `3` | Authentication or authorization failure |
| `4` | Not found or conflict |
| `5` | Network, timeout, dependency, or server failure |

The API remains the authority for ACL decisions. Scope membership changes
require an org administrator. The CLI does not expose scope creation; use the
checked operator workflow in [scope-provisioning.md](./scope-provisioning.md).
