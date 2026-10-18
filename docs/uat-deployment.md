# Isolated persistent UAT

This runbook implements the deployment path for issue 20. A source change or passing CI is not a live deployment receipt. Installation requires the selected private host, a free owner-approved hostname/zone, approved Entra identity settings, and a successful exact-source container workflow. Keep private identifiers and credentials outside the repository and issue comments.

## Inventory and artifact gate

Refresh capacity, architecture, disk, Docker networks/routes, firewall behavior and critical workload health privately. Budget the fixed production caps plus 64 MiB/0.25 CPU for the proxy and 128 MiB/0.25 CPU for the tunnel. Account for the REST pool of five plus remote execution pool of five and authentication pool of two, every job and any external operator connection against PostgreSQL's 50 connections. Do not build images, run full tests or load models on deployment or home-agent hosts. If capacity is inadequate, stop rather than raise caps.

Follow [container deployment](deployment.md) to download both the successful exact-source immutable image and matching smoke evidence, verify checksums, manifest/config digest, source revision, platform and complete migration inventory, import through the reviewed OCI-aware path, verify the loaded image and extract runtime assets. Preserve prior artifacts for rollback. Install only a new uniquely named Compose project, private volume and private backend network. No historical database or memory import is part of UAT.

Use the canonical packaged production Compose and its maintenance wrapper for fresh installation and upgrades. Do not pass the UAT override to maintenance or edit verified package assets. The wrapper compares their bytes with the image. Keep operator/migration credentials out of serving processes. Complete all current migrations, contract repairs, exact role profiles and startup gates before exposing traffic.

## Private configuration

Create a protected operator directory outside source and extracted assets. Populate a private copy of `deploy/production.env.example`, then append the keys from `deploy/uat.env.example`. Complete real approved Entra settings even when clients use only service keys; do not invent a production API-key-only auth mode or use placeholder principal-ID authentication.

Select verified immutable nginx and cloudflared image digests for Linux amd64. Confirm the selected nginx build supports the real-IP module and runs with UID 101; confirm cloudflared's [token-file command](https://developers.cloudflare.com/tunnel/reference/run-parameters/) and UID 65532. Record upstream versions, digests and verification. Use only a dedicated tunnel token file. Secret files must be readable by their intended container UIDs and inaccessible to unrelated users. Compose secrets are host files, not encrypted storage.

Reserve separate fresh origin and ingress subnets after checking every Docker and host route. Assign static API/proxy addresses on origin and proxy/tunnel addresses on ingress; exclude them and each gateway from the configured dynamic allocation ranges. Set the canonical HTTPS `/mcp` URL and trust only the proxy's exact origin `/32`. Render `deploy/uat-proxy.conf.example` into private storage, replacing its documentation hostname and tunnel IP with the approved canonical hostname and reserved tunnel ingress IP. The proxy trusts `CF-Connecting-IP` only from that peer, rejects plain HTTP and wrong hosts, enforces pre-auth per-client rate/concurrency admission, disables access logging/buffering and forwards exactly one HTTPS proto header. It exposes only `/mcp` and the listed UAT REST resources; health and ingest paths return 404 externally. All five nginx temp directories use the bounded writable `/tmp`.

The overlay leaves production `backend` and `edge` unchanged. It adds private `uat_origin` between API and proxy, and `uat_ingress` between proxy and tunnel. The tunnel cannot reach API or PostgreSQL directly. Canonical maintenance may recreate API with its production-only networks; after maintenance, reapply the overlay to restore the UAT attachment and settings. Keep dedicated sidecars stopped during maintenance. Never delete or recreate existing networks as a configuration shortcut.

Create the new tunnel/hostname only after inspecting existing account tunnels, routes, DNS and Access policies. Require an absent hostname, snapshot the account records privately, and make additive changes only. Configure the dedicated tunnel route to `http://uat-proxy:8080` with the public canonical Host. Its final catch-all returns 404. Keep machine authentication working; no browser-only Access gate. The tunnel joins only UAT ingress; PostgreSQL joins only backend. No inbound firewall opening is required. Do not flush or replace firewall rules.

Preload the selected digest-pinned proxy and tunnel images, verify their platform and recorded identities, and retain their private receipts. Apply ingress only after canonical maintenance succeeds. The base full-text lane uses the two verified packaged files below. Start the API first and wait for health, verify its actual image ID equals the selected verified loaded image, validate/start the proxy, then start the tunnel:

```sh
# A private shell function avoids repeating the exact reviewed configuration.
uat_compose() {
  docker compose --env-file /private/config/uat.env \
    -f /private/assets/deploy/compose.production.yml \
    -f /private/assets/deploy/compose.uat.yml \
    --profile maintenance --profile serving --profile uat "$@"
}
uat_compose up -d --pull never --no-deps --wait --wait-timeout 60 api
# Privately inspect the API image ID, health and exact trusted peer setting here.
uat_compose run --rm --pull never --no-deps uat-proxy -t -c /etc/nginx/uat.conf
uat_compose up -d --pull never --no-deps uat-proxy
uat_compose up -d --pull never --no-deps uat-tunnel
```

For the explicitly approved semantic lane, add `-f /private/assets/deploy/compose.uat-gemini.yml` to that function after the ingress file, then run the same ordered steps. This requires the two private Gemini/routing secret files. Full-text-only ingress needs neither file and does not qualify semantic UAT. An API or image mismatch stops the sequence before the tunnel starts. Preserve the base/semantic distinction in the private receipt.

Inspect the resolved model privately first. Confirm immutable image IDs, caps, read-only roots, dropped capabilities, bounded tmpfs/logs, private secret mounts, subnet/peer identities and absence of host-published ports. Verify API readiness before starting proxy/tunnel and verify the proxy config with the selected nginx binary before routing traffic. Do not print `compose config` or container environment/command bodies into shared logs.

## Explicit semantic policy

The ingress overlay works in full-text-only mode without hosted credentials. Add `deploy/compose.uat-gemini.yml` explicitly for the selected semantic UAT policy; omitting it does not qualify semantic acceptance. Gemini is an optional text embedding adapter activated only through `CONTINUUM_EMBEDDING_CONFIG`. Inject `GEMINI_API_KEY` through the supported private file adapter. Keep synthetic inputs short and within the exact model token limit. An ambiguous rejected input pauses backfill as a provider failure; investigate it with the existing bounded operator workflow rather than retrying indefinitely. The model ID is mandatory and forms `gemini:<model>`; there is no automatic model substitution. Confirm the selected exact model supports synchronous batch embeddings and 768-dimensional output with the approved credential. A model outage or missing access remains provider-wide; it must not poison backfill memories as invalid input.

Put routing JSON in the private `embedding_config` secret. For example, with an explicitly selected model substituted for the placeholder:

```json
{
  "providers": [{ "alias": "uat", "kind": "gemini", "model": "gemini-CHOOSE-EXACT-MODEL", "dim": 768, "local": false, "timeout_ms": 10000, "batch_size": 16 }],
  "routing": { "default": "none", "rules": [
    { "match": { "kind": "project", "name": "synthetic-uat" }, "provider": "uat" },
    { "match": { "kind": "user" }, "provider": "local-only" }
  ] }
}
```

Only approved synthetic non-sensitive scope text may use the hosted route. Recall query text is shared with every selected provider, so UAT callers must use synthetic queries and explicitly select only the approved synthetic project; routing cannot infer whether a query is sensitive. All other scopes remain disabled or explicitly local-only. Missing local support never falls through to hosted. The generator remains deterministic SQL selection and makes no Gemini call. Full-text capture/recall does not qualify semantic UAT. Check `embedded:true` and recall metadata `diagnostics.vector:used`, matching model-qualified provider/dimension, a paraphrase fixture and a provider-outage/local-only negative test. Existing stored vectors are never imported.

## Acceptance and private receipt

Use [client onboarding](uat-client-onboarding.md) and [Delivery Forge UAT](delivery-forge-uat.md). Verify external HTTPS REST and MCP initialize/discovery/calls, missing/malformed/expired/revoked/rotated-old key rejection, session binding, current memberships, denied scopes and rate limits. Current APIs have distinct scope-error contracts. Verify sanitized operational logs and principal-limited audits without copying bodies or credentials.

Perform a controlled restart of only this project's API using the checkpoint/recover smoke phases. Memories, audits and fencing survive; MCP sessions do not. Confirm fresh initialization, health/live and health/ready, bounded database failure/recovery and all caps. Verify the actual tunnel cannot reach PostgreSQL and management/validator health is unchanged. Leave only the passing UAT project running for approved tests.

Private receipt fields: timestamp, approval reference, host inventory/headroom and workload baseline; source SHA; workflow run and smoke outcome; archive checksum; OCI manifest/config and loaded image ID; platform; migration names/checksums and readiness verification; exact project/volume/network ownership; selected model/provider/dimension and semantic results; tunnel/DNS record IDs; per-client principal/key IDs and expiry; credential delivery references; restart/persistence and client acceptance; rollback snapshots. Public results contain only sanitized capabilities/outcomes. Pending or failed criteria remain explicit.

## Recovery

Stop UAT dispatch, release owned leases while authorized or wait for TTL, then stop only the dedicated proxy/tunnel/API. Remove only the dedicated route/DNS objects created by this change after verifying IDs and concurrent changes. Preserve the database volume, private configuration, artifacts and evidence. Never use `down -v`, blanket container cleanup or network/firewall resets. Tunnel outage is not a reason to recreate data. Restore client routing through the inverse onboarding procedure. Resume after readiness, identity and private evidence checks pass; use the existing backup/forward-recovery runbook for database failure.
