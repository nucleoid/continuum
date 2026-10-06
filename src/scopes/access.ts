import type { MembershipRole, Scope } from '../types.js';
import type { Queryable } from '../storage/queryable.js';
import { getScopesForPrincipal, hasRole } from '../storage/memberships.js';
import { getScopeByRef } from '../storage/scopes.js';

type AccessScope = Pick<Scope, 'id' | 'kind'>;

export interface ReadableScope extends Scope {
  label: string;
  role: MembershipRole;
}

export async function canReadScope(
  queryable: Queryable,
  principalId: string,
  scope: AccessScope,
): Promise<boolean> {
  const active = await queryable.query(
    'SELECT 1 FROM principals WHERE id = $1 AND disabled_at IS NULL', [principalId],
  );
  if (!active.rowCount) return false;
  return scope.kind === 'org'
    || hasRole(queryable, principalId, scope.id, 'reader');
}

export async function canMutateScope(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  return hasExplicitRoleForMutation(queryable, principalId, scopeId, 'writer');
}

export async function canWriteScope(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  return hasRole(queryable, principalId, scopeId, 'writer');
}

export async function listReadableScopes(
  queryable: Queryable,
  principalId: string,
): Promise<Map<string, ReadableScope>> {
  const memberships = await getScopesForPrincipal(queryable, principalId);
  const readable = new Map<string, ReadableScope>();
  for (const scope of memberships) {
    readable.set(scope.id, {
      ...scope,
      label: scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`,
    });
  }
  const org = await getScopeByRef(queryable, { kind: 'org', name: '' });
  if (org && await canReadScope(queryable, principalId, org) && !readable.has(org.id)) {
    readable.set(org.id, { ...org, label: 'org', role: 'reader' });
  }
  return readable;
}

export async function hasExplicitRoleForMutation(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
  required: MembershipRole,
): Promise<boolean> {
  const { rows } = await queryable.query(
    `SELECT m.role
       FROM scope_memberships m JOIN principals p ON p.id = m.principal_id
      WHERE m.principal_id = $1 AND m.scope_id = $2 AND m.active
        AND p.disabled_at IS NULL
        AND continuum_membership_is_effective(m.active, m.source_kind)
      ORDER BY CASE m.role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END DESC
      FOR UPDATE`,
    [principalId, scopeId],
  );
  const role = rows[0]?.role as MembershipRole | undefined;
  if (!role) return false;
  if (required === 'reader') return true;
  if (required === 'writer') return role === 'writer' || role === 'admin';
  return role === 'admin';
}
