# Webhook ingestion

Continuum exposes `POST /api/v0/ingest/:pluginId` for the five built-in capture
plugins. Every plugin is disabled by default. Enable only the plugins whose
service principal, credentials, target scopes, aliases, and writer memberships
have been provisioned.

## Authentication and delivery identity

- `github-pr` and `github-branch` verify `X-Hub-Signature-256` against the exact
  request bytes. They require `X-GitHub-Delivery`, but use the SHA-256 digest of
  the signed request bytes as the durable delivery identity because the
  delivery header is not covered by GitHub's signature. The accepted GitHub
  events are `pull_request` and `create`, respectively.
- `ado-workitem` accepts an Azure DevOps `workitem.updated` service-hook
  envelope using configured Basic credentials. The envelope `id` is the
  delivery identity and `resource` is passed to the capture plugin.
- `deploy-event` and `terminal-summary` use the existing bearer service token
  convention and require `Idempotency-Key`.

Each enabled plugin maps to one configured `service` principal. A bearer token
must resolve to that exact principal. Provider credentials never select the
principal. Every transformed target scope must already exist and the service
principal must have an explicit `writer` or `admin` membership.

GitHub branch actors and terminal actors are resolved through
`principal_aliases`. GitHub uses the immutable numeric user ID as the external
actor for provider `github`; the mutable login is retained only as display
metadata. Terminal summaries use provider `terminal`, including summaries with
an explicit scope override. The alias must point to a user principal, and that
principal's `external_id` is the default user scope name. Missing aliases and
scopes are rejected. Every selected scope, including an override, still
requires writer or admin access by the configured service principal. Ingestion
never creates scopes.

Offboarding preserves memories in shared scopes. Their stable author UUID and
source provenance remain, and GitHub-derived shared metadata can retain a
mutable GitHub login. This is the documented shared-memory identity exception;
personal-scope text, metadata, embeddings, and raw audit queries are still
erased by the offboarding workflow.

## Responses and replay

- `202`: a new delivery created one or more memories.
- `204`: a new valid delivery was intentionally ignored by its plugin.
- `200`: a completed delivery was replayed. The response contains the original
  memory IDs and `replayed: true`.
- `409`: a non-GitHub idempotency key was reused with different request bytes.

The delivery reservation, all memory writes, and all write audit rows commit in
one database transaction. A failed transform or capture leaves no reservation
or partial memory set. Embeddings run after commit as non-fatal derived work;
the vector and a new immutable derived-provenance audit row commit together.
The original capture audit row is never updated. The JSON body limit is 1 MiB,
and plugin schemas also bound strings and arrays.

All errors use the normal REST envelope and include `requestId`. Raw request
bodies, credentials, and webhook secrets are never logged.
