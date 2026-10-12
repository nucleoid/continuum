# Personal Standup

Standup is a source-cited view of activity explicitly attributed to the authenticated caller. It combines their approved personal scope and currently readable project activity. Reading another person's memory does not make that activity yours. Scope names, caller-supplied labels and memory metadata do not establish ownership or attribution.

## Reading a digest

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $CONTINUUM_TOKEN" \
  "$CONTINUUM_API_URL/api/v0/standup?since=24h&limit=50"
```

REST returns `window`, `activity`, `openThreads`, and `page`. Each item includes its memory UUID, scope, type, title, source/reference, hashed thread key, derived actor label and activity timestamp (`createdAt`). It does not return full memory bodies. Responses use private no-store cache headers. Successful reads must deliver their audit before returning success.

`continuum.standup` renders the same selection as escaped Markdown with memory citations. It takes `since`, `date`, `timezone`, `limit`, `offset`, `open_thread_days`, and `open_thread_limit`. REST uses `openThreadDays` and `openThreadLimit`. The ordinary HTTP CLI has no separate Standup command; use REST or MCP.

| Input | Default | Bound |
| --- | --- | --- |
| `since` | `24h` | Integer hours, 1 through 168 |
| `limit` | 50 | 1 through 100 |
| `offset` | 0 | 0 through 10000 |
| Open-thread age | 2 days | 1 through 30 |
| Open-thread limit | 20 | 1 through 100 |

Alternatively, use `date=YYYY-MM-DD` and an IANA `timezone` together. Date and since are mutually exclusive; timezone without date is invalid. The day window uses local midnights, including daylight-saving transitions. An ambiguous or unavailable midnight is rejected. Activity is ordered by source time then memory UUID, with `page.nextOffset` for another bounded page. Open threads look back at most 90 days from the window end.

Current principal, effective membership, approved user-scope ownership, unexpired memory and trust ceiling predicates govern selection. Recent activity can include live or stale memories; open threads require live memories. There is no cross-user selector. Historical mapping evidence is not rewritten when the mapping changes. This personal view is excluded from generated AGENTS.md; the generator's contributed-data selection, exact bytes, ETag and auditing remain separate.

## Trusted activity producers

An enabled source adapter first authenticates its webhook or bearer request. Trusted attribution additionally requires a separately configured database pool using the actual producer LOGIN role. That role must have the exact APP profile and an operator-approved role-name/OID binding to its enabled service principal, namespace and source family. A shared APP session, `SET ROLE`, known UUID, custom GUC, or caller metadata cannot supply this authority.

Supported attributed families are `github`, `deploy-event`, and `terminal-summary`. GitHub actor and repository identity use stable positive numeric IDs, not login or repository display names. Terminal and deploy sources use an operator-configured external actor identity; payload labels do not override it. An unbound adapter can still capture ordinary memories but those memories have no trusted activity attribution.

For each enabled source prefix, set its existing principal and authentication configuration as described in [webhook ingestion](./webhook-ingestion.md), then optionally provide:

```sh
CONTINUUM_INGEST_GITHUB_PR_DATABASE_URL='postgres://producer-role:secret@host/database'
CONTINUUM_INGEST_GITHUB_BRANCH_DATABASE_URL='postgres://producer-role:secret@host/database'
CONTINUUM_INGEST_TERMINAL_SUMMARY_DATABASE_URL='postgres://terminal-role:secret@host/database'
CONTINUUM_INGEST_TERMINAL_SUMMARY_ACTOR_EXTERNAL_ID='reviewed-terminal-identity'
CONTINUUM_INGEST_DEPLOY_EVENT_DATABASE_URL='postgres://deploy-role:secret@host/database'
CONTINUUM_INGEST_DEPLOY_EVENT_ACTOR_EXTERNAL_ID='reviewed-deploy-identity'
```

Treat URLs and webhook secrets as credentials. Producer namespaces come from reviewed database bindings, not an activity-namespace environment variable. Each namespace is permanently bound to one source family, including revoked bindings. Keep GitHub PR and branch bindings in the same reviewed namespace when their closures must refer to the same repository and branch. The configured source principal must match the binding. REST and MCP main entrypoints reject a bound producer context on their serving pool; use a distinct producer connection role. This is a startup check within the existing bounded transaction, not continuous monitoring of role bindings. Never bind a running serving role as a producer. Stop affected processes before changing bindings and restart with distinct serving and producer roles.

An adapter with no producer URL captures ordinary memories without attribution. An adapter with a configured producer URL fails closed when its binding is revoked, its principal or family no longer matches, or its role profile drifts: deliveries return `DEPENDENCY_UNAVAILABLE` rather than falling back to ordinary capture. A producer connection failure also prevents delivery. Stop affected intake, retain queued deliveries with unchanged identities and bytes, and deliberately repair/regrant/rebind the role or remove the producer configuration, then restart and verify it. Removing the producer URL intentionally resumes ordinary capture without attribution. Webhook sender retries are not guaranteed; review the sender's retained delivery history before deliberate replay.

Attribution and authenticated capture commit in the same delivery transaction; a failure rolls back that delivery. Duplicate delivery identities keep the existing ingestion behavior.

## Operator configuration

First establish approved personal ownership with the existing `map-user-scope` workflow in [offboarding](./offboarding.md). Grant producer roles the reviewed APP profile and bind an OP LOGIN to its current manual org administrator using the existing grant scripts. Use that actual operator connection with the trusted application-only search path. Do not run these examples through the serving APP URL or substitute a passed administrator UUID for bound operator authority.

The following psql calls illustrate the two narrow, audited configuration routines. Supply variables through a protected operator process, not committed credentials:

```sql
SELECT continuum_operator_bind_standup_producer(
  :'admin_uuid'::uuid, :'producer_role'::name, :'service_uuid'::uuid,
  :'namespace'::text, 'github'::text);

SELECT continuum_operator_map_standup_actor(
  :'admin_uuid'::uuid, :'namespace'::text, :'github_numeric_actor_id'::text,
  :'user_uuid'::uuid, 'Reviewed numeric identity mapping'::text);
```

Namespaces match `^[a-z][a-z0-9.-]{0,99}$`; external identities are 1 through 200 characters and reasons 1 through 500. The database stores a namespace-scoped identity hash rather than the raw external identity. Only enabled users can be mapping targets. A replacement revokes the old mapping and creates a new immutable generation. Events predating the new generation are rejected. Omitted event time is accepted only for the first generation and must still be finite, not future, and at or after its creation.

Pass a NULL target UUID to `continuum_operator_map_standup_actor` to revoke a mapping. Pass a NULL service UUID to `continuum_operator_bind_standup_producer` to revoke a producer binding. Changing an active producer's principal, namespace or family requires revocation first. Revocation preserves history, and reconfiguration does not reactivate an old generation. Privileged role attributes or membership edges disable producer context and activity recording. Revocation uses the stored role identity even after drift or role removal; an absent active binding is an error. Grant/profile drift causes binding or startup validation to fail closed.

## Closure, expiry and promotion

Branch and session openers have canonical namespace-scoped hashed thread keys. Merged PRs and finished sessions record durable closure evidence. A PR branch closure uses the numeric head repository ID; a missing head repository closes only the PR artifact and never guesses the base branch. Closure is checked within the mapping generation before the digest window ends, so a delayed old opener cannot reopen a closed thread. Archiving the closing memory or losing access to its former scope does not remove that evidence. Receipt-relative moving time clamps are not used. Reused branch or session names cannot automatically reopen a closed thread without trusted incarnation evidence; receipt-only activity is conservatively treated as the existing thread.

Attribution retains the original source expiry ceiling. A legitimately nondecaying decision can start with no expiry and is still selected only within the requested activity window; finite context expiry is never converted into an unlimited cap. Verification and promotion cannot extend it, including by replacing expiry with NULL. Shortening expiry narrows the ceiling. Promotion copies attribution only when the destination is a canonical authorized copy with reciprocal lineage and matching trust. It strips `actor`, `actor_principal_id`, `thread_owner_principal_id`, `thread_key`, `closes_thread_keys`, `_continuum_activity_provenance`, `_continuum_activity_epoch_ms`, `_continuum_actor_mapping_id`, and `_continuum_actor_mapping_authority` from caller metadata. Stored attribution is separate from these fields.

Active attributed source content and provenance are immutable to ordinary APP writes. Lifecycle transitions and approved canonical tombstones remain possible, including a legitimately authorized offboarding administrator takeover.

## Erasure and rollout

Approved offboarding scrubs actor labels and mapping reasons, revokes active mappings and includes those physical predicates in completion proof. Batches process at most 1000 attributions and 1000 mappings. Locked residual rows keep completion incomplete; resume after normal release. Protected `principal_standup_privacy_repaired` receipts record bounded progress and cannot be forged by APP or OP raw INSERT or altered afterward. The external identity hash on erased subject mappings is replaced by an irreversible mapping marker. A separate owner-only namespace/hash generation counter retains no subject, mapping UUID or timestamp link; it prevents erased identities from being mistaken for first-generation activity after replacement. UUIDs, hashed thread keys, timestamps and closure evidence remain accounting records. Stored-state erasure does not erase copies already returned to clients, retained backups or downstream systems.

Before deploying a matching binary, back up the database and migration evidence, quiesce activity producers and offboarding processes, and migrate the complete packaged chain through 0090 under a finite external process deadline. The migration owner needs database TEMPORARY privilege for its role snapshot. Per-statement DDL limits are not a whole deployment deadline. Regrant exact APP and OP profiles using the existing scripts, configure reviewed bindings and actor mappings, and require the new binaries' exact-profile, coordination, outbox and Standup startup checks to pass before serving.

No historical caller JSON is automatically trusted or backfilled. Older unbound producers can capture ordinary memories without supplying trusted attribution. Keep incompatible processes stopped during schema work. Schema reversal requires a verified backup; a binary rollback cannot reconstruct omitted attribution or undo erasure. See [migration and role rollout](./offboarding.md) for the existing owner repair and regrant sequence.
