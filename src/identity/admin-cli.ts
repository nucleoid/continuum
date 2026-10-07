import { getPool } from '../storage/pool.js';
import { getPrincipalByExternalId } from '../storage/principals.js';
import { issueApiKey, revokeApiKey, rotateApiKey } from '../services/api-keys.js';
import { provisionEntraGroupBinding, revokeEntraGroupBinding } from '../services/membership-sync.js';
import {
  disablePrincipal, provisionServicePrincipal, reactivatePrincipal,
} from '../services/principal-admin.js';
import type { MembershipRole } from '../types.js';
import { cliFailure } from './cli-errors.js';
import {
  listCoordinationPrivacyRepairs, listIncompleteOffboardingRuns, mapOwnedUserScope,
  offboardPrincipal, repairCoordinationPrivacy,
} from '../services/offboarding.js';

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
      const dryRun = args.includes('--dry-run');
      const once = args.includes('--once');
      const confirmIndex = args.indexOf('--confirm-scope');
      const confirmationScopeId = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
      const batchIndex = args.indexOf('--batch-size');
      const batchText = batchIndex >= 0 ? args[batchIndex + 1] : undefined;
      const batchSize = batchText === undefined ? undefined : Number(batchText);
      const verificationIndex = args.indexOf('--verification-timeout-ms');
      const verificationText = verificationIndex >= 0 ? args[verificationIndex + 1] : undefined;
      const verificationTimeoutMs = verificationText === undefined
        ? undefined : Number(verificationText);
      const consumed = new Set<number>();
      if (dryRun) consumed.add(args.indexOf('--dry-run'));
      if (once) consumed.add(args.indexOf('--once'));
      if (confirmIndex >= 0) { consumed.add(confirmIndex); consumed.add(confirmIndex + 1); }
      if (batchIndex >= 0) { consumed.add(batchIndex); consumed.add(batchIndex + 1); }
      if (verificationIndex >= 0) {
        consumed.add(verificationIndex); consumed.add(verificationIndex + 1);
      }
      const positional = args.filter((_value, index) => !consumed.has(index));
      if (!positional[0] || positional.length !== 1
        || (!dryRun && !confirmationScopeId)
        || (dryRun && confirmIndex >= 0)
        || (batchIndex >= 0 && (!Number.isInteger(batchSize)
          || (batchSize ?? 0) < 1 || (batchSize ?? 0) > 5_000))
        || (verificationIndex >= 0 && (!Number.isInteger(verificationTimeoutMs)
          || (verificationTimeoutMs ?? 0) < 1 || (verificationTimeoutMs ?? 0) > 300_000))
        || args.some((value, index) => value.startsWith('--') && !consumed.has(index))) {
        throw new Error('usage: offboard-principal <principal-id> (--dry-run | --confirm-scope <user-scope-id>) [--batch-size <1-5000>] [--verification-timeout-ms <1-300000>] [--once]');
      }
      let result = await offboardPrincipal(pool, actor, positional[0], {
        dryRun, confirmationScopeId, batchSize, verificationTimeoutMs,
      });
      while (!dryRun && !once && !result.complete) {
        result = await offboardPrincipal(pool, actor, positional[0], {
          dryRun: false, confirmationScopeId, batchSize, verificationTimeoutMs,
        });
      }
      process.stdout.write(`${JSON.stringify({
        operation,
        ...result,
      })}\n`);
    } else if (operation === 'list-incomplete-offboarding') {
      if (args.length) throw new Error('usage: list-incomplete-offboarding');
      process.stdout.write(`${JSON.stringify({
        operation, runs: await listIncompleteOffboardingRuns(pool, actor),
      })}\n`);
    } else if (operation === 'list-coordination-privacy-repairs') {
      const limitIndex = args.indexOf('--limit');
      const limitText = limitIndex >= 0 ? args[limitIndex + 1] : undefined;
      const limit = limitText === undefined ? undefined : Number(limitText);
      if ((limitIndex < 0 && args.length)
        || (limitIndex >= 0 && (args.length !== 2 || !Number.isInteger(limit)
          || (limit ?? 0) < 1 || (limit ?? 0) > 1_000))) {
        throw new Error('usage: list-coordination-privacy-repairs [--limit <1-1000>]');
      }
      process.stdout.write(`${JSON.stringify({
        operation, repairs: await listCoordinationPrivacyRepairs(pool, actor, limit),
      })}\n`);
    } else if (operation === 'repair-coordination-privacy') {
      const once = args.includes('--once');
      const confirmIndex = args.indexOf('--confirm-scope');
      const confirmationScopeId = confirmIndex >= 0 ? args[confirmIndex + 1] : undefined;
      const batchIndex = args.indexOf('--batch-size');
      const batchText = batchIndex >= 0 ? args[batchIndex + 1] : undefined;
      const batchSize = batchText === undefined ? undefined : Number(batchText);
      const consumed = new Set<number>();
      if (once) consumed.add(args.indexOf('--once'));
      if (confirmIndex >= 0) { consumed.add(confirmIndex); consumed.add(confirmIndex + 1); }
      if (batchIndex >= 0) { consumed.add(batchIndex); consumed.add(batchIndex + 1); }
      const positional = args.filter((_value, index) => !consumed.has(index));
      if (!positional[0] || positional.length !== 1 || !confirmationScopeId
        || (batchIndex >= 0 && (!Number.isInteger(batchSize)
          || (batchSize ?? 0) < 1 || (batchSize ?? 0) > 5_000))
        || args.some((value, index) => value.startsWith('--') && !consumed.has(index))) {
        throw new Error('usage: repair-coordination-privacy <principal-id> --confirm-scope <user-scope-id> [--batch-size <1-5000>] [--once]');
      }
      let result = await repairCoordinationPrivacy(pool, actor, positional[0], {
        confirmationScopeId, batchSize,
      });
      while (!once && !result.complete) {
        result = await repairCoordinationPrivacy(pool, actor, positional[0], {
          confirmationScopeId, batchSize,
        });
      }
      process.stdout.write(`${JSON.stringify({ operation, ...result })}\n`);
    } else throw new Error('unknown admin operation');
  } finally { await pool.end(); }
}

void main().catch((error) => {
  process.stderr.write(`${cliFailure('continuum_admin_failed', error)}\n`);
  process.exitCode = 1;
});
