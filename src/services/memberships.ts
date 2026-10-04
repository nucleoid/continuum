import type pg from 'pg';
import type { MembershipRole, Principal } from '../types.js';
import { record } from '../audit/log.js';
import { addMembership, removeMembership } from '../storage/memberships.js';
import { getPrincipal } from '../storage/principals.js';
import { getScope, getScopeByRef } from '../storage/scopes.js';
import { hasExplicitRoleForMutation } from '../scopes/access.js';
import { asServiceError, ServiceError } from './errors.js';

export async function changeMembershipForPrincipal(
  pool: pg.Pool,
  actor: Principal,
  scopeId: string,
  principalId: string,
  role: MembershipRole | null,
): Promise<{ removed: boolean; role: MembershipRole | null }> {
  let client: pg.PoolClient | undefined;
  let destroy = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const org = await getScopeByRef(client, { kind: 'org', name: '' });
    const isAdmin = org
      ? await hasExplicitRoleForMutation(client, actor.id, org.id, 'admin')
      : false;
    if (!isAdmin) throw new ServiceError('FORBIDDEN', 'principal lacks admin role on org scope');
    const scope = await getScope(client, scopeId);
    const target = await getPrincipal(client, principalId);
    if (!scope) throw new ServiceError('SCOPE_NOT_FOUND', 'scope not found');
    if (!target) throw new ServiceError('INVALID_INPUT', 'principal not found');

    let removed = false;
    if (role === null) {
      removed = await removeMembership(client, principalId, scopeId);
    } else {
      await addMembership(client, principalId, scopeId, role);
    }
    await record(client, {
      principalId: actor.id,
      action: 'write',
      scopeId,
      metadata: {
        operation: role === null ? 'revoke_membership' : 'grant_membership',
        target_principal_id: principalId,
        role,
        removed,
        transport: 'rest',
      },
    });
    await client.query('COMMIT');
    return { removed, role };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
    }
    throw asServiceError(error);
  } finally {
    client?.release(destroy);
  }
}
