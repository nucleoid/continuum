# Continuum architecture

Continuum is a standalone memory service with explicit identity, scope, lifecycle, and audit boundaries. PostgreSQL holds the authoritative data; pgvector supports optional semantic retrieval. REST, stdio MCP, the HTTP CLI, and the AGENTS.md generator share service and storage code.

## Design and implementation boundaries

1. Keep memory usable without a particular LLM vendor, embedding model, or IDE.
2. Give every memory one scope. Derive access from current identity and membership rather than names or client assertions.
3. Keep capture transforms, embedding providers, and protocol adapters separate from core storage behavior.
4. Couple required service audits to writes and delivered reads. Distinguish trusted low-level exports from authenticated operations.
5. Use explicit lifecycle transitions and fixed expiry timestamps.
6. Preserve coordination as a separate non-memory domain.
7. Build the next required milestone without speculative infrastructure.

The migration chain is the schema authority. [migrations/0001_init.sql](./migrations/0001_init.sql) defines the initial model; later migrations add identity, sourced memberships, erasure, provider profiles, and coordination. Do not recreate the current database from an abbreviated schema example. Every migration already on public master remains immutable, including the original 0052 through 0079 chain and later published files; reviewed forward work carries its own checksums and prerequisites.

## Code organization

| Area | Responsibility |
| --- | --- |
| `src/api` | REST and stdio MCP adapters, authentication, startup, readiness, shutdown |
| `src/services` | Shared validation, authorization, capture, retrieval, lifecycle, and administration |
| `src/storage` | PostgreSQL queries, migrations, vector storage, and execution provenance |
| `src/scopes` | Scope syntax and effective access rules |
| `src/identity` | Entra Graph sync and database administration entrypoints |
| `src/capture` | Capture transform interface, registry, and built-in plugins |
| `src/ingest` | Source configuration and webhook authentication |
| `src/embeddings` | Provider interface, adapters, routing, deadlines |
| `src/agents-md` | Deterministic contributed-data rendering |
| `src/audit`, `src/maintenance` | Audit records, queries, and retention |
| `src/lifecycle`, `src/insights` | Sweeping and knowledge-gap analysis |
| `src/coordination` | Wire-neutral lease model |
| `src/standup` | Authenticated activity proof and deterministic personal digest rendering |
| `src/extensions`, `src/workers` | Retrieval enrichment, promotion callbacks, and leased outbox consumers |
| `src/cli` | Authenticated HTTP command client |

[src/index.ts](./src/index.ts) defines the public library exports. Some storage exports are deliberately lower-level and do not perform every service authorization or audit step. Consumers must choose the appropriate boundary.

## Identity and database authority

Principals are users or services with immutable internal UUIDs. Membership roles are reader, writer, and admin. Authentication identifies an existing principal; it does not create a personal scope or establish its ownership.

Serving entrypoints require explicit `CONTINUUM_AUTH_MODE`:

- `dev` accepts an existing principal external ID as a bearer credential and is restricted to trusted development use.
- `entra` validates tenant v2 issuer, signature, audience, expiry, allowed client, identity type, and configured scope or application role. The principal must already exist. User authentication also requires active effective membership.

Service API keys use a random `ctm_` credential stored as a SHA-256 hash. Issue and rotation expose the secret once; prefix and last-four values are non-secret diagnostics. Keys may restrict capture source. Disablement revokes current keys and memberships; audited reactivation does not restore them. The reserved lifecycle and detached-coordination principals have separate database guards.

PostgreSQL roles are another authority boundary. Use a migration-owner connection for schema and owner-only repair, a non-owner application connection for serving, and bound operator or sync sessions for privileged workflows. An org-admin UUID passed to a shared database connection does not turn that connection into a migration owner or bound operator. See [authentication](./docs/authentication.md) and [offboarding role rollout](./docs/offboarding.md).

Entra group bindings use immutable external object IDs and explicitly approved scope/role mappings. Sync maintains sourced membership rows, preserving manual grants and history. Group renames do not retarget access. The default staleness bound is 48 hours; expired Entra freshness makes those memberships ineffective. Sync is serialized, bounded, and guarded against unintended mass deactivation. Provider/profile drift can stop sync before Graph reconciliation, so restore the approved profile and verify sync after provider maintenance.

## Scopes and memory storage

| Kind | Meaning |
| --- | --- |
| `org` | Singleton organization scope with an empty name |
| `team` | Shared team knowledge |
| `project` | Per-project knowledge |
| `user` | User-oriented knowledge with explicit memberships |
| `role` | Cross-cutting role knowledge |

An enabled principal reads org implicitly and other scopes through current effective membership. Mutation requires explicit writer or admin membership. Scope creation requires explicit org admin. A user scope's name is routing data, not ownership proof. Erasure uses an approved UUID mapping with bounded reviewed member and author evidence.

Memory rows carry scope, author, type, title, body, metadata, tags, source/reference, state, lifecycle timestamps, and promotion/supersession links. Controlled tags are shared by scope kind within the application schema, not by individual named scope. The initial vector column is fixed at 768 dimensions, with provider identity and dimension recorded alongside each stored embedding. The provider-qualified primary key is `(memory_id, provider, dim)`, permitting multiple provider vectors for one memory.

## Controlled tag vocabularies

`tag_vocabularies` has a `(scope_kind, tag)` primary key, a description of at most 500 characters, creator attribution for custom entries, and a system flag. Each scope kind starts with `ado`, `branch`, `decision`, `deploy`, `github`, `knowledge-gap`, `merged`, `pr`, `session`, and `terminal`.

Capture and supersession normalize tags by trimming and lowercasing, reject duplicates after normalization, and enforce at most 32 tags. Each tag is 1 through 64 lowercase letters or numbers separated by single hyphens. Admission uses the target scope kind's vocabulary before provider work and rechecks it with matching-row locks in the write transaction. Promotion validates the source's active tags against the destination vocabulary. Unknown tags fail atomically with `UNKNOWN_TAGS`/HTTP 422 and sorted unknown values plus at most 100 allowed values. Shared MCP error details retain the service's `scopeKind`, `unknownTags`, and `allowedTags` keys.

REST lists through `GET /api/v0/tag-vocabularies?scopeKind=project`; create, description update, and delete use POST, PATCH, and DELETE on that resource. Any active authenticated principal can list; service mutations require explicit org-admin membership. Successful reads and mutations audit atomically. System entries cannot be deleted. Custom deletion is blocked by use in any memory of the same scope kind, regardless of lifecycle state. No memory-tag edit or automatic restoration endpoint exists. MCP applies admission to capture and supersession but does not register vocabulary-management tools.

Migration 0083 keeps only normalized unique built-ins active on historical memories. Unknown original values stay in ordered `metadata.continuum_legacy_tags`; original arrays and non-object metadata receive protected provenance. Historical collisions are retained separately instead of being trusted as migration output. Capture, ingestion, MCP, and supersession reject the five migration-owned namespaces even on empty-tag requests. Promotion may inherit them only through its existing authorized source relationship, with a reciprocal database constraint; approved erasure clears them through the canonical tombstone path.

The SQL trigger enforces strict vocabulary membership for direct and older writers too. Owner-only compatibility mode can normalize and quarantine bounded legacy writes during an application rollback, preserving exact original values without silently dropping the memory. Malformed or oversized input still fails. The mode changes policy rather than removing definer functions, grants, or provenance checks. Restoring a verified backup is the supported reversal of the migration's data rewrite; adding a vocabulary entry does not reattach quarantined historical tags.

The separate `continuum-tags` executable supports list/add/update/remove, reads `CONTINUUM_BEARER`, defaults its API URL to `http://localhost:4000`, and bounds the whole request/body read to 30 seconds and 1 MiB. It does not inherit the ordinary HTTP client's profile or exit-code table. See [tag vocabularies](./docs/tag-vocabularies.md), [src/services/tag-vocabularies.ts](./src/services/tag-vocabularies.ts), and [migration 0083](./migrations/0083_tag_vocabularies.sql).

## Lifecycle

| Type | Initial expiry | Lifecycle behavior |
| --- | --- | --- |
| `fact` | 90 days | Expired live rows become stale; positive verification renews expiry |
| `relationship` | 180 days | Expired live rows become stale; positive verification renews expiry |
| `context` | 14 days in user scope, 60 elsewhere | Expired live rows archive |
| `decision` | None | Explicit linked supersession |
| `playbook` | None | Review due indication after 180 days |

[src/storage/expiry.ts](./src/storage/expiry.ts) computes fixed timestamps. There is no exponential half-life implementation. The sweeper runs bounded ordered batches with SKIP LOCKED and audit records; operators schedule it. Positive verification sets live and recomputes applicable expiry from database time, while negative verification sets stale without extending expiry. Archived and promoted memories are terminal for verification.

Promotion is an explicit transaction. A destination mapped to a disabled user is unavailable, even if a separately acknowledged shared-scope capture override permits capture. It locks a live, unpromoted source, requires source writer authority and destination writer authority, or admin when the destination is org. It validates destination tags, creates a destination memory, strips advisory relation metadata, inherits permitted tag provenance, records `metadata.promoted_from`, and marks the source promoted with `promoted_to_id`. It does not infer a hierarchy or a separate lead/architect approval taxonomy.

Decision supersession creates a successor linked through `supersedes_id`. Decision history follows authorized links and is audited. These operations do not imply a blanket immutable-content guarantee for every direct database access path. See [lifecycle](./docs/lifecycle.md), [src/storage/promote.ts](./src/storage/promote.ts), and [src/storage/supersede.ts](./src/storage/supersede.ts).

## Capture and ingestion

`CapturePlugin.transform(event, context)` returns capture inputs. The built-ins format supplied GitHub PR/branch, ADO work-item, deploy, and terminal-summary fields. They do not invoke a built-in LLM summarizer or fetch review threads. The default registry and source allowlists are explicit; adding a transform object alone does not make an arbitrary source ID available through every transport.

Manual REST capture accepts a scope object and camelCase fields such as `sourceRef`. MCP capture uses `scope_kind`, `scope_name`, and `source_ref`, with `manual` as its default source. Both delegate to the shared capture service and require current write authority. REST capture returns `scopeId` and `expiresAt`; MCP returns a scope label and `expires_at`.

Webhook ingestion is disabled per source unless configured. GitHub uses signed request bytes and expected event types, ADO uses configured basic credentials, and deploy/terminal sources use authenticated bearer credentials for their configured producer. Delivery identity and payload hashes protect replay; mismatched delivery content fails. Capture author and scope authority come from the authenticated producer and current memberships, not an external display name.

When embedding is configured, capture can probe at most five matching-provider live, unexpired memories in its target scope and org. The default threshold is 0.92. These are advisory possible-duplicate or possible-conflict candidates, not contradiction judgments. `metadata.related` is reserved. Capture never automatically supersedes an existing memory.

Embedding failure can leave valid capture committed with `embedded: false`; relation work failure can leave a valid embedding with an empty candidate list. Required write auditing remains part of success. See [webhook ingestion](./docs/webhook-ingestion.md), [src/services/capture.ts](./src/services/capture.ts), and [src/services/relations.ts](./src/services/relations.ts).

## Retrieval and providers

Recall resolves readable scope UUIDs before candidate selection. English full-text search and optional provider-qualified cosine searches feed reciprocal-rank fusion with K=60. Candidate queries filter live state and expiry before ranking; hydration repeats eligibility checks. The default recall limit is 10, with a maximum of 100. Results carry bounded excerpts and a truncation flag; authorized fetch provides full content.

Browse defaults to live state, 50 results, and a maximum of 100 with offset at most 10,000. Fetch and browse require an enabled caller, effective scope access, and an unexpired row. Fetch does not require live state. See [memory API](./docs/memory-api.md).

`EmbeddingProvider` declares provider identity, dimension, embedding operation, optional cancellation, request deadline, batch size, and explicit locality. Routing uses exact scope, then kind, then default selection. A local-only route cannot fall back to hosted processing. The factory reads `CONTINUUM_EMBEDDING_CONFIG` for multi-provider routing or the single-provider Ollama settings otherwise. Hosted keys come from provider-specific environment variables; inline secrets are rejected. A local non-loopback Ollama endpoint emits a warning. Configuration is not proof of network residency.

Storage remains fixed at 768 dimensions. Compatible Ollama configurations and OpenAI text-embedding-3-small/large are supported; incompatible OpenAI models and current Voyage dimensions are rejected at construction. Provider identity and dimension qualify writes, existence checks, and vector searches. Matching vectors from different providers coexist, and changing a routing rule does not automatically replace historical vectors.

Adapters send arrays in chunks of at most the configured batch size, default 32 and maximum 1000. Ollama uses `/api/embed` and requires a compatible Ollama version. Each HTTP chunk has its own deadline, default 10000 milliseconds, configurable from 1 through 300000. A success must contain exactly one finite vector of the configured dimension per input. Successful HTTP response bodies are bounded by the lesser of 64 MiB and `16 KiB + inputCount * dimension * 32` bytes. Classified error bodies are capped at 8 KiB. Adapters do not promise automatic retries for authentication, rate-limit, timeout, or network failures; backfill's separate bounded diagnostic probing is described below.

Recall computes full-text candidates first. The longest routed provider deadline determines one shared optional-vector budget, capped at 30000 milliseconds. Provider-local limits still apply; remaining SQL budget is recomputed before vector catalog and distance queries. Exact provider/dimension scans may need deployment-specific partitioning or indexes at larger volume; the provider-leading B-tree index is not an ANN redesign. Vector validation, embedding, or vector search failures affect only that group. Required read audits and safe borrowed-transaction cleanup remain success boundaries.

REST recall adds `diagnostics` with `vector: used|disabled|failed|partial` and `groups` containing provider, dim, status, and optional bounded errorCode. MCP keeps its existing result array and adds `_meta.diagnostics`. An unavailable local-only route may add `localOnlyUnavailableScopes`. Audit summaries carry vector status and bounded group information; operational fallback logs use counts without queries, bodies, vectors, or raw errors. Borrowed-client SQL is serialized and preserves the caller's transaction, settings, and locks; provider I/O remains independent.

Provider infrastructure may be separately DBA-owned and shared under reviewed grants. Runtime SQL qualifies the extension vector type and distance operator without adding the provider schema to its path. Vector storage locks and rechecks the parent as live and unexpired at current database time. Archive transitions delete all vectors for that memory; offboarding's physical proof checks derived vectors, not just one provider. See [factory](./src/embeddings/factory.ts), [vector storage](./src/storage/embeddings.ts), and [provider lifecycle](./src/storage/provider-lifecycle.ts).

### Routed embedding backfill

`npm run embed-backfill` uses the same routing configuration and trusted application schema/profile prerequisites. It checks provider profiles and coordination readiness before invoking the scanner. Its database maintenance authority is not the HTTP CLI's bearer/profile configuration. Registered application and operator profiles get the bounded backfill state permissions; sync and reporting profiles do not.

Defaults are batch-size 32 (1..1000), max-rows 1000 (1..1000000), and max-errors 25 (1..10000). Rows are limited per provider pass; these are not a whole-run deadline or a guarantee that every eligible memory is processed. ID pages contain routing metadata and byte counts. One count- and byte-bounded batch then hydrates title/body, with a 4 MiB aggregate budget checked against current sizes. Oversized individual input becomes a durable sanitized failure without loading its body. Count-only and manual failure marking never load memory text.

Checkpoints are keyed by provider, dimension, and scope filter. UUID scans wrap once unless explicit cursor/no-wrap selects only the upper range. Durable deterministic item failures require explicit provider-scoped retry clearing; ambiguous isolated failures are retryable suspects. A cursor never advances beyond an unresolved suspect even when later batches succeed. Manual `--mark-failed` changes disposition without advancing sequential progress and reports incomplete. Success reports include per-provider completion, counters, sanitized error codes, full unresolved counts, and samples of at most 25 UUIDs.

Authentication, rate-limit, network, and timeout failures stop that provider. Ambiguous failures use diagnostic bisection capped at 64 sub-batch requests and stop after more than eight ambiguous probe failures. If all leaves fail, treat it as provider outage rather than suppressing every row. A one-item ambiguous batch cannot distinguish item failure from outage and stops without advancing. Provider-local database/lock failures do not stop later routed providers; any incomplete/error report makes the command exit 1 after its JSON report.

Backfill SQL keeps five-second statement and one-second lock limits while retaining stricter preexisting limits. Prior settings are restored before releasing an owned client; failed restoration discards it. These limits and HTTP chunk deadlines do not bound total run duration. Schedule with a finite outer process deadline and inspect counts before increasing budgets. See [embedding backfill](./docs/embedding-backfill.md) for operational controls and migration recovery.

## Retrieval enrichment and promotion delivery

The exported `RetrievalEnricherRegistry` and `PromotionWebhookRegistry` validate IDs against `^[a-z][a-z0-9.-]{0,63}$`, reject duplicates, and enumerate IDs in sorted order. Callback implementations are registered at the composition boundary, not loaded from memory data or external request fields. See [extensions](./docs/extensions.md).

A retrieval enricher receives an immutable cloned snapshot of already authorized, ranked results, a principal UUID, and an abort signal. It returns a plain JSON object or null per result. Accepted output appears only under `enrichments[enricherId]`; it cannot change core memory fields, scores, excerpts, or ordering. REST and MCP expose the same namespace. The deterministic AGENTS.md renderer does not serialize enrichment output.

The shared enrichment deadline defaults to 250 milliseconds, configurable through `CONTINUUM_ENRICHER_TIMEOUT_MS` from 1 through 5000. Combined serialized output is limited to 16 KiB. Invalid JSON shapes, errors, timeout, or admission saturation omit the affected optional output without failing core recall. Safe logs contain IDs and categories, not callback error text or memory data.

Per process, admission permits four healthy unsettled calls per ID and 16 unsettled calls overall. A detached timed-out or aborted call prevents new calls for that ID until actual settlement. Input accounting limits each snapshot to an estimated 1 MiB and retained snapshots to an estimated 8 MiB, with bounded depth and node traversal. These are conservative accounting limits, not measured heap limits. A JavaScript deadline cannot force an abort-ignoring callback to settle; retained admission slots are released only at settlement.

Promotion creates an immutable event identity and delivery rows in the same transaction as the destination memory, source transition, and required promotion audit. The installation-wide producer ID set comes from a durable operator-owned singleton. A current manual org administrator using a bound operator session sets it through `continuum_operator_set_promotion_webhook_ids(actor, ids)`, with an audit and at most 1024 valid IDs. APP cannot configure that registry; SYNC and reporting receive no outbox privileges. Exact APP/OP grants permit the reviewed event and delivery operations, not arbitrary schema ownership.

An empty producer registry uses the durable configured set. A nonempty local producer registry must match it exactly; disagreement returns `CONFLICT` and commits no promotion. Callback implementations remain local to consumers. Stock REST starts a worker with its empty callback registry, so it stays idle while configured deliveries remain pending. Stdio MCP produces deliveries but does not start a webhook consumer. Register implementations in a custom REST composition or dedicated worker, with the same expected ID set across replicas.

Workers claim bounded requested work with `FOR UPDATE SKIP LOCKED`, commit ownership before invoking callbacks, and fence subsequent writes by event, webhook, owner, attempt and generation. Expired ownership is rechecked after locking so stale ranking cannot steal a fresh lease or redeliver a completed row. Indexed claim and release paths target requested webhook backlogs. Exhausted-row normalization skips locked rows, but a locked eligible head can delay a poll when its selected prefix receives only one slot. This is limited fairness, not universal progress past every locked row. Delivery is at least once: consumers must deduplicate stable `event.eventId`, including after a crash between callback success and acknowledgement.

Claims and raw manual retry exclude destinations mapped to disabled users through statement-snapshot mapping predicates; claims also recheck eligibility after locking. An already in-flight pre-disable statement or a payload already loaded by a consumer is not retracted. Disabled-destination pending rows remain parked until approved privacy scrub cancels them or legitimate access-only reactivation restores eligibility, except exhausted interrupted rows may be normalized to dead letters without dispatch or retry. Each poll filters excluded heads before its prefix LIMIT; scanning those excluded rows is not constant work or a universal row bound. Backlog size and replica count affect scan cost within the five-second server statement budget. Quiesce producers and workers and confirm process exit when a strict cutoff is required.

Defaults are a 1000-millisecond poll, claim batch 10 (maximum 100), 30000-millisecond lease, 5000-millisecond callback and database deadlines, 5000-millisecond shutdown wait, ten attempts, and exponential backoff from 1000 to 300000 milliseconds with jitter. Claims and owned Pool-backed writes use server-side five-second statement and one-second lock budgets, preserving stricter settings. Borrowed clients retain caller transaction and timeout ownership. These per-operation bounds are not a whole-worker deadline.

Dead letters require deliberate recovery. `manualRetryPromotionDelivery` is an unaudited low-level database export with no actor authorization. It is not an authenticated operator endpoint. Use trusted connections after quiescing old replicas and confirming settlement or process exit. Any end-user retry surface must add authorization and mandatory audit in its own transaction. Stable event IDs survive retry; privacy-cancelled deliveries cannot be retried.

Shutdown stops new claims, handles in-flight claims, requests callback abort, and makes bounded lease/reconciliation progress. It cannot retract a payload already given to a consumer or forcibly stop JavaScript. Process-wide retained delivery fences have a finite capacity of 100; sufficiently many abort-ignoring callbacks can exhaust it and halt otherwise healthy work. Replacement workers in the same process cannot evade those fences. Restart affected replicas through bounded shutdown rather than treating deadline expiry as successful cancellation.

## Personal Standup

Authenticated `GET /api/v0/standup` and `continuum.standup` expose a bounded personal digest. Activity is explicitly attributed to the caller, selected from their approved user scope or currently readable project scopes, and accompanied by memory citations. Other actors' records are excluded even when the caller can read their memories. REST returns structured data; MCP renders escaped Markdown from the same service. Successful delivery requires read auditing. The generated AGENTS.md bundle excludes this personal context surface and its activity metadata.

Migration 0090 separates actor mappings, activity attribution, thread closures, and producer bindings from caller-controlled memory metadata. A current manual org administrator in a bound operator session configures immutable namespace-scoped mappings and role-name/OID producer bindings. The writer must use the actual bound LOGIN session with its enabled service principal and least-privilege APP profile. `SET ROLE`, a passed principal UUID, and custom GUCs cannot substitute for that session. GitHub identity uses numeric actor and repository IDs; terminal and deploy adapters use a configured external actor identity. Authenticated capture and attribution commit in the same ingestion transaction. Unbound capture remains ordinary memory without trusted activity.

Activity timestamps must be finite, not in the future, and at or after the mapping generation's creation. Omitted source time is allowed only for the first mapping generation and must satisfy the same bounds. No moving receipt-time lower clamp is used. Branch/session openers and merged/finished closure evidence use namespace-scoped hashed keys. A closure remains effective within its mapping generation after its source memory archives or its scope becomes unreadable, preventing delayed openers from reviving a closed thread. Revocation preserves historical evidence and replacement does not reinterpret it under a new generation.

Attribution records the source's original expiry ceiling. Verification and promotion cannot extend it; shortening expiry narrows the ceiling. Promotion strips nine untrusted activity metadata keys and can inherit attribution only through reciprocal, canonical content and provenance checks. An ordinary APP cannot forge a trusted copy by linking fabricated content to an attributed source. Active attributed source content and provenance are protected while legitimate lifecycle transitions and authorized canonical erasure remain possible.

Approved offboarding scrubs actor labels and mapping revocation reasons in bounded batches and revokes active mappings. Completion checks physical residual state, including locked rows, rather than assuming a successful batch erased everything. Protected repair receipts remain immutable. Erasure replaces the reversible external identity link with an irreversible mapping marker. An owner-only namespace/hash generation count has no subject, mapping or timestamp linkage and preserves replacement-generation denial after erasure. Memory, actor and mapping UUIDs, hashed thread keys, timestamps, and closure evidence remain as accounting records. Retained backups and data already delivered to clients require separate policy. See [Standup](./docs/standup.md) for query bounds, source configuration, operator procedures and rollout.

## Generated AGENTS.md

The generator reads authorized live, unexpired decisions, playbooks, facts, and relationships. It excludes user/context memories and all coordination data. Selection is SQL-based, not semantic recall against configured day-one queries. Sections are org, sorted role scopes, requested team, then requested project. Within each scope, SQL orders by type and verification/update/creation timestamps. The per-scope default is 20, with a transport maximum of 200.

Rendering contributes no current timestamp. It escapes Markdown-active punctuation and control/format characters, identifies provenance, and places contributed body lines inside explicit data blocks. Consumers must still treat instruction-like content as untrusted reference data. This is formatting and provenance, not a semantic prompt-injection detector.

The SHA-256 of exact rendered bytes forms the ETag. REST conditional reads support bodyless 304; the freshness endpoint and MCP freshness tool return only a boolean. Reads use private cache headers and authorization variation, and required read audits distinguish delivered memories from freshness/304 checks. The generator does not write repository files or run publication automation. See [freshness](./docs/agents-md-freshness.md) and [src/agents-md/render.ts](./src/agents-md/render.ts).

## Knowledge-gap insights

Explicit org administrators can query `GET /api/v0/insights/gaps` or `continuum.gaps` for bounded grouping of zero-hit recall request summaries. Exact normalized query groups are selected before optional semantic clustering; unavailable or invalid embeddings fall back to exact groups. Reports omit principal identities, include effective limits and truncation, and derive resolution from current live memory with known scope fidelity. MCP renders query-derived values inside escaped data boundaries. This is an on-demand analysis surface, not an automated digest or channel publisher. See [knowledge-gap insights](./docs/knowledge-gap-insights.md).
## Audit and operations

Required service write audits commit with mutations. Recall and generated-bundle delivery require successful read auditing before returning success. Audit query visibility is principal-limited unless current org-admin authority permits cross-principal access. Trusted low-level exports, dry-run previews, and some metadata operations have different contracts; do not claim every direct database read or write is audited.

Retention deletes eligible rows in bounded reviewed runs, preserves protected approval/completion and retention evidence, and optionally exports under filesystem and database policy. Default batch size is 100, maximum batches 10, and maximum rows 1,000. Durable export is not supported on Windows; deletion without export has a separate contract. See [audit API](./docs/audit-api.md) and [retention](./docs/audit-retention.md).

REST uses `/api/v0`. MCP uses stdio tools with a `continuum.` prefix. The HTTP CLI implements capture, recall, audit, scopes, promote, verify, and agents-md; database administration and maintenance are separate entrypoints. Transport naming and error envelopes remain distinct. MCP revalidates credentials periodically, so revocation can have up to a 30-second credential-check interval; operation-specific principal and membership checks remain fresh.

REST defaults to port 4000, a 1 MiB JSON body limit, a 1-second readiness query, and a 10-second shutdown budget. Liveness is separate from DB connectivity readiness. Readiness does not probe embedding endpoints or rerun migration/erasure verification. Startup verifies the configured application schema, provider profiles, complete coordination contract state, the promotion outbox, and trusted Standup schema before serving. A missing 0089 outbox fails startup even when no callbacks are registered. Shutdown marks not-ready, drains the configured runtime work, closes the pool, and bounds overdue connections. See [API operations](./docs/api-operations.md) and [CLI](./docs/cli.md).

## Offboarding

Offboarding requires current org-admin authorization, a database-bound operator session, an approved principal-to-user-scope mapping, and confirmation of that exact scope UUID. Reviewed membership and author evidence is bounded and hashed. New unacknowledged evidence fails closed. Final effective manual org-admin authority remains protected.

Initial access revocation can commit and record immutable evidence even when migration readiness or an owned live lease blocks privacy. Names and the offboarded timestamp need not change in that access-only transaction. Unchanged blocked retries do not create duplicate permanent access receipts.

Memory, scope, audit, and coordination privacy work proceeds in bounded durable phases. Personal memory tombstones, every provider embedding, aliases, and linked audit data are erased; shared memories remain. Standup actor labels and mapping reasons are scrubbed and active mappings revoked through approved bounded work. Owned destination outbox snapshots are pseudonymized and their deliveries become privacy-cancelled in bounded operator-authorized work, included in physical completion proof. Owned coordination resources are erased after preserving floors, and shared lease/receipt identities are detached. A scope label alone is never an erasure selector.

Completion requires physical state and database-verified lifecycle evidence, not counters alone. A completed clean retry performs full actual-state verification under a configurable budget, default 30 seconds. Reopened completed runs repair privacy before lifecycle verification or restart. An ordinary advancing run can continue memory/audit batches during a typed privacy block when meaningful work remains; a privacy-only block stops progress. Coordination-only repair completion does not close an open offboarding lifecycle run.

Canonical post-erasure lock audit metadata retains operation, outcome, transport, and own-lease evidence; it removes identifiers, tokens, and byte counts that could link shared keys back to the subject. Forward repair clears legacy UUID compatibility links and rewrites fenced lock audits in bounded owner windows without changing run IDs, approvals, or completion events. Older temporal correlation and retained backups remain separate policy concerns. [Offboarding](./docs/offboarding.md) defines exact reasons, witness timestamps, retry/once exit statuses, and recovery.

A consumer may already hold an event snapshot or have sent it downstream. Stored-state completion does not erase that in-process or downstream copy. Quiesce producers and all replicas, confirm exit for abort-ignoring callbacks, and apply downstream erasure policy separately.

## Coordination

Coordination resources, generations, receipts, and usage are separate from memories. Resource keys are exact case-sensitive Unicode strings of 1 through 512 UTF-8 bytes, excluding controls and edge whitespace. Default lease TTL is 300 seconds, with a 30 through 900 range. Acquisition is exclusive and non-reentrant; contention is a successful outcome.

Fencing tokens are positive decimal-string BIGINT values. Resource counters and persistent scope floors preserve monotonicity after reclaim and erasure. Fresh mutations revalidate current explicit writer/admin authority, use a fresh database clock, and commit lease, receipt, quota, and audit changes together. Server-side timeouts bound waits.

Each scope has a hard 10,000-key ceiling. Each principal has one combined 10,000-receipt budget across operation types, retained at least 24 hours. Fresh renewals and releases can fail when saturated; unexpired evidence is not evicted to admit new operations. Replay requires its documented authorization, generation, retention, and privacy conditions. Clients must budget renewals and contention polling.

Lease ownership is not an end-to-end side-effect fence. Downstream resources must reject stale tokens; ordinary filesystems and GitHub do not do this automatically. Publication still requires orchestrator control and repository protection. REST uses camelCase and MCP snake_case naming over the shared service. See [coordination](./docs/coordination.md).

Migration 0091 adds an approval-bound, project-scope operator quarantine for an
exact expired ambiguous renewal. It preserves the historical outcome as UNKNOWN
and original receipt/expiry evidence, commits a permanent no-replay fence and a
new operator retirement, and grants no lease or worker authority. Old clients
remain quarantined; a new run additionally requires current operator/deployment
readback and independent physical quiescence. See the coordination and deployment
runbooks. This does not claim linearizable downstream fencing or retrospectively
prove whether the original renewal committed.

## Migration and rollout

The current schema includes provider-profile and coordination repairs through 0082, tag vocabularies in 0083, embedding storage/backfill/index migrations 0084 through 0088, the promotion outbox in 0089, and trusted Standup activity in 0090. A migration filename in the ledger does not prove bounded coordination backfill completion. Owner-only schema work, backfill, effective-body verification, and execution evidence have separate roles. Execution provenance stores hashes, counts, and named variants without storing raw SQL or credential bindings; older execution history can remain unknown.

Tag rollout pauses webhook intake and all memory writers, preserves queued deliveries, backs up data, migrates, deploys compatible instances, and then replays unchanged delivery identities and bytes. Migration 0083 takes an EXCLUSIVE memory-table lock, with a five-second lock wait and per-statement 60-second budget. The historical rewrite and trigger installation commit together. These limits do not bound total transaction or exclusive-lock duration. Its temporary role-planning table also requires the migration owner's database TEMPORARY privilege. Use a measured maintenance rehearsal and finite outer deadline; do not infer universal volume support from a small fixture. Exact application/operator profiles gain only the reviewed vocabulary table permissions, and sync/reporting profiles remain separate. See the dedicated rollout and rollback guide.

Embedding migration 0084 builds the provider-qualified unique index concurrently and attaches it as the primary key in a bounded lock transaction. Migration 0085 creates durable failure state and snapshots exact role profiles using a temporary table, requiring owner database TEMPORARY. Migration 0086 adds durable/suspect disposition; 0087 builds the provider-leading scan index; 0088 repairs invalid matching artifacts. Valid application/operator profiles gain only the reviewed state table grants, not sync/reporting privileges. Five-second lock and per-statement 60-second DDL budgets do not bound advisory-lock acquisition or the whole deployment. The current migrator polls for its deployment lock without an internal acquisition deadline; enforce a finite external process deadline.

Drain old memory/embedding writers before the 0084 key change: their memory-only conflict target is incompatible with the new composite key. Keep them stopped until every API, MCP, lifecycle, and maintenance writer is compatible. Reversing schema requires a verified pre-upgrade backup including migration ledgers, with deliberate replay of later writes/deliveries; the rollback script rejects in-place downgrade. Do not delete ledger rows or collapse multiple vectors silently.

Ordinary packaged migration work uses the trusted application-only path. Only 0001 receives its validated application/provider overlay. Initial catalog and advisory operations are qualified, and caller path restoration is part of safe connection cleanup. Current runtime entrypoints require the resolved explicit path to contain exactly the configured application schema. Provider-profile reconciliation does not automatically revoke global PUBLIC/shared-provider privileges or transfer ownership.

Maintenance must quiesce affected serving readers and writers, including authentication traffic, while schema locks and repair gates are active. Long parked histories can exceed finite migration deadlines; repeated volume-bound failures require measured owner-reviewed recovery, not an unbounded override. Finish repair and exact grants before restarting current processes. Existing running nodes have a different pending-repair replay boundary from processes whose startup gate refuses service. The [role and migration runbook](./docs/offboarding.md) is the detailed operational authority.

Migration 0089 requires migration-owner database TEMPORARY privilege for its role snapshot. Quiesce all old promotion producers, offboarding processes, and workers, migrate, explicitly regrant APP and OP profiles, configure the durable ID set, and restart compatible binaries. Invalid registered role profiles are not silently broadened; explicit regrant and startup verification remain required. Old producers can omit deliveries and old offboarding code cannot repair the outbox. A binary-only rollback cannot reconstruct omitted events or reverse erasure. Use the verified backup and forward-recovery runbooks.

Migration 0090 requires the migration owner's database TEMPORARY privilege for its exact role snapshot. Quiesce activity producers and offboarding processes, migrate the complete chain, regrant APP and OP profiles, configure reviewed producer bindings and actor mappings, then start compatible binaries whose exact-profile and Standup readiness checks pass. The migration does not manufacture activity from historical caller metadata. Old unbound producers can still capture ordinary memories but cannot supply trusted Standup attribution. A binary-only rollback does not reverse physical erasure or reconstruct omitted activity. Use a verified backup for schema reversal and keep all published migration bytes intact.

## Container packaging

Production container packaging uses hosted-built immutable Linux amd64 OCI artifacts, checksum-verified runtime assets and separate DBA, owner, APP, OP and SYNC authority. See [the deployment guide](docs/deployment.md) for explicit maintenance, private secrets, resource limits and volume-preserving recovery. The development Compose file is not a production installation. Packaging does not authorize live deployment or historical database operations.

## Optional remote MCP

The API process can serve authenticated Streamable HTTP at `/mcp`, disabled by default. It uses the same tool registrations, current memberships, source restrictions and required domain audits as stdio. See [remote MCP](./docs/remote-mcp.md) for the explicit HTTPS proxy policy, limits, session lifecycle and rollout. Stdio remains available through `npm run mcp`.

Remote MCP passes optional aggregate read budgets into shared memory, recall, history and generator paths. Metadata-only admission and a repeated same-snapshot gate prevent oversized hydration; mutation source probes lock admitted rows before reading their contents. Generator limits include all selected scopes and escaped rendering. Budget failures precede success delivery audits and writes without truncating content or changing default transport selection.

## Isolated UAT

See [UAT deployment](./docs/uat-deployment.md), [client onboarding](./docs/uat-client-onboarding.md) and [Delivery Forge smoke](./docs/delivery-forge-uat.md). The optional Gemini adapter uses an explicit model-qualified 768-dimensional profile; only approved non-sensitive scopes may route to it. Local-only scopes never fall through to hosted providers. Guides and SDK fixtures do not establish live deployment, native-client isolation or owner acceptance. Keep private configuration and receipts outside tracked artifacts.
