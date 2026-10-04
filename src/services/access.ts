import type { ScopeRef } from '../types.js';
import type { Queryable } from '../storage/queryable.js';
import { getScopeByRef } from '../storage/scopes.js';
import { hasRole } from '../storage/memberships.js';
import { ServiceError } from './errors.js';
import {
  canMutateScope,
  canReadScope,
  canWriteScope,
  listReadableScopes,
  type ReadableScope,
} from '../scopes/access.js';

export { canReadScope, canWriteScope } from '../scopes/access.js';

export type AccessibleScope = ReadableScope;

export async function requireOrgAdmin(
  queryable: Queryable,
  principalId: string,
): Promise<void> {
  const org = await getScopeByRef(queryable, { kind: 'org', name: '' });
  if (!org || !await hasRole(queryable, principalId, org.id, 'admin')) {
    throw new ServiceError('FORBIDDEN', 'principal lacks admin role on org scope');
  }
}

export async function accessibleScopes(
  queryable: Queryable,
  principalId: string,
): Promise<Map<string, AccessibleScope>> {
  return listReadableScopes(queryable, principalId);
}

export async function canWriteScopeForMutation(
  queryable: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  return canMutateScope(queryable, principalId, scopeId);
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
    if (scope && await canReadScope(queryable, principalId, scope)) ids.push(scope.id);
  }
  return { accessible, scopeIds: ids };
}
