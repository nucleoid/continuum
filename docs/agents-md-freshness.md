# AGENTS.md freshness

Continuum gives authenticated clients a cache validator and a boolean drift
check for each caller-specific AGENTS.md bundle. Continuum does not update a
repository, store repository credentials, or create pull requests. A CI job or
other authenticated consumer may use these read-only contracts and decide how
to update its own repository.

## Render and ETag

```http
GET /api/v0/agents-md?project=booking-engine&team=payments&limit=20
Authorization: Bearer <principal external id>
```

The response body and selection rules are unchanged. The `ETag` is the
lowercase SHA-256 digest of the exact UTF-8 response body, quoted as an HTTP
entity tag:

```http
ETag: "c6811949431fe8afcb3da4ba7ef725a512d2fbbd82d5d9a9e28824c7771afbec"
Cache-Control: private, no-cache
Vary: Authorization
```

The hash covers the rendered bytes, not database timestamps or an inferred
memory manifest. It therefore changes whenever the delivered document changes
and stays stable when the exact document stays stable. The hash is not embedded
in the document because that would make the digest self-referential and would
change the existing response body.

Send the returned tag in `If-None-Match` on a later request. Continuum uses the
weak comparison required for GET, so the strong tag, `W/` form, a matching tag
in a comma-separated list, and a standalone `*` all produce `304 Not Modified`.
Invalid or non-matching validators are ignored and produce the normal `200` body. A 304
has no body and is audited as a summary-only read with no delivered memory IDs.

## Boolean drift check

Use the unquoted 64-character lowercase digest from the ETag:

```http
GET /api/v0/agents-md/freshness?project=booking-engine&team=payments&limit=20&hash=c6811949431fe8afcb3da4ba7ef725a512d2fbbd82d5d9a9e28824c7771afbec
Authorization: Bearer <principal external id>
```

The response is deliberately minimal and does not disclose historical changes:

```json
{ "fresh": true }
```

`fresh` is true only when `hash` equals the current exact rendered-content
hash for the authenticated principal and the same `project`, `team`, and
`limit` selection. Project and team names are limited to 500 characters, limit
remains 1 through 200, and malformed hashes return `INVALID_INPUT`. The
response uses `Cache-Control: private, no-store` and is audited without memory
result rows. Memories outside the caller's readable scopes cannot affect the
caller's hash or freshness result.

MCP exposes the same check as `continuum.agents_md_fresh` with `hash` and the
same optional `project`, `team`, and `limit` arguments. It returns the same
`{ "fresh": boolean }` value. Obtain the hash by calculating SHA-256 over the
exact UTF-8 text returned by `continuum.agents_md`.

This contract does not provide changed-scope counts, historical manifests, or
repository automation. Those concerns remain outside this API.
