import type pg from 'pg';
import type { Principal, ScopeRef } from '../types.js';
import { parseScopeString as parseScopeModel } from '../scopes/model.js';
import { hasExplicitRoleForMutation } from '../scopes/access.js';
import { record } from '../audit/log.js';
import { ensureScopeRow, getScopeByRef } from '../storage/scopes.js';
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
  ownerPrincipalId?: string,
): Promise<Awaited<ReturnType<typeof ensureScopeRow>>> {
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

      if (ref.kind === 'user' && !ownerPrincipalId) {
        throw new ServiceError('INVALID_INPUT', 'User scope owner_principal_id is required');
      }
      if (ref.kind !== 'user' && ownerPrincipalId) {
        throw new ServiceError('INVALID_INPUT', 'Only user scopes can have an owner principal');
      }
      if (ownerPrincipalId) {
        const owner = await client.query(
          'SELECT kind FROM principals WHERE id = $1 FOR UPDATE',
          [ownerPrincipalId],
        );
        if (owner.rows[0]?.kind !== 'user') {
          throw new ServiceError('INVALID_INPUT', 'User scope owner must be a user principal');
        }
        const existingOwner = await client.query(
          'SELECT kind, name FROM scopes WHERE owner_principal_id = $1 FOR UPDATE',
          [ownerPrincipalId],
        );
        if (existingOwner.rows[0]
            && (existingOwner.rows[0].kind !== ref.kind || existingOwner.rows[0].name !== ref.name)) {
          throw new ServiceError('CONFLICT', 'User principal already owns a user scope');
        }
      }
      const result = await ensureScopeRow(client, ref, ownerPrincipalId ?? null);
      if (ref.kind === 'user' && result.scope.ownerPrincipalId !== ownerPrincipalId) {
        throw new ServiceError('CONFLICT', 'User scope ownership does not match');
      }
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
          owner_principal_id: ownerPrincipalId ?? null,
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
