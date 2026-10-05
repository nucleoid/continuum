import type { MembershipRole, Scope, Principal } from '../types.js';
import type { Queryable } from './queryable.js';

export interface ScopeMembership {
  principalId: string;
  scopeId: string;
  role: MembershipRole;
  addedAt: Date;
  sourceKind?: 'manual' | 'entra';
  sourceId?: string;
  active?: boolean;
}

function rowToMembership(row: Record<string, unknown>): ScopeMembership {
  return {
    principalId: row.principal_id as string,
    scopeId: row.scope_id as string,
    role: row.role as MembershipRole,
    addedAt: row.added_at as Date,
    sourceKind: row.source_kind as 'manual' | 'entra',
    sourceId: row.source_id as string,
    active: row.active as boolean,
  };
}

export async function addMembership(
  pool: Queryable,
  principalId: string,
  scopeId: string,
  role: MembershipRole,
): Promise<ScopeMembership> {
  const { rows } = await pool.query(
    `INSERT INTO scope_memberships
       (principal_id, scope_id, role, source_kind, source_id, active, deactivated_at)
     VALUES ($1, $2, $3, 'manual', 'manual', TRUE, NULL)
     ON CONFLICT (principal_id, scope_id, source_kind, source_id)
       DO UPDATE SET role = EXCLUDED.role, active = TRUE, deactivated_at = NULL
     RETURNING principal_id, scope_id, role, added_at, source_kind, source_id, active`,
    [principalId, scopeId, role],
  );
  return rowToMembership(rows[0]);
}

export async function removeMembership(
  pool: Queryable,
  principalId: string,
  scopeId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM scope_memberships
      WHERE principal_id = $1 AND scope_id = $2 AND source_kind = 'manual'`,
    [principalId, scopeId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getMembership(
  pool: Queryable,
  principalId: string,
  scopeId: string,
): Promise<ScopeMembership | null> {
  const { rows } = await pool.query(
    `SELECT principal_id, scope_id, role, added_at, source_kind, source_id, active
       FROM scope_memberships
      WHERE principal_id = $1 AND scope_id = $2 AND active
      ORDER BY CASE role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END DESC,
               source_kind, source_id
      LIMIT 1`,
    [principalId, scopeId],
  );
  return rows[0] ? rowToMembership(rows[0]) : null;
}

export async function getScopesForPrincipal(
  pool: Queryable,
  principalId: string,
): Promise<Array<Scope & { role: MembershipRole }>> {
  const { rows } = await pool.query(
    `SELECT s.id, s.kind, s.name, s.created_at,
            CASE max(CASE m.role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END)
              WHEN 3 THEN 'admin' WHEN 2 THEN 'writer' ELSE 'reader' END AS role
       FROM scope_memberships m
       JOIN scopes s ON s.id = m.scope_id
      WHERE m.principal_id = $1 AND m.active
      GROUP BY s.id, s.kind, s.name, s.created_at`,
    [principalId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind,
    name: r.name as string,
    createdAt: r.created_at as Date,
    role: r.role as MembershipRole,
  }));
}

export async function getPrincipalsForScope(
  pool: Queryable,
  scopeId: string,
): Promise<Array<Principal & { role: MembershipRole }>> {
  const { rows } = await pool.query(
    `SELECT p.id, p.external_id, p.kind, p.display_name, p.created_at,
            CASE max(CASE m.role WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END)
              WHEN 3 THEN 'admin' WHEN 2 THEN 'writer' ELSE 'reader' END AS role
       FROM scope_memberships m
       JOIN principals p ON p.id = m.principal_id
      WHERE m.scope_id = $1 AND m.active
      GROUP BY p.id, p.external_id, p.kind, p.display_name, p.created_at`,
    [scopeId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    externalId: r.external_id as string,
    kind: r.kind,
    displayName: r.display_name as string,
    createdAt: r.created_at as Date,
    role: r.role as MembershipRole,
  }));
}

export async function hasRole(
  pool: Queryable,
  principalId: string,
  scopeId: string,
  required: MembershipRole,
): Promise<boolean> {
  const m = await getMembership(pool, principalId, scopeId);
  if (!m) return false;
  if (required === 'reader') return true;
  if (required === 'writer') return m.role === 'writer' || m.role === 'admin';
  return m.role === 'admin';
}
