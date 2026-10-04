import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Principal, PrincipalKind } from '../types.js';
import type { Queryable } from './queryable.js';

export interface NewPrincipal {
  externalId: string;
  kind: PrincipalKind;
  displayName: string;
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
  const { rows } = await pool.query(
    `INSERT INTO principals (id, external_id, kind, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, external_id, kind, display_name, created_at`,
    [id, input.externalId, input.kind, input.displayName],
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
  const existing = await getPrincipalByExternalId(pool, input.externalId);
  if (existing) {
    if (existing.displayName === input.displayName) return existing;
    const { rows } = await pool.query(
      `UPDATE principals SET display_name = $2 WHERE id = $1
       RETURNING id, external_id, kind, display_name, created_at`,
      [existing.id, input.displayName],
    );
    return rowToPrincipal(rows[0]);
  }
  return createPrincipal(pool, input);
}
