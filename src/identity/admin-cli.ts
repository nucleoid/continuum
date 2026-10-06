import { getPool } from '../storage/pool.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { issueApiKey, revokeApiKey, rotateApiKey } from '../services/api-keys.js';
import { provisionEntraGroupBinding, revokeEntraGroupBinding } from '../services/membership-sync.js';
import {
  disablePrincipal, provisionServicePrincipal, reactivatePrincipal,
} from '../services/principal-admin.js';
import type { MembershipRole } from '../types.js';
import { cliFailure } from './cli-errors.js';
import { mapOwnedUserScope, offboardPrincipal } from '../services/offboarding.js';

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
    } else if (operation === 'provision-service') {
      const [externalId, ...displayNameParts] = args;
      const displayName = displayNameParts.join(' ');
      if (!externalId || !displayName) {
        throw new Error('usage: provision-service <entra-object-id> <display-name>');
      }
      const principal = await provisionServicePrincipal(pool, actor, externalId, displayName);
      process.stdout.write(`${JSON.stringify({ operation, principal })}\n`);
    } else if (operation === 'disable-principal') {
      if (!args[0]) throw new Error('usage: disable-principal <principal-id>');
      await disablePrincipal(pool, actor, args[0]);
      process.stdout.write(`${JSON.stringify({ operation, principalId: args[0] })}\n`);
    } else if (operation === 'reactivate-principal') {
      if (!args[0]) throw new Error('usage: reactivate-principal <principal-id>');
      await reactivatePrincipal(pool, actor, args[0]);
      process.stdout.write(`${JSON.stringify({ operation, principalId: args[0] })}\n`);
    } else if (operation === 'map-user-scope') {
      const positional = args.filter((value) => value !== '--allow-other-active-members');
      const [principalId, scopeId] = positional;
      if (!principalId || !scopeId || positional.length !== 2
        || args.some((value) => value.startsWith('--') && value !== '--allow-other-active-members')) {
        throw new Error('usage: map-user-scope <principal-id> <user-scope-id> [--allow-other-active-members]');
      }
      process.stdout.write(`${JSON.stringify({
        operation,
        ...await mapOwnedUserScope(
          pool, actor, principalId, scopeId, args.includes('--allow-other-active-members'),
        ),
      })}\n`);
    } else if (operation === 'offboard-principal') {
      const positional = args.filter((value) => value !== '--dry-run');
      if (!positional[0] || positional.length !== 1 || args.some((value) => value.startsWith('--') && value !== '--dry-run')) {
        throw new Error('usage: offboard-principal <principal-id> [--dry-run]');
      }
      process.stdout.write(`${JSON.stringify({ operation, ...await offboardPrincipal(pool, actor, positional[0], args.includes('--dry-run')) })}\n`);
    } else throw new Error('unknown admin operation');
  } finally { await pool.end(); }
}

void main().catch((error) => {
  process.stderr.write(`${cliFailure('continuum_admin_failed', error)}\n`);
  process.exitCode = 1;
});
