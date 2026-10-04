import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Scope, ScopeKind, ScopeRef } from '../types.js';
import type { Queryable } from './queryable.js';

function rowToScope(row: Record<string, unknown>): Scope {
  return {
    id: row.id as string,
    kind: row.kind as ScopeKind,
    name: row.name as string,
    createdAt: row.created_at as Date,
  };
}

export async function createScope(
  pool: Queryable,
  ref: ScopeRef,
): Promise<Scope> {
  if (ref.kind === 'org' && ref.name !== '') {
    throw new Error('org scope cannot have a name');
  }
  if (ref.kind !== 'org' && ref.name === '') {
    throw new Error(`Scope ${ref.kind} requires a name`);
  }
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO scopes (id, kind, name) VALUES ($1, $2, $3)
     RETURNING id, kind, name, created_at`,
    [id, ref.kind, ref.name],
  );
  return rowToScope(rows[0]);
}

export async function getScope(
  pool: Queryable,
  id: string,
): Promise<Scope | null> {
  const { rows } = await pool.query(
    `SELECT id, kind, name, created_at FROM scopes WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToScope(rows[0]) : null;
}

export async function getScopeByRef(
  pool: Queryable,
  ref: ScopeRef,
): Promise<Scope | null> {
  const { rows } = await pool.query(
    `SELECT id, kind, name, created_at FROM scopes WHERE kind = $1 AND name = $2`,
    [ref.kind, ref.name],
  );
  return rows[0] ? rowToScope(rows[0]) : null;
}

export async function getOrCreateScope(
  pool: Queryable,
  ref: ScopeRef,
): Promise<{ scope: Scope; created: boolean }> {
  if (ref.kind === 'org' && ref.name !== '') {
    throw new Error('org scope cannot have a name');
  }
  if (ref.kind !== 'org' && ref.name === '') {
    throw new Error(`Scope ${ref.kind} requires a name`);
  }

  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO scopes (id, kind, name) VALUES ($1, $2, $3)
     ON CONFLICT (kind, name) DO NOTHING
     RETURNING id, kind, name, created_at`,
    [id, ref.kind, ref.name],
  );
  if (rows[0]) return { scope: rowToScope(rows[0]), created: true };

  // This is a fresh statement, so under PostgreSQL READ COMMITTED it sees the
  // concurrent winner after ON CONFLICT has waited for that transaction.
  const existing = await getScopeByRef(pool, ref);
  if (!existing) throw new Error('scope conflict winner not found');
  return { scope: existing, created: false };
}

export async function listScopesByKind(
  pool: Queryable,
  kind: ScopeKind,
): Promise<Scope[]> {
  const { rows } = await pool.query(
    `SELECT id, kind, name, created_at FROM scopes WHERE kind = $1 ORDER BY name`,
    [kind],
  );
  return rows.map(rowToScope);
}
