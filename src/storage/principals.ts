import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal, PrincipalKind } from '../types.js';
import type { Queryable } from './queryable.js';

export interface NewPrincipal {
  externalId: string;
  kind: PrincipalKind;
  displayName: string;
}

export class PrincipalKindConflictError extends Error {
  constructor() {
    super('principal kind conflicts with established identity');
    this.name = 'PrincipalKindConflictError';
  }
}

const UUID_EXTERNAL_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function canonicalPrincipalExternalId(externalId: string): string {
  const trimmed = externalId.trim();
  return UUID_EXTERNAL_ID.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function rowToPrincipal(row: Record<string, unknown>): Principal {
  return {
    id: row.id as string,
    externalId: row.external_id as string,
    kind: row.kind as PrincipalKind,
    displayName: row.display_name as string,
    createdAt: row.created_at as Date,
  };
}

export async function createPrincipal(
  pool: pg.Pool,
  input: NewPrincipal,
): Promise<Principal> {
  const id = randomUUID();
  const externalId = canonicalPrincipalExternalId(input.externalId);
  const { rows } = await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, external_id, kind, display_name, created_at`,
    [id, externalId, input.kind, input.displayName],
  );
  return rowToPrincipal(rows[0]);
}

export async function getPrincipal(
  pool: Queryable,
  id: string,
): Promise<Principal | null> {
  const { rows } = await pool.query(
    `SELECT id, external_id, kind, display_name, created_at
       FROM principals WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToPrincipal(rows[0]) : null;
}

export async function getPrincipalByExternalId(
  pool: Queryable,
  externalId: string,
): Promise<Principal | null> {
  externalId = canonicalPrincipalExternalId(externalId);
  const { rows } = await pool.query(
    `SELECT id, external_id, kind, display_name, created_at
       FROM principals WHERE external_id = $1`,
    [externalId],
  );
  return rows[0] ? rowToPrincipal(rows[0]) : null;
}

export async function upsertPrincipalByExternalId(
  pool: pg.Pool,
  input: NewPrincipal,
): Promise<Principal> {
  const id = randomUUID();
  const externalId = canonicalPrincipalExternalId(input.externalId);
  const inserted = await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO NOTHING
     RETURNING id, external_id, kind, display_name, created_at`,
    [id, externalId, input.kind, input.displayName],
  );
  if (inserted.rows[0]) return rowToPrincipal(inserted.rows[0]);

  const existing = await getPrincipalByExternalId(pool, externalId);
  if (!existing || existing.kind !== input.kind) throw new PrincipalKindConflictError();
  if (existing.displayName === input.displayName) return existing;

  const { rows } = await pool.query(
    `UPDATE principals SET display_name = $2
      WHERE id = $1 AND kind = $3 AND display_name IS DISTINCT FROM $2
      RETURNING id, external_id, kind, display_name, created_at`,
    [existing.id, input.displayName, input.kind],
  );
  if (!rows[0]) {
    const current = await getPrincipal(pool, existing.id);
    if (!current || current.kind !== input.kind) throw new PrincipalKindConflictError();
    return current;
  }
  return rowToPrincipal(rows[0]);
}
