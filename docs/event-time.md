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
use `value` (YYYY-MM-DD, YYYY-MM or YYYY) and an explicit `timezone`:
numeric offset, `Z` or an IANA zone. Day boundaries account for DST. Unresolvable
or ambiguous midnight is rejected. Comparison bounds are UTC; original notation and timezone remain
bounded reference data. Ambiguous annotations hold at most eight candidates,
each with `notation` and optional `timezone`. Original notation is at most 1024
UTF-8 bytes; candidate notation at most 256. Invalid calendars, missing timezone,
empty/reversed intervals, unsupported keys and excess candidates are rejected.
Timestamps use years 0001 through 9999 and at most three fractional-second
digits. Normalization retains millisecond precision rather than silently rounding.

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
Bounded overlap metadata selects the final candidate cut before source bodies
are hydrated. Ordinary recall without temporal options performs no annotation
hydration; fetch/browse inspection remains available separately.
Filters and hints can combine; filtering precedes the single hint ordering.
`eventFilter.at` searches currently readable, eligible evidence. It does not
reconstruct past knowledge or revive expired, erased, archived or superseded rows.

Annotations are immutable evidence-backed versions bound to an exact source
version and its current authority, original expiry and canonical erasure lineage.
They are separate from caller metadata, source prose and generated AGENTS.md.
Changing annotations alone cannot change generator bytes, ETag or freshness.
Extraction candidates remain generated/unverified, outside normalized event time.
When a source transition invalidates an annotation, the currently readable source
projects unknown without exposing the old annotation or its version. It remains
eligible for hints and explicit include-unknown filters. There is no silent
carry-forward to a new source version or renewed expiry ceiling.

Temporal recall returns normalized status, precision/assertion and UTC bounds when known,
plus authorized version provenance. Original notation and ambiguity candidate
prose are excluded from discovery summaries. Full current inspection through
memory fetch/browse retains those bounded fields under the same evidence gate.

## Installation and recovery

Apply additive migration 0095 after 0094 as migration owner with database
TEMPORARY privilege. Published files through 0094 remain unchanged; 0091 is not a
prerequisite. Empty annotation tables need no historical scan, backfill or vector
reindex. Regrant exact APP and OP profiles; SYNC/reporting gain no annotation or
payload access. Raw annotation tables are owner-only. New serving, remote MCP
and producer pools require the owner-recorded event readiness contract. Missing
functions, altered bodies or disabled immutable guards fail startup closed.

Quiesce readers, writers and offboarding processes, back up data and ledgers,
apply the complete chain and exact profiles, then restart compatible binaries.
DDL uses five-second lock waits and 60-second statement bounds; these do not
bound total maintenance time or establish volume qualification. Use a finite
outer deadline and rehearse the actual installation. No new secret, provider
permission, reauthentication, session invalidation or live deployment is implied.
Old writers may omit annotations; historical data remains unknown. Old serving
and offboarding binaries must not run with enabled temporal evidence. Disable
new input/hints and drain readers before recovery. Binary rollback cannot undo
erasure. Schema reversal requires verified backup and reviewed replay or forward
recovery; never delete ledgers or rewrite published migration bytes.

The separate `evals/event-time-v1.json` synthetic baseline exercises ingestion
lag, precision, unknown dates, future events, conflicts, mention-only values and
supersession. Its seeded interleaved baseline/filter/include-unknown/hint modes
reuse the evaluation fixture, scoring and five-observation latency policy.
False exclusion is reported separately from ranking quality; synthesis remains
unsupported. This is mechanism evidence, not real-model, cross-head performance
or normalized-storage qualification. Existing frozen inputs remain unchanged.
Hard predicates currently evaluate the current evidence gate per scanned row.
No tenant-volume qualification is claimed. Large scans can reach the existing
vector deadline and fall back to lexical search; rehearse actual tenant volumes
before making latency or vector-availability guarantees.
