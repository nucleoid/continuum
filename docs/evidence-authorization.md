# Evidence authorization and pipeline threat model

## Implemented foundation

`src/evidence/policy.ts` defines `evidence-authorization-v1`: pure, typed
intersection decisions and bounded reason codes. The internal
`decideEvidenceForPrincipal` adapter in `src/services/access.ts` resolves an
enabled principal and readable scopes through existing identity/membership
primitives, then samples the PostgreSQL clock. It snapshots its trusted policy
input before awaiting. Caller-supplied `continuum`, tags, flags, display names,
UUIDs and saved allow decisions cannot replace that resolution.

This adapter performs no content read, provider call, mutation or audit. It is
not a transport endpoint. Policies, full authority-dependency closures, current
versions, external decisions and provider facts must come from trusted service
code, never REST/MCP fields or contributed text. TypeScript types are not a
security boundary against arbitrary in-process code or raw database access.
Database errors propagate; they are never converted into an allow. A service
consumer must map failure to its bounded safe dependency error before delivery.

Existing capture, retrieval, promotion, Standup, coordination and generated
AGENTS.md consumers retain their existing service contracts. They are not
rewired to this new policy vocabulary. No schema, classifier, extraction,
publication/declassification endpoint, connector, persistent cache or pipeline
worker is added. The following requirements are normative obligations for later
consumers, not claims those consumers or revocation fences are implemented.
Version/quarantine persistence belongs to #27 and resource receipts to #28.

## Authority intersection

Authority flows from authenticated principal to current Continuum membership,
then to the requested artifact policy and every transitive authority dependency.
Source-document access is a separate branch. Connector/repository validation and
destination provider/residency policy add restrictions to the appropriate branch.
No branch grants another branch's authority.

| Layer | Required trusted fact | Deny-safe behavior |
| --- | --- | --- |
| Identity | Current enabled immutable principal | Unknown/disabled principal denies all decisions |
| Continuum | Current effective scope membership, including Entra freshness; enabled org read remains implicit | Missing required scope denies, even with repository permission |
| Artifact | Nonempty current policy version matching its resolved authority-root version, active state, fixed unexpired ceiling, nonempty scope requirements | Missing/stale policy, quarantine, erasure or expiry denies |
| Dependencies | Complete transitive closure of all source restrictions | Null/unknown closure denies; ordinary derivatives also deny empty closure; multiple parents intersect, never union |
| Connector/repository | Independent current allow, checked time and exclusive validity deadline, or trusted explicit `not-required` where inapplicable | Deny, unknown, future checked time, timeout, expiry or unsupported current validation capability denies content disclosure |
| Provider | Explicit local/hosted destination, current disclosure allow and inherited residency restrictions | Unknown destination denies; any local-only parent forbids hosted fallback |

Source policies can have an explicit empty dependency list. Connector evidence
and receipts can be original artifacts too; trusted adapters must independently
validate their connector authority. Every dependency carries its current version,
scope, lifecycle, expiry, external restrictions and residency. Duplicate parents
cannot loosen an intersection. An inference resembling public knowledge retains
every restriction of the evidence used to produce it. No `public`, confidence,
tag, source-prefix or caller-declassification flag removes a dependency.

`artifactRead`, `sourceDocumentRead` and `providerDisclosure` are independent
outcomes. Provider disclosure selects either artifact or source-document input
explicitly and requires that selected branch plus destination authority. An
allow for one input must not authorize a prompt containing both. A mixed prompt
must separately authorize every constituent before dispatch.

An ordinary assertion inherits its sources. A future separately reviewed
publication operation could create an explicitly authorized publication artifact
whose assertion is visible while its document remains private. That hypothetical
artifact is not creatable by this release and ordinary promotion does not become
a universal declassification mechanism. Even in that future case, document text,
snippets, title, locator, inaccessible citation targets, hashes, diagnostic detail
and hidden counts remain denied. Use safe opaque citation references only where
their visibility is independently permitted; fetch must authorize again.

## Stage and artifact matrix

Every cell below inherits the authority intersection above, current expiry and
quarantine checks, and the stage's audit boundary. `R` means independently gated
artifact read, `D` separately gated document read, `P` gated disclosure of every
input, and `W` a separately authorized transactional mutation. `W` is unsupported
by the new read-only adapter: `apply-publish`, `quarantine` and `erasure` return
`unsupported-action`. They must use existing authorized workflows or future
reviewed capabilities. No read result grants write authority.

| Artifact | Metadata admission | Text hydration | Provider disclosure | Generation | Apply/publish | Read/history/export | Quarantine | Erasure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Source document/version | R | D | D + P | D + P | W | D | W | W |
| Extracted assertion | R | R; D for source text | R + P; D for source text | R + P | W | R; D for source text | W | W |
| Derived observation | R, all parents | R, all parents | R + P, all parents | R + P, all parents | W | R, all parents | W | W |
| Brief section/version | R, all constituents | R, all constituents | R + P, all constituents | R + P, all constituents | W | R, all constituents | W | W |
| Connector evidence | R + connector/repository | R + connector/repository | R + P + connector/repository | R + P + connector/repository | W | R + connector/repository | W | W |
| Connector receipt | R, safe fields only | R; no implicit source text | R + P, safe fields only | R + P | W | R, safe fields only | W | W |
| History | R, current roots | R; D for source text | R + P | R + P | W | R, current roots | W | W |
| Cache | R, current roots | R; D for source text | R + P | R + P | W | R, current roots | W | W |
| Trace | R, current roots | R; D for source text | R + P | R + P | W | R, current roots | W | W |
| Managed export | R, current roots | R; D for source text | R + P | R + P | W | R, current roots | W | W |
| Queued payload | R, current operation | R; D for source text | R + P, current operation | R + P | W | R, current roots | W | W |

Metadata admission occurs before candidate hydration: denied evidence must not
affect another reader's counts, cache identity, alternative ranking or resource
diagnostics. There is no metadata side channel exempt from the gate. A denied
optional stage may return independently authorized base results only; otherwise
abstain with a bounded safe reason. Never include hidden evidence to explain denial.

Before each provider dispatch, recheck all inputs, including expanded sources,
retries, alternate providers, fallbacks, refreshes and cache reuse. Generation
does not authorize apply. Recheck current authority, versions and lifecycle before
transactional apply and again before final read delivery. History/cache/trace/
export storage cannot preserve an old grant. Queued durable authority is scoped
to its already-authorized source operation, not reusable caller/cross-scope access.

Required service read audits remain delivery-success boundaries; write audits
commit with their mutation. Metadata-only/freshness reads use their documented
summary-only audits. No generic pipeline audit is implemented here; future stages
must define one before enabling their consumers. Existing raw-storage exports
can have narrower guarantees than authenticated services.

## Freshness, races and revocation

The pure decision requires operation-local Continuum facts at the supplied
database time. It does not authorize replaying a saved context later. External
allows require `checkedAt <= now < validUntil`; no supported freshness capability
means unknown. The adapter resolves current database identity/memberships on each
invocation; sessions and provenance snapshots are not permission caches. Entra
staleness denies sourced memberships while manual break-glass authority retains
its documented semantics. Reactivation does not resurrect revoked keys or grants.

The adapter uses existing queries, which can span statements. It does not create
a new atomic revocation fence or acquire dispatch locks. Its supported connection
mode is fresh autocommit READ COMMITTED. It denies borrowed transactions and
other isolation modes with `authority-stale`, without committing or rolling back
the caller's transaction. This prevents old snapshots/transaction timestamps from
being relabeled as current membership or Entra freshness. Later dispatch/apply
consumers must linearize admission against their authoritative revocation fence:
no newly admitted authorization can succeed after that fence commits. An
operation admitted before the fence may remain in flight or physically send
bytes afterward. A database permit is not an atomic physical network cutoff.
Recheck as close to dispatch as supported. Strict cutoff requires producer/worker
quiescence and verified settlement or process exit, including abort-ignoring code.
Source-version races must reject stale versions, not reinterpret old evidence.

Managed copies remain gated. Already downloaded copies, client memory and
retained backups require separate erasure/retention policy; remote retraction is
not promised. Existing lifecycle, fixed expiry ceilings, canonical promotion and
supersession, operator binding and physical erasure proofs remain authoritative.

## Threats and safe output

| Threat | Required control |
| --- | --- |
| Hostile body, title, metadata, citation or connector output | Treat all as reference data inside explicit provenance boundaries; text cannot select tools, credentials, policy or identity |
| Citation laundering or hidden source access | Separate assertion and document decisions, safe opaque references, independent authorized fetch |
| Confused deputy or forged admin UUID | Keep owner, APP, bound OP, SYNC, source producer and authenticated caller distinct; existing database capability checks remain required |
| Saved policy/cache/history, disabled principal, stale Entra or external ACL | Current per-operation checks; deny unknown authority and recheck before final delivery |
| Cross-residency retry/fallback | Intersect all parent restrictions and reauthorize each destination; no hosted fallback for local-only inputs |
| Partial generation/apply or source-version race | No write from read authority; transactional recheck and required audit, otherwise abstain |
| Repeated evidence/model confidence | Report authorized record count and known source-family duplication separately; unknown family remains unknown, neither is truth probability |
| Reactivation or retained process payload | Restore only explicitly approved authority; apply quiescence and downstream erasure separately |

Receipts must contain operation/stage, reader-permitted opaque artifact/version
references, decision enum, policy version, bounded provider/connector IDs where
permitted, freshness status and aggregate resource outcome. Exclude raw content,
credentials, raw provider errors, denied identifiers, hidden counts and hashes.
The implemented decision returns only policy version and bounded reason enums;
it does not persist receipts or replace required service audits. A reason is not
a diagnostic dump or a claim about independent proof.

Generated AGENTS.md remains deterministic SQL selection of authorized live,
unexpired source memories with escaping/provenance and required read auditing.
Assertions, brief prose, connector payloads, personal activity, coordination,
enrichment and advisory relations are not new generator inputs. Arbitrary metadata
does not enter its bytes or hash. See [freshness](agents-md-freshness.md) and
[authentication](authentication.md). No connector/provider activation, credentials,
role broadening, migration, backfill or operator action is required by this foundation.
