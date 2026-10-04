# Audit query API

`GET /api/v0/audit` returns audit entries visible to the authenticated principal. An org administrator can query any principal. Other principals are restricted to their own entries.

## Time filters

- `since` is inclusive and `until` is exclusive.
- Both values must be RFC 3339 timestamps with an explicit timezone: either `Z` or a numeric offset such as `+12:00` or `-05:30`.
- Offset-less timestamps and malformed timestamps return HTTP 400.
- When both filters are supplied, `since` must be earlier than `until`. Equal or inverted ranges return HTTP 400.
- Offsets are normalized to their UTC instants before the database comparison. The original request strings are retained in the query's meta-audit entry.
- A literal `+` in a URL query value must be percent-encoded as `%2B`. URL client libraries normally do this automatically.

Example:

```text
GET /api/v0/audit?since=2026-01-01T12%3A30%3A00%2B12%3A00&until=2026-01-01T01%3A00%3A00Z
```

The `limit` and `offset` query parameters continue to control pagination when time filters are present.

## Scope-provisioning writes

Successful `continuum.ensure_scope` calls use the existing `write` action with
`memory_id: null` and `metadata.operation: "create_scope"`. Metadata also
contains `created`, `kind`, `name`, and `transport`. This includes authorized
idempotent calls where the scope already exists (`created: false`). Audit and
SIEM consumers that report memory writes should exclude rows whose
`metadata.operation` is `create_scope`; scope-provisioning reports should select
that operation explicitly.
