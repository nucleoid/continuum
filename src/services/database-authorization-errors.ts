import { ServiceError } from './errors.js';

interface DatabaseError {
  code?: string;
  message?: string;
}

function isUnclassifiedDatabaseError(error: unknown): error is DatabaseError {
  return !(error instanceof ServiceError) && typeof error === 'object' && error !== null;
}

export function isOperatorAuthorizationError(error: unknown): boolean {
  if (!isUnclassifiedDatabaseError(error)) return false;
  return error.code === '42501'
    || /^operation requires a (?:DB|role-name\/OID)-bound trusted approve identity$/i
      .test(error.message ?? '');
}

export function isSyncAuthorizationError(error: unknown): boolean {
  if (!isUnclassifiedDatabaseError(error)) return false;
  return error.code === '42501'
    || /^(?:operation requires a (?:DB|role-name\/OID)-bound trusted sync identity|membership sync identity is not eligible|sync verification rejects owner, superuser, or SET ROLE sessions)$/i
      .test(error.message ?? '');
}

export async function rollbackOrDestroy(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return false;
  } catch {
    return true;
  }
}
