# Continuum Architecture (v0)

Status: design, pre-implementation. This document is the source of truth for the v0 schema, scope model, capture API, retrieval surface, and extension points.

## Design principles

1. **Vendor-agnostic at every layer**. No memory ever requires a specific LLM provider, IDE, or embedding model to be read.
2. **Scopes are first-class**. Every memory belongs to exactly one scope. Read access is inherited; write access is explicit.
3. **Capture is plugin-shaped**. Every ingestion source is interchangeable. Adding a new one does not modify core.
4. **Audit everything**. Every read and every write is logged. The audit log is queryable.
5. **Decay is per-type**. A decision does not decay like a context snapshot. The taxonomy drives the lifecycle.
6. **Build for the next milestone, not the next decade**. No speculative interfaces.

## Scope model

Five scopes:

| Scope | Cardinality | Example contents |
|-------|-------------|------------------|
| `org` | one per deployment | architectural decisions, security policies, naming conventions, "we use ADO not Jira" |
| `team:{name}` | many | squad runbooks, on-call notes, sprint context |
| `project:{name}` | many | per-codebase API quirks, deployment gotchas, business rules |
| `user:{id}` | one per user | personal scratch, "what was I doing yesterday", preferences |
| `role:{name}` | many | cross-cutting (security, design, ops, PM) |

**Write rule**: every memory is written to exactly one scope. The writer must be a member of that scope.

**Read rule**: a `user` reads its own `user` scope plus every `team`, `project`, and `role` scope it belongs to, plus `org`. Scope membership is sourced from Entra ID groups (or a configurable equivalent).

**Promotion**: a memory can be promoted to a higher scope via an explicit `PromoteMemory` operation. Promotion requires an approver (lead for `user` to `team`, architect or org admin for `team` to `org`). Promotion creates a new record in the destination scope and marks the source as `promoted_to: <new_id>`.

## Memory taxonomy

Five types. Each type has its own decay rule and review cadence.

| Type | Decay | Review |
|------|-------|--------|
| `fact` | re-verified every 90 days; flagged stale if verification fails | owner re-confirms |
| `decision` | does not decay; immutable after write | owner can supersede with new decision linked by `supersedes_id` |
| `context` | aggressive: half-life of 14 days for `user` scope, 60 days for `team`/`project` | auto-archived past threshold |
| `playbook` | versioned; current version always live; reviewed every 180 days | owner sign-off recorded |
| `relationship` | re-verified every 180 days against source-of-truth (org chart) | auto-flagged if mismatch |

## Storage schema (PostgreSQL + pgvector)

```sql
-- Identity and scope membership come from Entra; we cache for query speed.
CREATE TABLE principals (
  id              UUID PRIMARY KEY,
  external_id     TEXT NOT NULL UNIQUE,  -- Entra object id, or service-account id
  kind            TEXT NOT NULL,         -- 'user' | 'service'
  display_name    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scopes (
  id              UUID PRIMARY KEY,
  kind            TEXT NOT NULL,         -- 'org' | 'team' | 'project' | 'user' | 'role'
  name            TEXT NOT NULL,         -- '' for org, otherwise the scope name
  owner_principal_id UUID UNIQUE REFERENCES principals(id), -- explicit for user scopes
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);

CREATE TABLE scope_memberships (
  principal_id    UUID NOT NULL REFERENCES principals(id),
  scope_id        UUID NOT NULL REFERENCES scopes(id),
  role            TEXT NOT NULL,         -- 'reader' | 'writer' | 'admin'
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, scope_id)
);

CREATE TABLE memories (
  id              UUID PRIMARY KEY,
  scope_id        UUID NOT NULL REFERENCES scopes(id),
  type            TEXT NOT NULL,         -- 'fact' | 'decision' | 'context' | 'playbook' | 'relationship'
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags            TEXT[] NOT NULL DEFAULT '{}',  -- controlled vocabulary, validated
  author_id       UUID NOT NULL REFERENCES principals(id),
  source          TEXT NOT NULL,         -- capture plugin id, e.g. 'github-pr', 'ado-workitem', 'terminal-summary', 'manual'
  source_ref      TEXT,                  -- external identifier, e.g. PR url or work-item id
  state           TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'stale' | 'archived' | 'promoted'
  supersedes_id   UUID REFERENCES memories(id),
  promoted_to_id  UUID REFERENCES memories(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,           -- type-dependent
  last_verified   TIMESTAMPTZ
);

CREATE INDEX memories_scope_state_idx ON memories (scope_id, state);
CREATE INDEX memories_type_idx        ON memories (type);
CREATE INDEX memories_tags_gin        ON memories USING gin (tags);
CREATE INDEX memories_metadata_gin    ON memories USING gin (metadata);

CREATE TABLE memory_embeddings (
  memory_id       UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,         -- 'ollama:nomic-embed-text', 'voyage-3', etc.
  dim             INT  NOT NULL,
  embedding       VECTOR,                -- pgvector
  embedded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_embeddings_ivf ON memory_embeddings USING ivfflat (embedding vector_cosine_ops);

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  principal_id    UUID NOT NULL REFERENCES principals(id),
  action          TEXT NOT NULL,         -- 'read' | 'write' | 'promote' | 'archive' | 'verify'
  memory_id       UUID,
  scope_id        UUID,
  query           TEXT,
  metadata        JSONB
);

CREATE INDEX audit_log_principal_idx ON audit_log (principal_id, at DESC);
CREATE INDEX audit_log_memory_idx    ON audit_log (memory_id);
```

## Capture API (v0)

The authenticated manual capture endpoint is shared by REST and MCP callers.

```
POST /api/v0/capture
Authorization: Bearer <token>
Content-Type: application/json

{
  "scope":      { "kind": "project", "name": "booking-engine" },
  "type":       "context",
  "title":      "Started branch feature/checkout-v2 off main",
  "body":       "Working on the new checkout flow. PR #4421 in flight, blocked on Security Reviewer review.",
  "tags":       ["branch", "in-progress"],
  "source":     "github-branch",
  "source_ref": "https://github.com/exampleorg/booking-engine/tree/feature/checkout-v2",
  "metadata":   { "branch": "feature/checkout-v2", "base": "main" }
}
```

Response:
```
{
  "id": "01HXY...",
  "scope_id": "...",
  "expires_at": "2026-06-16T02:44:05Z",
  "embedded": true,
  "related": []
}
```

Validation rules:
- `scope` must exist; caller must have `writer` role on it.
- `type` must be valid; `expires_at` is computed from type + scope kind.
- `tags` validated against the controlled vocabulary for the scope kind (org-admins manage vocabularies).
- `source` must be a registered capture plugin id or `"manual"`.

When embedding is configured, capture computes the new vector once and probes
at most five live, unexpired memories from the target scope plus org using the
same provider and dimension. The default cosine-similarity threshold is 0.92
and can be changed with `CONTINUUM_RELATION_THRESHOLD` (0 through 1). Exact
normalized title and body matches are `possible-duplicate`. Nonidentical
fact/fact and decision/decision matches are `possible-conflict`; all other
matches are `possible-duplicate`. These are similarity candidates, not claims
that content contradicts, and capture never mutates or supersedes an existing
memory.

`metadata.related` is reserved for Continuum-owned relation data. REST, MCP,
and service callers that supply that key receive `INVALID_INPUT`; callers
cannot forge candidate metadata. Promotion removes stored `related` metadata
because candidate IDs were authorized and ranked for the source scope, not the
destination scope.

REST and MCP capture responses include the same safe `related` array. Each
stored candidate contains only `id`, `similarity`, `relation`, `provider`,
`threshold`, and `detectedAt`. Provider or embedding-storage failure is
nonblocking: the memory and write audit still commit, `embedded` is false, and
the audit contains only `EMBEDDING_FAILED`. Candidate probe or metadata
persistence failure is also nonblocking: the valid provider embedding remains
stored, `embedded` is true, `related` is empty, and the audit contains only
`RELATION_DETECTION_FAILED`. With no serializing lock, two concurrent duplicate
captures may both miss each other in v0; a later reconciliation sweep can
address that limitation.

Relation candidates are not surfaced in the review queue in issue #15. Any
future issue #12 decision workflow must reauthorize candidate IDs for its
caller and revalidate scope, lifecycle state, expiry, provider, dimension, and
relation before acting. Stored advisory metadata is not durable authorization
and never triggers automatic supersede, reject, or state mutation.

Provider webhooks enter through `POST /api/v0/ingest/:pluginId`, which verifies
provider credentials before dispatching to the built-in capture registry. The
route binds source to the selected plugin, resolves its configured service
principal, requires explicit writer or admin membership on every target scope,
and reuses the shared capture service. Delivery identities are durable: a new
capture returns `202`, a valid ignored event returns `204`, and a completed
replay returns `200` with the original memory IDs. Reusing an idempotency key
with different request bytes fails closed. GitHub delivery identity is derived
from the signed request bytes instead of its unsigned delivery header. Derived
embedding provenance is appended as a new audit row; committed audit rows are
not updated. See
[`docs/webhook-ingestion.md`](./docs/webhook-ingestion.md).

## Retrieval API (v0)

```
POST /api/v0/recall
Authorization: Bearer <token>
Content-Type: application/json

{
  "query":   "where is the checkout retry policy defined",
  "scopes":  ["project:booking-engine", "team:payments", "org"],
  "types":   ["fact", "decision", "playbook"],
  "limit":   10
}
```

Response includes ranked memories with `score`, `scope`, `type`, `source_ref`, and a short `excerpt`. Reading is logged to `audit_log` per principal.

Search is hybrid: vector similarity on `memory_embeddings` plus full-text on `memories.body`, fused by reciprocal rank fusion. Scope filter is applied pre-rank.
Every serving query also excludes memories whose `expires_at` is at or before
the database's current time. The full-text and vector candidate queries apply
this filter before ranking, and recall hydration repeats it so a memory that
expires while a request is in flight is not returned. The AGENTS.md generator
uses the same database-clock rule. A null `expires_at` remains non-expiring.

## AGENTS.md generator

```
GET /api/v0/agents-md?project=booking-engine&team=payments
```

Returns a markdown document containing:
1. The `org` section (always included).
2. The requested `project` scope.
3. The requested `team` scope.
4. Any `role` scopes the requesting principal belongs to.

Memory selection is tuned for "bootstrap an agent": prefers `playbook` and `decision` over `context`, prefers high-score retrievals against a configured set of "what should an agent know on day one" queries per scope.

Output is plain markdown. No vendor-specific tokens. Suitable to drop at the root of any repo and have any agent read first.

The authenticated REST response carries a private, deterministic ETag equal to
the quoted lowercase SHA-256 digest of the exact rendered UTF-8 bytes. It
honours strong, weak, multiple, and wildcard `If-None-Match` validators for
bodyless 304 responses. The authenticated freshness endpoint and
`continuum.agents_md_fresh` MCP tool compare a caller-supplied digest with the
current bundle and return only `{ "fresh": boolean }`. They use the same scope
selection, ACLs, expiry rules, type filters, limits, and rendering path as the
document. Historical manifests and repository writes are not part of this
contract; repository automation remains an external authenticated consumer.
See [docs/agents-md-freshness.md](./docs/agents-md-freshness.md).

The generated document treats memory content as contributed reference data, not
as system policy. Every entry carries its scope, memory ID, source, author ID,
and source reference. Titles, provenance values, and bodies are rendered with
deterministic Markdown and HTML punctuation escaping after CRLF normalization;
control and Unicode format characters are shown as explicit code-point text.
Bodies retain every line, including blanks, inside a blockquoted data container
with generated begin and end delimiters. Each contributed line has an explicit
`DATA:` prefix so contributed text cannot imitate a generated boundary. This
prevents contributed text from creating headings, lists, links, HTML, or fences
outside its entry while preserving the content and the renderer's existing
section and ranking order.

This formatting is a defense-in-depth trust boundary, not a semantic prompt
injection filter. Instruction-like natural language remains readable inside the
data container, so consumers must continue to treat it as untrusted reference
material. The endpoint, MIME type, and storage schema are unchanged, but clients
that compare exact generated output must accept the hardened format. Rendering
happens on read, so existing memories need no backfill.

## Capture plugins (v0 set)

Each plugin lives in `src/capture/{plugin}/`, registers an id, and posts to the internal capture API with a service-account token.

1. `github-pr`: webhook on PR merged. Summarises body + review thread via configured LLM. Writes `context` to `project` scope.
2. `ado-workitem`: webhook on work-item updated. Summarises comments and state changes. Writes `context` to `project` scope (or `decision` if a "decision" label is present).
3. `github-branch`: webhook on branch ref created. Writes `context` to author's `user` scope.
4. `deploy-event`: CD pipeline webhook. Writes `fact` to `project` scope ("v1.42 deployed to PROD at <time>, PR #X").
5. `terminal-summary`: receives end-of-session summary from an agent hook. Writes `context` to author's `user` scope. The agent hook is published as a small shell helper and an MCP server method.
6. `teams-chat` (v1.5, gated on Security Reviewer signoff + consent flow): Microsoft Graph subscription on opted-in channels. Extracts decisions and Q&A. Writes `decision` or `fact` to `team` scope.

## MCP server surface

Methods:
- `continuum.capture(scope, type, title, body, ...)`
- `continuum.recall(query, scopes?, types?, limit?)`
- `continuum.get_memory(memory_id)`
- `continuum.list_memories(scope?, type?, state?, limit?, offset?)`
- `continuum.supersede(superseded_id, title, body, ...)`
- `continuum.decision_history(decision_id)`
- `continuum.promote(memory_id, target_scope)`
- `continuum.verify(memory_id, still_true: bool, note?)`
- `continuum.list_scopes()`
- `continuum.agents_md(project?, team?, limit?)`
- `continuum.agents_md_fresh(hash, project?, team?, limit?)`
- `continuum.gaps(since?, limit?, min_frequency?, threshold?)`

ACLs are enforced server-side from the bearer token's principal. The MCP client never sees memories outside its caller's read set.

`continuum.ensure_scope` is a tenant-administration operation. Every scope kind,
including the singleton org scope, requires an explicit `admin` membership on
org. The initial org admin is provisioned through a trusted operator path after
the migration seeds org; MCP has no bootstrap bypass. Successful ensure calls
are audited even when the scope already exists, and concurrent calls converge
on one scope without issuing no-op updates. The checked operator procedure is
documented in `docs/scope-provisioning.md`; running MCP processes must be
restarted to load this policy.

This authorization is enforced at Continuum's service boundary. The v0 stdio
MCP principal and REST bearer identity remain self-asserted placeholders until
Entra validation lands in M4, so database and process-launch access remain
trusted administrative capabilities rather than security boundaries. The v0
REST bearer is the principal `external_id`; org-admin bootstrap therefore uses
a high-entropy identity and requires trusted-network REST restriction.

User-scope identity is stored explicitly as `scopes.owner_principal_id`; it is
never inferred from a scope name, display name, author, or membership. Existing
unowned user scopes fail closed until an administrator reviews and audits a
one-to-one backfill. Standup activity similarly requires explicit
`metadata.actor_principal_id`, `actor`, a stable `thread_key`, and an internal
post-authorization provenance marker; pre-migration metadata is not backfilled.
Closure uses only trusted `closes_thread_keys`. Raw service capture cannot set
attribution or closure fields; mapped plugin capture resolves immutable external
IDs through append-only, database-audited org-admin mappings. GitHub uses numeric
webhook user IDs, never mutable logins. Deploy and terminal identities and thread
keys are namespaced to the authenticated ingestion principal. PR authors and
deploy actors are the activity actors, while mergers and reviewers remain
separate metadata. Promotion strips all activity/thread trust metadata so moving
knowledge cannot manufacture freshly dated standup activity.

## Shared service layer

REST, MCP, and the AGENTS.md generator share canonical scope and access resolution under `src/services/`. Transport adapters parse protocol-specific input and serialize their existing wire formats. Services own scope validation, ACL decisions, persistence orchestration, and audit policy.

The org scope is implicitly readable by every authenticated principal across recall and AGENTS.md generation. Other scopes require membership for every read path. Every source mutation requires an explicit `writer` or `admin` membership on that source scope: this includes verification updates (`state`, `last_verified`, and `expires_at`) and promotion (`state` and `promoted_to_id`). Authorship, implicit org access, and explicit `reader` membership are read-only. Promotion additionally requires `admin` on an org destination or `writer`/`admin` on any other destination. Lifecycle authorization is checked inside the mutation transaction with membership rows locked so concurrent revocation has deterministic ordering. Verification and promotion lock the memory row before locking source membership, so they serialize with one another and concurrent membership changes without reversing lock order. Verification checks source membership before reporting a terminal-state conflict, preventing unauthorized callers from learning whether a memory is promoted or archived. It rejects terminal states so it cannot overwrite a concurrent promotion or archive. For a live or stale memory, `still_true=true` moves the memory to `live` and renews its expiry from the verification instant; this is the recovery path for a stale memory that its owner re-confirms. `still_true=false` moves it to `stale` without renewing expiry. Capture commits the memory mutation and required write audit in one transaction. The embedding provider network call happens before `BEGIN`; the vector insert and advisory relation metadata update use separate transaction savepoints so candidate failures cannot roll back a valid embedding. A provider or embedding-storage failure is reduced to the safe `EMBEDDING_FAILED` code. A candidate probe or metadata-storage failure is reduced to `RELATION_DETECTION_FAILED`. In either case the memory and its audit may still commit together. Recall auditing is required; results are not returned when its audit entry cannot be persisted. Service errors retain internal causes for server-side diagnostics but transports serialize only stable codes and safe public messages.

Decision supersession requires explicit writer or admin membership on the
decision scope. Only a `live` decision may be superseded; a `stale` decision
must first be verified back to `live`, and attempting to supersede it returns a
conflict. The write path makes missing and unreadable predecessor IDs
indistinguishable, while a caller who can read the predecessor but lacks writer
or admin membership receives a forbidden response. It locks the live
predecessor, creates one linked decision in the same scope, archives the
predecessor, and writes both audits in one transaction. The schema prevents
self-links and branching. Supersession stores Continuum-owned `related: []`
metadata and rejects caller-supplied `metadata.related`; issue #15 relation
candidates remain advisory and never authorize or trigger supersession. After
commit, provider I/O embeds the new chain head outside the write transaction.
The successor vector, archived-vector removal, and a bounded provider/status
audit then commit together. Provider, post-commit pool, vector-storage, or
derived-audit failure returns `EMBEDDING_FAILED`, retains the archived vector,
and leaves the live successor available to full-text recall. A failed outcome
audit is best-effort because the database failure may also make observability
unavailable. If a local-only route has no local provider, a best-effort derived
audit records `embedding_policy: "local-only-unavailable"`; the successor stays
full-text-only and is never sent to a hosted provider.
Recall and AGENTS.md serve only the live head and may expose its predecessor ID,
never the archived content. Decision history is read-authorized, audited,
cycle-safe, and returned oldest to newest with the current head ID.

### Transport error and audit contracts

REST errors use `{ "code": "...", "error": "..." }` with the HTTP status derived from the stable service code. Request-schema failures use `INVALID_INPUT`; malformed JSON uses `INVALID_INPUT`; bodies above the 1 MB parser limit use `PAYLOAD_TOO_LARGE`. No raw database or provider message is included. MCP tool failures set `isError: true` and return `{ "error": { "code": "...", "message": "..." } }` as JSON text. The MCP envelope is intentionally different because MCP tool results are content blocks rather than HTTP responses. Successful REST and MCP response shapes remain transport-specific and unchanged.

Capture write-audit metadata is `{ source, type, embedded }`. When embedding fails, it additionally contains `embedding_error_code: "EMBEDDING_FAILED"`; when advisory relation work fails, it contains `relation_error_code: "RELATION_DETECTION_FAILED"`. Raw provider messages, database details, and captured memory text are never copied into audit metadata. Promotion audit metadata contains `destination_id`. Verification audit metadata contains `still_true` and nullable `note`; it is committed atomically with the verification update and is absent when verification fails. Recall audit metadata contains scope count, effective scope IDs, hit count, and whether vector recall was requested. Effective scope IDs let derived knowledge-gap resolution report exact scope fidelity for new requests; historical rows without them remain `unknown`. Knowledge-gap reports write one query-free `read` audit with `metadata.view: "insights-gaps"`; their internal resolution checks do not emit recursive read audits.

## Extension points

Five interfaces. Engram and any future system integrate through these. Continuum core has zero knowledge of Engram.

1. **CapturePlugin**: implements `capture(event) -> CaptureRecord[]`. Registered at startup. Engram could write a plugin that turns its code-archaeology findings into `decision` memories.
2. **RetrievalEnricher**: receives a `RecallResult` and may attach additional context. Engram could attach work-item linkages to results without Continuum knowing what a work item is.
3. **PromotionWebhook**: fires on every promotion. Engram could subscribe and re-index the AGENTS.md output for affected repos.
4. **EmbeddingProvider**: implements `embed(texts) -> vectors`. Default impls: `ollama`, `voyage`, `openai`. Sensitive scopes pin to local-only providers.
5. **Transport**: today MCP + REST + AGENTS.md. New transports (Teams bot, Slack command) implement this and reuse all ACL/audit machinery.

## Authentication

- End-user auth: Entra ID SSO (OIDC). Token cached server-side, refreshed on demand.
- Service accounts: long-lived API keys, rotated quarterly, scoped to specific capture plugins.
- All tokens map to a `principal` row. Audit log references principals, never raw tokens.

## What is explicitly out of scope for v0

- A web UI. CLI + agent integration is the v0 surface.
- Multi-region deployment.
- Cross-tenant federation (one Continuum instance per tenant).
- LLM-side summarisation as a built-in feature; summarisation happens in capture plugins, not in core.
- Anything Engram does. Engram remains a separate product. Integration is via the extension points above.

## Next milestones

- **M0 (current)**: design (this document) reviewed and signed off.
- **M1**: schema migrations + scope model + capture API + REST recall. No plugins yet; manual capture only.
- **M2**: MCP server transport + AGENTS.md generator.
- **M3**: `github-pr`, `ado-workitem`, `github-branch`, `deploy-event`, `terminal-summary` capture plugins.
- **M4**: Entra SSO end-to-end, audit log queryable via CLI, Security Reviewer signoff on ACL/audit/PII story.
- **M5**: Pilot rollout to one ExampleOrg squad.
- **M6**: `teams-chat` plugin behind consent flow.
