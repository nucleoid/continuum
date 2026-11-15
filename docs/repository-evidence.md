# Optional repository evidence

Continuum exports a source-neutral `RepositoryEvidenceConnector` port, an empty
`RepositoryEvidenceRegistry`, and explicit `queryConnectorEvidence` and
`readConnectorEvidence` library services. No connector is installed by stock
REST, stdio MCP, remote MCP, capture, recall or brief generation. Core has no
Engram dependency, code graph, repository scanner or automatic indexing.
An explicit trusted pipeline consumer may compose this service independently
of ordinary memory retrieval. Connector output is untrusted reference data.

## Authority and composition

The bound OP function `continuum_operator_connector_mapping` approves a stable
repository key, scope UUID, connector ID/version and residency policy. It
requires current manual organization administration and target-scope write
access. Renames do not confer permission. Every configuration change advances
the generation; old receipts and every transitive managed copy fail closed.
APP can read an authorized mapping and invoke bounded query capabilities, but
cannot configure mappings or read raw connector/evidence tables. SYNC and
reporting receive no connector capabilities. These SQL functions are trusted
composition capabilities, not authenticated operator or end-user endpoints.

Continuum membership, a known repository ID, a tool name and a shared service
credential do not prove upstream permission. Before content I/O, the service
requires an independently verified allow for the authenticated principal and
selected stable repository. A connector's transport-owned authorization context
is passed only to `open`; adapter closures retain credentials. Serializers must
exclude that context, tokens and headers. No bearer credential is passed to
models, enrichers, receipts or contributed data. Do not register an adapter that
uses service access as a substitute for delegated repository authority.

The permission adapter is a separately budgeted, content-free probe. Its allow
must have a conservative validity bound of 1 through 5000 milliseconds measured
from PostgreSQL time sampled before the probe. Upstream clock uncertainty must
be accounted for by the transport; unsupported authority is unknown and denies.
Current Continuum scope/privacy, mapping generation, provider locality and
permission expiry are rechecked before content dispatch and after it. A second
independent probe precedes publication. Remote I/O never runs in a database
transaction. Cross-repository expansion is unsupported; a response containing
another repository is rejected in full. Trusted adapters must prevent such
expansion upstream before content I/O, rather than fetch then filter.

## Bounds and accounting

Each request selects one evidence class, at most 20 results and a query of at
most 4096 characters, with an 8192-byte complete domain request ceiling. Adapters
must serialize and send their complete actual wire envelope through the shared
pipeline budget. Response bodies are capped while reading, with a maximum
65536-byte response declaration and separately validated complete result. IDs
are restricted to 128 ASCII identifier characters and citation locators to 512
characters. The receipt is at most 8192 bytes. Whole returned library envelopes
also consume the caller's output budget. An eventual REST or MCP consumer must
explicitly budget its actual camelCase or snake_case serialized frame; no new
wire route or mechanical field-name translation is supplied here.

Durable output accounting includes a conservative final library-envelope
allowance in the original delivery-probe attempt, not just upstream response
bytes. Managed reads reserve their complete JSON string's worst-case escaping
bound before hydration. That allowance is retained even when later publication
fails; retries cannot recover it by constructing a fresh local budget. Tight
caller profiles may therefore abstain although a particular smaller frame
would fit. This is bounded reservation accounting, not measured remote billing.

Only zero-price `local-zero-v1` schedules are admitted. This is a capability for
qualified synthetic/local or independently approved zero-price transports, not
a claim that a hosted service is free. No paid probe or paid content stage is
enabled. Missing enforceable serialization, token, output, price, cancellation
or deadline capabilities make the optional stage unavailable.

The caller supplies a previously created durable workflow and original run,
worker, generation and three distinct attempt UUIDs. SQL persists those
identities before the first probe. The original workflow deadline is also the
immutable receipt/evidence expiry ceiling. Duplicate runs never dispatch again.
Retry/restart cannot replace identities or reset allowance. Read operations
must likewise persist their supplied workflow and per-root permission attempt
identities; they do not create a new query allowance. Multiple roots share the
same caller budget. No queued query body or credentials are persisted.

The shared runner reserves before dispatch and retains admission until actual
settlement, including abort-ignoring calls. Timeout does not release an unknown
reservation, refund spend or establish process exit. `onWork` exposes settlement
promises to a custom bounded shutdown composition. There is no stock query
worker, retry scheduler, orphan reconciliation or cross-principal cache.

## Freshness, receipts and managed copies

Evidence items separate `indexed`, on-demand `vcs` and retained `history` data.
Each has a stable evidence ID, repository key, untrusted text and citation
locator, nullable exact content commit and separate nullable index watermark.
The response's version references must match independently observed authority.
An exact requested commit must be proven. A changed index or commit fences old
output; unknown versions remain unknown. History cannot establish an exact
implemented fact. Truncation remains explicit, including partial authorized
results. Empty results do not prove absence or exact freshness.

Safe outcomes are `complete`, `denied`, `unavailable`, `stale`, `budget` and
`timeout`. Failure responses contain no mapping/repository IDs, query text,
hidden counts, raw errors, private URLs or credentials. Admitted failure runs
persist only an enum summary with their machine accounting identities and an
atomic audit. Successful query receipts and retained evidence are distinct
managed payloads in the 0093 store, with exact typed dependencies and their
required registration/read audits committed atomically. Receipt commit/index
fields identify the independently observed repository snapshot; item fields
identify the returned evidence. `freshness=unknown` never upgrades an item's
unknown commit to an exact claim.

Generic evidence reads deny connector descendants by default. The explicit
reader resolves every connector dependency, repeats its content-free permission
probe, and installs a transaction-bound permit after current SQL access checks.
Another transaction or principal cannot reuse that permit. The same current
gate protects source text, receipt metadata, provider disclosure and dependent
history/cache/export/brief versions. Provider disclosure additionally intersects
all inherited locality policies. Direct arbitrary APP code remains trusted;
TypeScript and SQL capabilities do not sandbox a malicious in-process adapter.

Managed bytes and hashes use canonical evidence erasure, including transitive
copies. Canonical offboarding additionally cancels query workflows, detaches
principal/mapping links and physically clears repository keys in bounded pages.
Completion checks actual residual state, not counters or old receipts. Locks
can leave work incomplete. Direct source erasure retains the evidence poller's
existing bounded cleanup contract. Stored-state proof cannot retract an
in-process, upstream, downloaded or backup copy. Quiesce producers, drain or
prove process exit, and apply downstream/backup policy separately.

Connector receipts and internal retained candidates never enter legacy memories
or generated AGENTS.md. Source selection, ACL, TTL, escaping, provenance, exact
bytes, ETag and freshness audits retain their existing independent contracts.

## Engram capability gate

`engramCapabilityReport.enabled` is false and its factory cannot construct a
live connector. Only available tool descriptions were inspected. They describe
repository-scoped indexed search, on-demand VCS symbol source, missing IDs and
retained file history. They do not document the required versioned server
transport, credential delivery, independently delegated principal/repository
proof and revalidation, stable approved identity, exact content commit versus
index watermark, enforceable full-wire/token/price bounds or cancellation.
No real response fixture was captured. Synthetic tests qualify this neutral
boundary only. They do not establish an Engram integration or real model quality,
latency, billing or storage performance.

Before a separate live enablement, operators must document and inspect those
contracts, freeze actual authorized response fixtures, and qualify the narrow
read allowlist. No guessed HTTP route or authentication proof is implemented.
Corpus/group search, cross-repository contract expansion, repository linking,
grants, credential acquisition, mutations, indexing and cache invalidation are
not enabled. Unknown capability leaves unrelated memory workflows available.

## Upgrade and rollback

Apply the chain through `0096_repository_evidence.sql`, requiring ledgered 0095,
as migration owner with database TEMPORARY privilege. All published migration
bytes remain unchanged; 0091 is not required. Quiesce affected readers, artifact
writers and offboarding processes, back up data and ledgers, migrate under a
finite outer deadline, then explicitly regrant exact APP/OP profiles and verify
`continuum_connector_is_ready()`. Current stock runtimes require that hardened
owner-recorded gate. The migration creates empty tables and forward wrappers
without a historical scan; five-second lock and 60-second statement budgets do
not bound the whole maintenance or advisory-lock duration.

No reauthentication, upstream credential, repository grant, reindex or backfill
is required for the empty default. Custom enablement requires separately reviewed
private configuration. Do not mix old artifact/offboarding binaries with enabled
connector data. Rollback disables admission, fences workflows and drains or
verifies exit while retaining ambiguous original reservations. Binary rollback
cannot restore erased bytes. Schema reversal requires a verified backup and
reviewed replay, never ledger deletion. No deployment is implied.
