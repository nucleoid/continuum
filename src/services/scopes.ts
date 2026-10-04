import type pg from 'pg';
import type { Principal, ScopeRef } from '../types.js';
import { parseScopeString as parseScopeModel } from '../scopes/model.js';
import { hasExplicitRoleForMutation } from '../scopes/access.js';
import { record } from '../audit/log.js';
import { getOrCreateScope, getScopeByRef } from '../storage/scopes.js';
import { asServiceError, dependencyUnavailable, ServiceError } from './errors.js';

export function validateScopeRef(ref: ScopeRef): ScopeRef {
  if (ref.kind === 'org' ? ref.name !== '' : ref.name.length === 0) {
    throw new ServiceError('INVALID_SCOPE', 'Invalid scope');
  }
  return ref;
}

export function parseScopeString(value: string): ScopeRef {
  try {
    return validateScopeRef(parseScopeModel(value));
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INVALID_SCOPE', 'Invalid scope', { cause: error });
  }
}

export async function ensureScopeForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  ref: ScopeRef,
  auditMetadata: Record<string, unknown> = {},
): Promise<{ scope: Awaited<ReturnType<typeof getOrCreateScope>>['scope']; created: boolean }> {
  try {
    validateScopeRef(ref);
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw dependencyUnavailable(error);
    }
    let destroyClient = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const org = await getScopeByRef(client, { kind: 'org', name: '' });
      if (!org) throw new ServiceError('INTERNAL', 'An internal error occurred');
      const authorized = await hasExplicitRoleForMutation(
        client,
        principal.id,
        org.id,
        'admin',
      );
      if (!authorized) {
        throw new ServiceError(
          'FORBIDDEN',
          'principal lacks admin role on org scope',
        );
      }

      const result = await getOrCreateScope(client, ref);
      await record(client, {
        principalId: principal.id,
        action: 'write',
        scopeId: result.scope.id,
        metadata: {
          ...auditMetadata,
          operation: 'create_scope',
          created: result.created,
          kind: ref.kind,
          name: ref.name,
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
      throw error;
    } finally {
      client.release(destroyClient);
    }
  } catch (error) {
    throw asServiceError(error);
  }
}
