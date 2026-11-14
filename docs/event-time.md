# Explicit event time

Event time describes an asserted event, separately from ingestion (`createdAt`),
verification and fixed lifecycle expiry. It can be past or future. It never
extends retention or establishes factual authority. Standup timestamp rules are
independent. No prose parser, model, historical rewrite or scheduler is required.

REST capture and supersession accept optional `eventAnnotation`. MCP uses
`event_annotation`. Structured manual annotations have `status: known | unknown |
ambiguous`. Known values require `assertion: asserted | mentioned` and precision
`instant | day | month | year | range`. An instant uses an offset-aware RFC 3339
`instant`; a range uses `start` and/or `end`, with exclusive end. Partial periods
use `value` (YYYY-MM-DD, YYYY-MM or YYYY) and an explicit numeric `timezone`
offset or `Z`. Comparison bounds are UTC; original notation and timezone remain
bounded reference data. Ambiguous annotations hold at most eight candidates,
each with `notation` and optional `timezone`. Original notation is at most 1024
UTF-8 bytes; candidate notation at most 256. Invalid calendars, missing timezone,
empty/reversed intervals, unsupported keys and excess candidates are rejected.

Recall accepts `eventFilter` and `eventWindow` (MCP `event_filter`,
`event_window`). Each takes offset-aware `from` and/or `to`, or exclusive `at`.
At least one bound is required. `includeUnknown` defaults false (MCP
`include_unknown`). Hard filters use half-open overlap before every candidate
limit and repeat during hydration and current delivery. An instant matches when
`from <= instant < to`; `at` selects that instant or a containing interval.
Historical unannotated, unknown, ambiguous and mention-only values qualify only
with explicit `includeUnknown: true` and remain visibly labelled.

The window is a hint. It excludes nothing, and orders by core relevance first,
known asserted overlap second, then stable ID. It introduces no recency weighting.
Filters and hints can combine; filtering precedes the single hint ordering.
`eventFilter.at` searches currently readable, eligible evidence. It does not
reconstruct past knowledge or revive expired, erased, archived or superseded rows.

Annotations are immutable evidence-backed versions bound to an exact source
version and its current authority, original expiry and canonical erasure lineage.
They are separate from caller metadata, source prose and generated AGENTS.md.
Changing annotations alone cannot change generator bytes, ETag or freshness.
Extraction candidates remain generated/unverified, outside normalized event time.
