# Container deployment

The container workflow builds and tests Linux amd64 on hosted GitHub runners. Deployment hosts import the tested immutable OCI archive and do not build images. The workflow publishes downloadable artifacts, not registry releases. An artifact is qualified only after its source tests, Windows checks and separate downloaded-image smoke job succeed. Read the smoke results and recorded evidence gaps before adoption; a build artifact alone is not deployment approval.

## Verify and import

Download both `continuum-linux-amd64-<source SHA>` and its matching smoke results from the same successful workflow run. Keep the archive, `SHA256SUMS`, source metadata, manifest/config digests and `runtime-assets.tgz` together. Before upgrading, retain both the current and previous verified artifact sets in operator-managed storage, including each host's `loaded-identity.json` and matching source-test and downloaded-image smoke receipts. CI artifacts expire after 14 days; that retention is not a backup or rollback policy. Use the helper scripts from that exact source checkout, with Node 22:

```sh
SOURCE_SHA=<reviewed-source-SHA> node scripts/container-artifact.mjs verify /private/artifact
```

The helper verifies source identity, OCI blob digests and every layer before import. Inspect the metadata to confirm the expected reviewed source SHA. Checksums protect transfer integrity; obtain artifacts through the authenticated workflow and verify the selected run independently. They are not a separate signing authority.

Import with an OCI-aware tool. An OCI archive is not a Docker archive. On a supported Linux host with the Docker daemon, the pinned Skopeo input used by CI can convert it:

```sh
# All mounts are private operator-owned directories.
docker run --rm \
  -v /private/artifact:/input:ro -v /private/import:/output \
  quay.io/skopeo/stable@sha256:ab4c269c9e2bd11affe2666b860fb651a15afec121c15986b052b02e09d86239 \
  copy --override-os linux --override-arch amd64 \
  oci-archive:/input/image.oci.tar docker-archive:/output/image.docker.tar:continuum:import-${SOURCE_SHA}
docker load --input /private/import/image.docker.tar
SOURCE_SHA=<reviewed-source-SHA> node scripts/container-artifact.mjs verify-loaded /private/artifact continuum:import-${SOURCE_SHA}
```

Set and export `SOURCE_SHA` to the approved exact source SHA before import. The helper verifies the loaded image by hashing its actual exported config bytes against the OCI config digest and checking the source label and platform. Set `CONTINUUM_APP_IMAGE` to `loaded-identity.json.imageId`, the immutable ID reported by that deployment daemon, after verification. Keep the temporary import tag out of production configuration. Classic Docker stores use a config digest as image ID; containerd stores can report a manifest digest. The OCI manifest digest, portable config digest and daemon image ID are distinct recorded values. Verify on each deployment host rather than assuming its image store matches CI. Registry use, publication, multi-platform support and PostgreSQL major upgrades need separate validation.

Extract the verified runtime asset archive into a new private directory. Its package root contains `deploy/`, `scripts/` and all published migrations. Set `CONTINUUM_RUNTIME_ASSETS` to that root. Never replace its SQL with an unrelated working directory. The maintenance wrapper accepts only the canonical `deploy/compose.production.yml` inside that verified asset root; local edits and alternate Compose files are refused. Before stopping any project writers, maintenance compares the host assets with the selected image's `/opt/continuum` package: `package.json`, `deploy/`, every migration and every public `scripts/*.sql` file must match exactly. An incomplete, extra or changed asset set is refused before downtime. Base inputs and actions are digest/commit pinned; CI normalizes source timestamps and compares uncached builds. Read measured reproducibility output rather than assuming byte equivalence across toolchain versions.

## Private configuration and authority

Copy the packaged `deploy/production.env.example` to a private configuration directory. Replace every empty value with approved installation inputs. Production Compose fixes authentication to Entra and requires its tenant, audience, allowed clients, user scope and service application role. It never creates an opaque development administrator. The approved first user is an explicit Entra object UUID, with a separate internal principal UUID and manual canonical organization administrator grant. A distinct dormant SYNC service identity is bound so the complete identity verifier can run. See [authentication](authentication.md) and [offboarding](offboarding.md).

The explicit private env file is authoritative for Compose interpolation. Docker child processes remove inherited `CONTINUUM_*`, `COMPOSE_*` and Compose interpolation controls from the operator shell, so another installation's shell settings cannot replace the reviewed project, image, volume, secret paths or identities. The wrapper separately reads its quiescence confirmation, backup output and deadline controls from the shell.

Choose a unique Compose project and new PostgreSQL volume. Never reuse an older development volume. The fresh-install wrapper refuses any already existing volume or project and preserves it for operator investigation.

Put database passwords and connection URLs in private files. File mounts must be readable by the actual container UID: application 10001, PostgreSQL/jobs 999. Give the dedicated host group only the access needed, keep directories private, and verify container readability before launch. Local Compose secret files are ordinary host files, not encrypted secret storage; Swarm secret ownership controls do not establish local file permissions. Do not put secret values in the `.env` example, command-line arguments, logs, image build arguments or source.

Use five distinct LOGIN roles: private initialization DBA, migration/schema owner, non-owner APP, actor-bound OP and service-bound SYNC. Only DBA provisioning mounts role passwords; migration mounts only the owner URL; owner grants/provisioning mount only owner credentials; serving mounts only APP URL. Operator and sync commands are separate one-shot processes with their own reviewed credentials. Do not pass DBA, owner or OP connections to API/MCP.

URLs must encode reserved password characters, use service host `postgres:5432`, and explicitly resolve only the application schema, for example `options=-csearch_path%3Dcontinuum`. Keep `pg_catalog` implicit. Do not set a role-level search path, grant schema CREATE to APP, or broaden provider PUBLIC ACLs to pass readiness. Migration-owner TEMPORARY and explicit narrow provider rights are required by the existing migration chain. The non-superuser migration owner also requires CREATEROLE and ADMIN OPTION on the exact managed SYNC role for the existing retirement contract, with SET FALSE and INHERIT FALSE. APP, OP and SYNC retain NOCREATEROLE. Keep the owner credential restricted to explicit maintenance; see [offboarding retirement authority](offboarding.md).

The container-only launcher supports `_FILE` for these exact existing settings:

- `CONTINUUM_DATABASE_URL`, `CONTINUUM_BEARER`, `CONTINUUM_PRINCIPAL_EXTERNAL_ID`, `CONTINUUM_TOKEN`.
- `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `CONTINUUM_EMBEDDING_CONFIG`. A key mapping does not add a provider adapter or make an unsupported provider available.
- `CONTINUUM_ADMIN_ACTOR`, `CONTINUUM_GRAPH_ACCESS_TOKEN`, `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, `CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID`.
- Each `CONTINUUM_INGEST_{GITHUB_PR,GITHUB_BRANCH,ADO_WORKITEM,DEPLOY_EVENT,TERMINAL_SUMMARY}_{PRINCIPAL,DATABASE_URL,ACTOR_EXTERNAL_ID}`; GitHub `SECRET`; ADO `USERNAME` and `PASSWORD`.

Each file must be a regular, non-symlink file directly under `/run/secrets`, at most 64 KiB, with nonempty UTF-8 content and no NUL. Names contain letters, numbers, dots, underscores or hyphens. The adapter removes one trailing LF, CRLF or CR, retaining meaningful spaces. Simultaneous environment and file settings fail even when the environment value is empty. Other settings use private environment injection through their existing contracts. Errors identify the setting without exposing its value.

## Explicit fresh installation

Use the extracted, verified public package from `runtime-assets.tgz` as `CONTINUUM_RUNTIME_ASSETS`, not a source checkout. The checkout contains tests and other files absent from the installed package, so its asset manifest must fail parity. Keep private configuration and secret files outside this verified asset directory; run helper scripts from the exact source checkout separately.

Import and verify the image and runtime assets first. Set the PostgreSQL input to the exact tested pgvector/PostgreSQL 16 digest recorded by CI. Review the private configuration and approved identities. From the exact checked source's helper scripts, run:

```sh
node scripts/container-maintenance.mjs fresh \
  /private/config/production.env /private/assets/deploy/compose.production.yml
```

The wrapper never builds or pulls images. It refuses a conflicting fresh volume, starts the private database, runs DBA bootstrap, migrates the complete packaged chain under a finite outer deadline, provisions the reviewed first admin, applies APP/OP/SYNC profiles and their complete identity verifier, then recreates API. Failure keeps serving stopped and retains the volume. DBA bootstrap and first-admin provisioning are fresh-only and deliberately fail on repeated execution. The role-profile script can converge on matching bindings, but the fresh wrapper refuses a retained project or volume rather than resuming partially completed installation. Use the failed-fresh procedure below; mismatched or foreign stored bindings fail before grants. Upgrades verify the retained OP/SYNC role names, OIDs, principals and authority flags against reviewed configuration before reapplying exact profiles. They do not rotate credentials or retarget bindings. Before downtime, upgrade also checks that OP remains an enabled user with active canonical organization `manual`/`manual` administrator membership and that SYNC remains an enabled service satisfying the existing installation and retirement eligibility rules. Ineligible identities are refused as `BINDING_INELIGIBLE`; changing the env file does not repair a binding. Use the separately approved recovery procedure below or the existing restore runbook before updating deployment inputs.

Set `CONTINUUM_MAINTENANCE_EVIDENCE_DIR` to an existing private operator-owned directory when needed. By default, fresh installation uses the private env file's directory and upgrade uses the backup output directory. Before downtime, the wrapper reserves a unique private failure-evidence file and verifies it can safely read the configured secret files for redaction. Failed bootstrap, migration, first-admin provisioning, grant verification or API start records the controlled phase, immutable image, selected budgets and bounded sanitized error lines, including available SQLSTATE and error details. The failure output identifies the evidence path. The file is created with mode 0600 and is limited to 64 KiB. Linux maintenance fsyncs the reservation and containing directory, the completed failure record and its directory, and successful reservation removal. A successful run removes its empty reservation; failed or interrupted runs retain their evidence. Directory durability depends on the host filesystem and is not verified by Windows source tests; on hosts without POSIX permission enforcement, protect it with equivalent host access controls. Inspect this evidence locally before sharing it, retain it with the migration ledger and execution receipts, and keep private configuration and backups separate. Known credential values, URLs, tokens and absolute host paths are scrubbed; sanitized evidence can still contain private database metadata, so it is not a public support report.

The complete maintenance sequence, not an old exited job or readiness response, permits serving. Do not bypass the wrapper by starting the `serving` profile directly. Database initialization must work under UID 999 with no capability or permission repair; hostile volume ownership fails safely.

### Failed fresh installation

Keep serving stopped and retain the failed project and volume while investigating. Record the exact Compose project, volume name, selected source SHA, loaded image identity and failed phase. Preserve private configuration, logs, migration ledger and execution evidence before considering disposal. Keep credentials private; evidence capture must not copy secret values into a support report.

An operator may approve discard only for a new isolated installation that never served or routed production traffic and contains no application or workload data beyond the reviewed installation-administrator and dormant SYNC seed metadata. Those seed UUIDs alone do not make failed-fresh recovery impossible. There must be no imported or captured data, queued producer work, deliveries or downstream effects. Apply this procedure through the operator's own change process:

1. Confirm those conditions from retained evidence, including that no production serving or routing was enabled. Stop all project and external processes and verify that no client or producer can reconnect.
2. Inspect the exact containers, their Compose ownership labels and mounts, and the exact named volume's ownership labels. Confirm that the PostgreSQL mount maps that volume to the configured PGDATA path, that its database belongs to this failed installation, and that no other container or installation uses it. Names alone are insufficient. Uncertain ownership or data history means preserve and investigate.
3. Retain a private backup, evidence and approved secret records outside that volume and obtain explicit operator approval identifying the exact failed project and volume to remove. Only the operator performs any approved removal. Do not use a blanket `down -v` command or remove resources selected by a name prefix.
4. Correct the diagnosed cause, choose a new unique project and a new volume, verify the artifact and assets again, and rerun `fresh`. Do not repurpose the old volume or bypass the wrapper.

This exception does not apply to an installation that served or contains production data. Preserve its volume, ledger and evidence and use reviewed forward recovery or a verified separate-volume restore.

API publishes no host port. PostgreSQL stays only on an internal backend network, with no host port or edge attachment. An approved TLS reverse proxy may join the edge network. Edge/TLS deployment is a separate operation. For a private operator test only, a separate reviewed override can map `127.0.0.1:4000:4000`; avoid a public bind.

## Commands and operating limits

The image defaults to `node dist/api/server.js`. Overrides support `continuum`, `continuum-tags`, `continuum-migrate`, API, stdio MCP, admin, membership sync, lifecycle sweep, audit retention and embedding backfill compiled entrypoints. They use the installed package and direct Node execution. Shell commands and arbitrary scripts are rejected by the launcher.

Stdio MCP is a per-client `docker run --rm -i` process without a TTY. Use the APP connection and appropriate bearer file, hardened read-only settings and private backend attachment. Keep stdout for protocol traffic and diagnostics on stderr. Container replacement ends current stdio sessions; clients reconnect with existing valid credentials. Remote MCP capability is conditional on its separate implementation and is reported unavailable when absent.

The initial defaults are full-text-only, with `CONTINUUM_EMBEDDING_PROVIDER=none`. Full-text capture/recall is not semantic validation. Optional provider diagnostics, provider-qualified 768-dimensional storage and local-only rules still apply. Regenerate and retest the artifact after adding a separately reviewed provider adapter.

Application containers use fixed UID 10001, read-only root, all capabilities dropped, no-new-privileges, init, PID limit 128, 512 MiB RAM and one CPU. `/tmp` is a bounded 64 MiB noexec/nosuid tmpfs. Node heap is 384 MiB; APP pool maximum is five, connection timeout five seconds and idle timeout ten seconds. PostgreSQL uses UID 999, one GiB RAM, one CPU, PID limit 256, 128 MiB shared memory, 50 connections, 128 MiB shared buffers and 4 MiB work memory. The named volume holds durable PGDATA. Log rotation uses three ten-MiB files. These are initial limits, not a capacity or latency promise; budget every replica and producer pool against database headroom.

Readiness uses `/health/ready` and a one-second database deadline. Liveness uses `/health/live`. Neither proves embedding provider health or repeats migration/profile verification. Compose health does not restart an unhealthy process. REST shutdown has a ten-second budget and a 15-second stop grace; bounded termination does not prove detached callbacks or downstream copies were erased. Commands that write output need a separately approved narrow writable mount, including Linux audit-retention export.

## Upgrade, backup, restore and rollback

Set `CONTINUUM_MAINTENANCE_DEADLINE_SECONDS` and `CONTINUUM_BACKUP_DEADLINE_SECONDS` explicitly for the approved window when needed. Each defaults to 900 seconds and is capped at 14400 seconds. Backup has its own budget; dumping the database does not consume the fresh or upgrade migration/grant budget. Maintenance output records the selected budgets in milliseconds as `deadlineMs` and `backupDeadlineMs`. A larger deadline does not change the migration's statement and lock limits.

Size both budgets from a rehearsal on a restored copy with representative current data, locks and resource limits. Measure backup and migration/grant durations separately and include operational margin. If the measured work cannot fit within the bounded window, keep serving stopped and plan reviewed recovery rather than repeatedly applying the same insufficient budget. Synthetic CI fixtures establish neither production-volume support nor a maintenance-time SLO.

An upgrade is a maintenance window, not a mixed-version rolling deployment. Stop all API/MCP, sync, activity, lifecycle, admin and maintenance producers, webhook intake, schedulers and callback consumers, including processes outside this Compose project. Confirm process exit for abort-ignoring callbacks. Preserve queued delivery identities and bytes. Select and verify the new compatible artifact before starting:

```sh
export CONTINUUM_QUIESCENCE_CONFIRMED=yes
export CONTINUUM_BACKUP_FILE=/private/backups/installation-before-upgrade.dump
node scripts/container-maintenance.mjs upgrade \
  /private/config/production.env /private/assets/deploy/compose.production.yml
```

The wrapper holds an exclusive private host lock at `~/.continuum-maintenance-locks/<project>.lock` throughout preflight, backup, migration, grants and API start. The lock is shared across env-file locations for that operator and project, in a private mode-0700 non-symlink directory with a mode-0600 exclusive file. It records a random ownership token, PID and selected project. A conflicting run is refused before it can stop containers or reserve backup outputs. Use one approved operator account and host for this Docker daemon and project, with one reviewed Docker endpoint/context throughout the window; this host lock does not coordinate different user accounts, hosts or contexts. A crash can leave a stale lock: preserve the lock record, confirm the owning wrapper is no longer running, verify no maintenance containers or owned database sessions remain, and have the operator remove only that exact lock after ownership review. Never delete a lock simply because its recorded PID is absent; hosts and PID reuse require independent confirmation.

Upgrade requires the retained PostgreSQL service already running for its read-only pre-stop OP/SYNC eligibility check. Start and verify that existing database separately if it is down; an unavailable check refuses before outputs or downtime. The current OP must remain an enabled user with active canonical manual org-admin membership, and SYNC must satisfy the published enabled-service and isolated-role retirement prerequisites. The wrapper validates immutable inputs and exact image/host asset parity before stopping project writers. For upgrade it also requires the existing volume's Compose project ownership label to match the selected project and every container mounting that volume to belong to that project, including stopped containers. A foreign or uncertain volume or consumer is refused before downtime. It reserves all new private backup output files and a unique private failure-evidence file before stopping project writers. After stopping them, its DBA check refuses any APP, OP, SYNC or owner session in the selected database, excluding the check's own session. This is a point-in-time check and does not prevent reconnection: operators must keep all external clients, producers and schedulers stopped throughout the window. Only then does the wrapper create custom-format database and password-free role-definition backups with checksums. It fsyncs all backup files and their directory and rechecks the persisted file hashes before migrations can commit. A durability or checksum failure keeps serving stopped. Backup subprocesses share the separate backup deadline; owned backend settlement has an additional bounded cleanup interval. Host filesystem fsync and rehash operations are synchronous and their duration depends on the filesystem and host I/O limits, so rehearse and budget them separately. Choose a durable private filesystem and retain an independently verified off-host copy. The wrapper then migrates and reapplies/verifies existing profiles before recreating API. It skips fresh bootstrap and first-admin provisioning. Keep DBA role definitions and provider/ledger/source provenance with the backup; checksum the backup and protect its retained personal data. Role credentials remain separate private operator records. The role dump uses `--no-role-passwords`; supply approved current passwords separately during restore. Resume schedulers and replay unchanged deliveries only after all gates succeed.

### Separately approved identity-binding recovery

An administrator handoff changes membership, not the OP database binding. Plan a separately approved binding change before demoting or disabling the currently bound administrator. If upgrade reports `BINDING_INELIGIBLE` or a deliberate rotation causes `BINDING_MISMATCH`, preserve the database and receipts; do not change env values until current bindings are explicitly repaired and verified. This recovery is an owner maintenance operation outside the fresh/upgrade wrapper, not permission to bypass its serving gate.

Quiesce all serving and external producers, identity/role administrators and maintenance jobs, confirm no wrapper holds the project lock, retain a private backup and review the exact database, role names/OIDs and replacement principal UUIDs. Use PostgreSQL 16 `psql` as the migration owner over an approved private connection with `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, a protected `PGPASSFILE` and an explicit application-only `PGOPTIONS` search path. Do not put the owner URL or password in command arguments. The following placeholders must be replaced with reviewed private values; `CONTINUUM_RUNTIME_ASSETS` is the already verified package root.

For OP, select an already existing enabled `user` with an active canonical organization administrator membership whose source is `manual`/`manual`. Use the dedicated non-owner OP LOGIN role, never APP or SYNC. Apply the existing exact profile, then the published owner registration script:

```sh
psql -X --set=ON_ERROR_STOP=1 \
  --set=continuum_schema='<application-schema>' \
  --set=continuum_app_role='<approved-operator-role>' \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-application-role.sql"
psql -X --set=ON_ERROR_STOP=1 \
  --set=continuum_schema='<application-schema>' \
  --set=continuum_operator_role='<approved-operator-role>' \
  --set=continuum_principal_id='<approved-manual-admin-uuid>' \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-operator-role.sql"
```

For SYNC, the replacement principal must be an existing enabled `service`. A changed binding requires a separately approved fresh LOGIN role with new credentials and the existing owner retirement authority. The installation script refuses terminal retired OIDs, restore-pending history, inappropriate membership edges, ownership or excess privileges; resolve those conditions through the existing [rotation and OID restore runbook](offboarding.md), not ad hoc registry edits. The published owner grant script installs the exact profile and retires the previous SYNC role; retirement clears its password and disables LOGIN, so independently settle any surviving old-role sessions. Reapplying the same eligible current role/principal is profile repair, not identity rotation.

```sh
psql -X --set=ON_ERROR_STOP=1 \
  --set=continuum_schema='<application-schema>' \
  --set=continuum_sync_role='<approved-active-or-new-sync-role>' \
  --set=continuum_principal_id='<approved-service-principal-uuid>' \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/grant-sync-role.sql"
```

After either change, verify all three profiles and current identity/retirement configuration with the published script:

```sh
psql -X --set=ON_ERROR_STOP=1 \
  --set=continuum_schema='<application-schema>' \
  --set=continuum_app_role='<application-role>' \
  --set=continuum_operator_role='<approved-current-operator-role>' \
  --set=continuum_sync_role='<approved-current-sync-role>' \
  --file="$CONTINUUM_RUNTIME_ASSETS/scripts/verify-database-identities.sql"
```

Retain the approved before/after role OIDs, principal UUIDs and private verification receipts. Reconnect under the dedicated bound identities and verify their existing approval or sync authority. Only then update the reviewed env file and applicable private connection files to describe those established bindings, and rerun the full upgrade wrapper with a new backup output. Do not create a new first administrator, reactivate a disabled principal, widen privileges, reuse a retired OID or manually alter identity registry rows as recovery shortcuts. For logical restore, use the separate existing OID rebind procedure first.

Test restore into a separate new volume before relying on a backup. Use the tested PostgreSQL 16 tools, reviewed role definitions, provider ownership, full ledger/execution evidence and [OID rebind runbook](offboarding.md), then reapply exact profiles and verify current runtime gates. Preserve the original volume. Restoring may reintroduce subject data erased since backup; reconcile privacy and downstream state before serving. CI's synthetic restore rehearsal is bounded evidence for its fixture, not a measured production recovery time.

Supervised migration, backup, grant and DBA helper connections use unique bounded maintenance application names. After failed or timed-out work, the wrapper terminates only the matching owned role/database/application-name backends and verifies their disappearance before releasing the project lock. Killing a Docker exec client alone does not stop its server-side process or prove locks have been released. If settlement fails, retain the failure evidence and keep serving stopped; do not retry until the exact owned sessions and jobs are independently settled.

For migration failure or deadline, it also stops the named client container. A lock wait or outer deadline can leave earlier forward migration phases committed. Keep applications stopped, preserve the volume and ledger/execution evidence, inspect the failure and retry the same compatible artifact. Never delete migration receipts, skip required backfill or give REST owner credentials to recover.

Rollback first quiesces new writers. Use binary-only rollback only for a demonstrated compatible artifact on the current schema. Unsupported historical binaries and in-place provider-key downgrade are rejected. Otherwise recover forward, or restore a verified pre-upgrade backup into a separate new volume with deliberate later-write, delivery, identity/OID and privacy reconciliation. Do not automatically downgrade schema, recreate volumes, erase ledgers, restore old credentials or run `down -v`. Packaging does not deploy to a live installation or operate on historical databases.
