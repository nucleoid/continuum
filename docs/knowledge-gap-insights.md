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
Markdown. Continuum does not schedule a weekly digest or post reports to a
channel. An external scheduler may call the REST endpoint or MCP tool.

## Selection and ranking

Only request-level `read` audit summaries with a non-null query and a numeric
`metadata.hits` value of zero are eligible. Result-detail rows and insight
audits are excluded. Queries are Unicode-normalized, whitespace-collapsed, and
case-folded for exact grouping. Blank and oversized queries are excluded.

Exact groups are aggregated in PostgreSQL and capped before one batch embedding
request. Semantic groups use deterministic cosine-threshold clustering. If the
provider is absent, fails, or returns invalid vectors, Continuum safely returns
exact groups with `semanticClustering: false`. Provider errors are not returned
or logged with query text. Ranking is `frequency * distinctPrincipals`, followed
by most-recent observation and a stable representative tie-break.

Resolution is derived from current live memory, not stored as durable insight
state. Recall summaries written by current Continuum include original scope IDs,
which permits `scopeFidelity: exact`. Older rows without those IDs remain
`unknown`; the report does not claim that a current organization-wide match is
historically equivalent to the original search.

## Bounds and configuration

All values are validated at startup. Query values remain capped by these
settings and fixed API limits.

| Variable | Default | Allowed |
| --- | ---: | ---: |
| `CONTINUUM_GAPS_SIMILARITY_THRESHOLD` | `0.85` | `0` to `1` |
| `CONTINUUM_GAPS_CANDIDATE_LIMIT` | `500` | `1` to `2000` |
| `CONTINUUM_GAPS_SCAN_LIMIT` | `5000` | candidate limit to `50000` |
| `CONTINUUM_GAPS_MAX_QUERY_CHARS` | `2000` | `1` to `10000` |
| `CONTINUUM_GAPS_DEFAULT_RESULTS` | `20` | `1` to max results |
| `CONTINUUM_GAPS_MAX_RESULTS` | `100` | `1` to `100` |
| `CONTINUUM_GAPS_MIN_FREQUENCY` | `1` | `1` to candidate limit |

Each successful report records one `read` audit with
`metadata.view: "insights-gaps"` and no query. Resolution probes do not create
additional audit rows, so the report cannot recursively create another gap.
