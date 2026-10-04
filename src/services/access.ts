import type { MembershipRole, Scope, ScopeRef } from '../types.js';
import type { Queryable } from '../storage/queryable.js';
import { getScopesForPrincipal, hasRole } from '../storage/memberships.js';
import { getScopeByRef } from '../storage/scopes.js';

export interface AccessibleScope extends Scope {
  label: string;
  role: MembershipRole;
}

export async function accessibleScopes(
  queryable: Queryable,
  principalId: string,
): Promise<Map<string, AccessibleScope>> {
  const memberships = await getScopesForPrincipal(queryable, principalId);
  const accessible = new Map<string, AccessibleScope>();
  for (const scope of memberships) {
    accessible.set(scope.id, {
      ...scope,
      label: scope.kind === 'org' ? 'org' : `${scope.kind}:${scope.name}`,
    });
  }
  const org = await getScopeByRef(queryable, { kind: 'org', name: '' });
  if (org && !accessible.has(org.id)) {
    accessible.set(org.id, { ...org, label: 'org', role: 'reader' });
  }
  return accessible;
}

export async function canWriteScope(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  return hasRole(queryable, principalId, scopeId, 'writer');
}

export async function canWriteScopeForMutation(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  const { rows } = await queryable.query(
    `SELECT role
       FROM scope_memberships
      WHERE principal_id = $1 AND scope_id = $2
      FOR UPDATE`,
    [principalId, scopeId],
  );
  return rows[0]?.role === 'writer' || rows[0]?.role === 'admin';
}

export async function resolveReadableScopeIds(
  queryable: Queryable,
  principalId: string,
  refs?: readonly ScopeRef[],
): Promise<{ accessible: Map<string, AccessibleScope>; scopeIds: string[] }> {
  const accessible = await accessibleScopes(queryable, principalId);
  if (!refs?.length) return { accessible, scopeIds: [...accessible.keys()] };
  const ids: string[] = [];
  for (const ref of refs) {
    const scope = await getScopeByRef(queryable, ref);
    if (scope && accessible.has(scope.id)) ids.push(scope.id);
  }
  return { accessible, scopeIds: ids };
}
