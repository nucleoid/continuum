# Knowledge-gap insights

Continuum can derive a bounded report from recall request summaries that had
zero results. The report is intended to answer what the organization should
write down next. Queries can contain secrets or personal information, so this
surface is restricted to explicit org administrators and REST responses use
`Cache-Control: private, no-store`.

## REST

```text
GET /api/v0/insights/gaps?since=30d&limit=20&minFrequency=1&threshold=0.85
```

REST returns JSON only. `since` defaults to `30d` and cannot exceed `365d`.
The result includes every effective parameter, whether semantic clustering was
available, whether a bound truncated the report, and a prefilled `CaptureInput`
for each gap. It never returns principal identities. There is no web link
because capture is an authenticated API operation and Continuum has no web UI.

`continuum.gaps` exposes the same operation through MCP and renders deterministic
Markdown. Every query-derived value (representative, variants, and capture input)
is escaped with the AGENTS.md data escaper and enclosed in explicit
`CONTINUUM GAP CAPTURE DATA` boundaries, with each line prefixed `DATA:`. This
neutralizes Markdown, HTML, fences, control/format characters, invisible Unicode,
and instruction-like text as contributed data rather than report structure.
Continuum does not schedule a weekly digest or post
reports to a channel. An external scheduler may call the REST endpoint or MCP
tool.

## Selection and ranking

Only request-level `read` audit summaries with a non-null query and a numeric
`metadata.hits` value of zero are eligible. Result-detail rows and insight
audits are excluded. Queries are Unicode-normalized, whitespace-collapsed, and
case-folded for exact grouping. Blank and oversized queries are excluded.

Exact groups are aggregated in PostgreSQL and capped before one batch embedding
request. Scope fidelity is reduced in SQL to one canonical exact set or `unknown`,
so repeated scope metadata is not copied into an unbounded aggregate. Semantic
groups use deterministic cosine-threshold clustering with precomputed vector
norms. The report aborts semantic embedding after
`CONTINUUM_GAPS_EMBED_TIMEOUT_MS`; Ollama requests receive that abort signal. If the
provider is absent, times out, fails, or returns invalid vectors, Continuum safely returns
exact groups with `semanticClustering: false`. Provider errors are not returned
or logged with query text. Ranking is `frequency * distinctPrincipals`, followed
by most-recent observation and a stable representative tie-break.

Resolution is derived from current live memory, not stored as durable insight
state. Recall summaries written by current Continuum include original scope IDs,
which permits `scopeFidelity: exact`. Older rows without those IDs remain
`unknown` and remain unresolved because no safe current scope filter can be
reconstructed. An exact empty scope set means the original search covered no
scopes and also remains unresolved; it never becomes an unfiltered organization
search.

## Bounds and configuration

All values are validated at startup. Query values remain capped by these
settings and fixed API limits. Selection first scans only the newest
`CONTINUUM_GAPS_SCAN_LIMIT` audit rows in the requested time window, then filters
those rows for eligible zero-hit recall summaries. Non-recall and non-zero-hit
rows therefore consume the scan budget; older eligible rows are intentionally not
examined once the budget is full. The report
sets `truncated: true` when that scan bound, the candidate bound, or the result
limit omits otherwise eligible data.

| Variable | Default | Allowed |
| --- | ---: | ---: |
| `CONTINUUM_GAPS_SIMILARITY_THRESHOLD` | `0.85` | strict decimal `0` to `1` (for example `0.85`; no whitespace, signs, or exponent notation) |
| `CONTINUUM_GAPS_CANDIDATE_LIMIT` | `500` | `1` to `500` |
| `CONTINUUM_GAPS_SCAN_LIMIT` | `5000` | candidate limit to `50000` |
| `CONTINUUM_GAPS_MAX_QUERY_CHARS` | `2000` | `1` to `10000` |
| `CONTINUUM_GAPS_DEFAULT_RESULTS` | `20` | `1` to max results |
| `CONTINUUM_GAPS_MAX_RESULTS` | `100` | `1` to `100` |
| `CONTINUUM_GAPS_MIN_FREQUENCY` | `1` | `1` to candidate limit |
| `CONTINUUM_GAPS_EMBED_TIMEOUT_MS` | `2000` | `1` to `30000` milliseconds |

Each successful report records one `read` audit with
`metadata.view: "insights-gaps"` and no query. Resolution probes do not create
additional audit rows, so the report cannot recursively create another gap.
