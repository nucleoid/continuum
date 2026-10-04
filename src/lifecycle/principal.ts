import type { Principal } from '../types.js';

export const LIFECYCLE_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000011';

export function isLifecyclePrincipal(
  principal: Pick<Principal, 'id'>,
): boolean {
  return principal.id === LIFECYCLE_PRINCIPAL_ID;
}
