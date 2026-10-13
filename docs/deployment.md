# Container deployment

The container workflow builds and tests Linux amd64 on hosted GitHub runners. Deployment hosts import the tested immutable OCI archive and do not build images. The workflow publishes downloadable artifacts, not registry releases. An artifact is qualified only after its source tests, Windows checks and separate downloaded-image smoke job succeed. Read the smoke results and recorded evidence gaps before adoption; a build artifact alone is not deployment approval.

## Verify and import

Download both `continuum-linux-amd64-<source SHA>` and its matching smoke results from the same successful workflow run. Keep the archive, `SHA256SUMS`, source metadata, manifest/config digests and `runtime-assets.tgz` together. Use the helper scripts from that exact source checkout, with Node 22:

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

Extract the verified runtime asset archive into a new private directory. Its package root contains `deploy/`, `scripts/` and all published migrations. Set `CONTINUUM_RUNTIME_ASSETS` to that root. Never replace its SQL with an unrelated working directory. Base inputs and actions are digest/commit pinned; CI normalizes source timestamps and compares uncached builds. Read measured reproducibility output rather than assuming byte equivalence across toolchain versions.

## Private configuration and authority

Copy the packaged `deploy/production.env.example` to a private configuration directory. Replace every empty value with approved installation inputs. Production Compose fixes authentication to Entra and requires its tenant, audience, allowed clients, user scope and service application role. It never creates an opaque development administrator. The approved first user is an explicit Entra object UUID, with a separate internal principal UUID and manual canonical organization administrator grant. A distinct dormant SYNC service identity is bound so the complete identity verifier can run. See [authentication](authentication.md) and [offboarding](offboarding.md).

Choose a unique Compose project and new PostgreSQL volume. Never reuse an older development volume. The fresh-install wrapper refuses any already existing volume or project and preserves it for operator investigation.

Put database passwords and connection URLs in private files. File mounts must be readable by the actual container UID: application 10001, PostgreSQL/jobs 999. Give the dedicated host group only the access needed, keep directories private, and verify container readability before launch. Local Compose secret files are ordinary host files, not encrypted secret storage; Swarm secret ownership controls do not establish local file permissions. Do not put secret values in the `.env` example, command-line arguments, logs, image build arguments or source.

Use five distinct LOGIN roles: private initialization DBA, migration/schema owner, non-owner APP, actor-bound OP and service-bound SYNC. Only DBA provisioning mounts role passwords; migration mounts only the owner URL; owner grants/provisioning mount only owner credentials; serving mounts only APP URL. Operator and sync commands are separate one-shot processes with their own reviewed credentials. Do not pass DBA, owner or OP connections to API/MCP.

URLs must encode reserved password characters, use service host `postgres:5432`, and explicitly resolve only the application schema, for example `options=-csearch_path%3Dcontinuum`. Keep `pg_catalog` implicit. Do not set a role-level search path, grant schema CREATE to APP, or broaden provider PUBLIC ACLs to pass readiness. Migration-owner TEMPORARY and explicit narrow provider rights are required by the existing migration chain.

The container-only launcher supports `_FILE` for these exact existing settings:

- `CONTINUUM_DATABASE_URL`, `CONTINUUM_BEARER`, `CONTINUUM_PRINCIPAL_EXTERNAL_ID`, `CONTINUUM_TOKEN`.
- `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, `CONTINUUM_EMBEDDING_CONFIG`. A key mapping does not add a provider adapter or make an unsupported provider available.
- `CONTINUUM_ADMIN_ACTOR`, `CONTINUUM_GRAPH_ACCESS_TOKEN`, `CONTINUUM_MEMBERSHIP_SYNC_ACTOR`, `CONTINUUM_AUDIT_RETENTION_PRINCIPAL_EXTERNAL_ID`.
- Each `CONTINUUM_INGEST_{GITHUB_PR,GITHUB_BRANCH,ADO_WORKITEM,DEPLOY_EVENT,TERMINAL_SUMMARY}_{PRINCIPAL,DATABASE_URL,ACTOR_EXTERNAL_ID}`; GitHub `SECRET`; ADO `USERNAME` and `PASSWORD`.

Each file must be a regular, non-symlink file directly under `/run/secrets`, at most 64 KiB, with nonempty UTF-8 content and no NUL. Names contain letters, numbers, dots, underscores or hyphens. The adapter removes one trailing LF, CRLF or CR, retaining meaningful spaces. Simultaneous environment and file settings fail even when the environment value is empty. Other settings use private environment injection through their existing contracts. Errors identify the setting without exposing its value.

## Explicit fresh installation

Import and verify the image and runtime assets first. Set the PostgreSQL input to the exact tested pgvector/PostgreSQL 16 digest recorded by CI. Review the private configuration and approved identities. From the exact checked source's helper scripts, run:

```sh
node scripts/container-maintenance.mjs fresh \
  /private/config/production.env /private/assets/deploy/compose.production.yml
```

The wrapper never builds or pulls images. It refuses a conflicting fresh volume, starts the private database, runs DBA bootstrap, migrates the complete packaged chain under a finite outer deadline, provisions the reviewed first admin, applies APP/OP/SYNC profiles and their complete identity verifier, then recreates API. Failure keeps serving stopped and retains the volume. DBA bootstrap and first-admin provisioning are fresh-only and deliberately fail on repeated execution. Correct role-profile maintenance can converge on retry; mismatched or foreign stored bindings fail before grants. Upgrades verify the retained OP/SYNC role names, OIDs, principals and authority flags against reviewed configuration before reapplying exact profiles. They do not rotate credentials or retarget bindings. A separately approved identity rotation or restore must establish current bindings before updating deployment inputs.

The complete maintenance sequence, not an old exited job or readiness response, permits serving. Do not bypass the wrapper by starting the `serving` profile directly. Database initialization must work under UID 999 with no capability or permission repair; hostile volume ownership fails safely.

API publishes no host port. PostgreSQL stays only on an internal backend network, with no host port or edge attachment. An approved TLS reverse proxy may join the edge network. Edge/TLS deployment is a separate operation. For a private operator test only, a separate reviewed override can map `127.0.0.1:4000:4000`; avoid a public bind.

## Commands and operating limits

The image defaults to `node dist/api/server.js`. Overrides support `continuum`, `continuum-tags`, `continuum-migrate`, API, stdio MCP, admin, membership sync, lifecycle sweep, audit retention and embedding backfill compiled entrypoints. They use the installed package and direct Node execution. Shell commands and arbitrary scripts are rejected by the launcher.

Stdio MCP is a per-client `docker run --rm -i` process without a TTY. Use the APP connection and appropriate bearer file, hardened read-only settings and private backend attachment. Keep stdout for protocol traffic and diagnostics on stderr. Container replacement ends current stdio sessions; clients reconnect with existing valid credentials. Remote MCP capability is conditional on its separate implementation and is reported unavailable when absent.

The initial defaults are full-text-only, with `CONTINUUM_EMBEDDING_PROVIDER=none`. Full-text capture/recall is not semantic validation. Optional provider diagnostics, provider-qualified 768-dimensional storage and local-only rules still apply. Regenerate and retest the artifact after adding a separately reviewed provider adapter.

Application containers use fixed UID 10001, read-only root, all capabilities dropped, no-new-privileges, init, PID limit 128, 512 MiB RAM and one CPU. `/tmp` is a bounded 64 MiB noexec/nosuid tmpfs. Node heap is 384 MiB; APP pool maximum is five, connection timeout five seconds and idle timeout ten seconds. PostgreSQL uses UID 999, one GiB RAM, one CPU, PID limit 256, 128 MiB shared memory, 50 connections, 128 MiB shared buffers and 4 MiB work memory. The named volume holds durable PGDATA. Log rotation uses three ten-MiB files. These are initial limits, not a capacity or latency promise; budget every replica and producer pool against database headroom.

Readiness uses `/health/ready` and a one-second database deadline. Liveness uses `/health/live`. Neither proves embedding provider health or repeats migration/profile verification. Compose health does not restart an unhealthy process. REST shutdown has a ten-second budget and a 15-second stop grace; bounded termination does not prove detached callbacks or downstream copies were erased. Commands that write output need a separately approved narrow writable mount, including Linux audit-retention export.

## Upgrade, backup, restore and rollback

An upgrade is a maintenance window, not a mixed-version rolling deployment. Stop all API/MCP, sync, activity, lifecycle, admin and maintenance producers, webhook intake, schedulers and callback consumers, including processes outside this Compose project. Confirm process exit for abort-ignoring callbacks. Preserve queued delivery identities and bytes. Select and verify the new compatible artifact before starting:

```sh
export CONTINUUM_QUIESCENCE_CONFIRMED=yes
export CONTINUUM_BACKUP_FILE=/private/backups/installation-before-upgrade.dump
node scripts/container-maintenance.mjs upgrade \
  /private/config/production.env /private/assets/deploy/compose.production.yml
```

The wrapper validates immutable inputs and reserves all new private backup output files before stopping project writers, then creates custom-format database and password-free role-definition backups with checksums, migrates and reapplies/verifies existing profiles, then recreates API. It skips fresh bootstrap and first-admin provisioning. Keep DBA role definitions and provider/ledger/source provenance with the backup; checksum the backup and protect its retained personal data. Role credentials remain separate private operator records. The role dump uses `--no-role-passwords`; supply approved current passwords separately during restore. Resume schedulers and replay unchanged deliveries only after all gates succeed.

Test restore into a separate new volume before relying on a backup. Use the tested PostgreSQL 16 tools, reviewed role definitions, provider ownership, full ledger/execution evidence and [OID rebind runbook](offboarding.md), then reapply exact profiles and verify current runtime gates. Preserve the original volume. Restoring may reintroduce subject data erased since backup; reconcile privacy and downstream state before serving. CI's synthetic restore rehearsal is bounded evidence for its fixture, not a measured production recovery time.

Supervised migration connections use a unique bounded maintenance application name. On failure or deadline the wrapper stops its named client container, asks the DBA to terminate only matching owner/database backends and checks that they have disappeared. If settlement cannot be verified, keep serving stopped and investigate; a killed client alone does not prove database work stopped. A lock wait or outer deadline can leave earlier forward migration phases committed. Keep applications stopped, preserve the volume and ledger/execution evidence, inspect the failure and retry the same compatible artifact. Never delete migration receipts, skip required backfill or give REST owner credentials to recover.

Rollback first quiesces new writers. Use binary-only rollback only for a demonstrated compatible artifact on the current schema. Unsupported historical binaries and in-place provider-key downgrade are rejected. Otherwise recover forward, or restore a verified pre-upgrade backup into a separate new volume with deliberate later-write, delivery, identity/OID and privacy reconciliation. Do not automatically downgrade schema, recreate volumes, erase ledgers, restore old credentials or run `down -v`. Packaging does not deploy to a live installation or operate on historical databases.
