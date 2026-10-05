# Memory fetch and browse API

Recall is a discovery surface and returns excerpts. Use point fetch or browse to
read complete stored records. Both surfaces enforce the caller's readable scope
set, including implicit org access, and audit successful reads without copying
memory bodies, metadata, tags, source references, or principal external IDs
into audit metadata.

## REST

`GET /api/v0/memories/:id` returns one complete record. A valid UUID that is
missing, expired, or in an inaccessible scope returns the same
`MEMORY_NOT_FOUND` 404 response. A malformed UUID returns `INVALID_INPUT` 400.
The point read is atomic with its audit summary and content-free memory identity
row: an audit failure prevents a 200 response.

`GET /api/v0/memories` browses complete records. It accepts one optional
`scope`, `type`, and `state` filter plus `limit` and `offset`. Defaults are
`state=live`, `limit=50`, and `offset=0`; `limit` is bounded from 1 through 100
and `offset` from 0 through 10000. A malformed scope returns `INVALID_SCOPE`.
A well-formed unknown or inaccessible scope returns an empty list.

Results use stable `updatedAt DESC, id DESC` ordering. Offset pages can shift
when concurrent writes change that ordering. Expired memories are excluded,
using the database transaction time and the same strict `expires_at > now()`
boundary as recall, before ordering and pagination are applied.

Browse atomically writes one bounded read-audit summary and one content-free
identity row for every returned memory. Identity rows contain only the memory
and scope IDs, result rank, transport, request correlation ID, and record kind;
they never copy record content. A zero-hit browse still writes its summary, and
an audit failure prevents the result page from being returned.

REST records use camelCase:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "scope": "project:booking-engine",
  "type": "decision",
  "title": "Checkout retry policy",
  "body": "Complete stored body",
  "metadata": {},
  "tags": ["checkout"],
  "state": "live",
  "expiresAt": null,
  "supersedesId": null,
  "promotedToId": null,
  "authorId": "00000000-0000-4000-8000-000000000001",
  "authorDisplayName": "Example Author",
  "source": "manual",
  "sourceRef": null,
  "createdAt": "2026-10-04T00:00:00.000Z",
  "updatedAt": "2026-10-04T00:00:00.000Z",
  "lastVerified": null
}
```

Browse wraps records as `{ "items": [...], "limit": 50, "offset": 0 }`.

## MCP

- `continuum.get_memory` accepts `memory_id` and has the same masking and
  atomic audit behavior as REST point fetch.
- `continuum.list_memories` accepts `scope`, `type`, `state`, `limit`, and
  `offset` and has the same defaults, validation, ACL, and ordering behavior as
  REST browse.

MCP uses the same record fields in snake_case, including `expires_at`,
`supersedes_id`, `promoted_to_id`, `author_id`, `author_display_name`,
`source_ref`, `created_at`, `updated_at`, and `last_verified`.

Recall results now include `bodyTruncated` in REST and `body_truncated` in MCP.
The flag is true exactly when the source body is longer than 200 UTF-16 code
units. It is derived from the source body, not from excerpt punctuation.
