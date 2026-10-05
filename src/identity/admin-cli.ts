import { getPool } from '../storage/pool.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { issueApiKey, revokeApiKey, rotateApiKey } from '../services/api-keys.js';
import { provisionEntraGroupBinding, revokeEntraGroupBinding } from '../services/membership-sync.js';
import type { MembershipRole } from '../types.js';

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const actorExternalId = process.env.CONTINUUM_ADMIN_ACTOR?.trim() ?? '';
  if (!actorExternalId) throw new Error('CONTINUUM_ADMIN_ACTOR is required');
  const pool = getPool();
  try {
    const actor = await getPrincipalByExternalId(pool, actorExternalId);
    if (!actor) throw new Error('admin actor is unknown');
    if (operation === 'bind-group') {
      const [groupId, scopeId, bindingRole, displayName] = args;
      if (!groupId || !scopeId || !bindingRole) {
        throw new Error('usage: bind-group <group-id> <scope-id> <reader|writer|admin> [display-name]');
      }
      const result = await provisionEntraGroupBinding(pool, actor, {
        externalId: groupId, scopeId, role: bindingRole as MembershipRole, displayName,
      });
      process.stdout.write(`${JSON.stringify({ operation, groupId, ...result })}\n`);
    } else if (operation === 'revoke-group') {
      const [groupId] = args;
      if (!groupId) throw new Error('usage: revoke-group <group-id>');
      const revoked = await revokeEntraGroupBinding(pool, actor, groupId);
      process.stdout.write(`${JSON.stringify({ operation, groupId, revoked })}\n`);
    } else if (operation === 'issue-key') {
      const [serviceExternalId, allowedSource] = args;
      if (!serviceExternalId) throw new Error('usage: issue-key <service-external-id> [allowed-source]');
      const service = await getPrincipalByExternalId(pool, serviceExternalId);
      if (!service) throw new Error('service principal is unknown');
      process.stdout.write(`${JSON.stringify(await issueApiKey(pool, actor, service.id, allowedSource))}\n`);
    } else if (operation === 'rotate-key') {
      if (!args[0]) throw new Error('usage: rotate-key <key-id>');
      process.stdout.write(`${JSON.stringify(await rotateApiKey(pool, actor, args[0]))}\n`);
    } else if (operation === 'revoke-key') {
      if (!args[0]) throw new Error('usage: revoke-key <key-id>');
      await revokeApiKey(pool, actor, args[0]);
      process.stdout.write(`${JSON.stringify({ operation, keyId: args[0], revoked: true })}\n`);
    } else throw new Error('operation must be bind-group, revoke-group, issue-key, rotate-key, or revoke-key');
  } finally { await pool.end(); }
}

void main().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'continuum_admin_failed', message: 'operation failed' })}\n`);
  process.exitCode = 1;
});
