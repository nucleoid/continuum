import type { Memory, MemoryState, MemoryType } from '../types.js';
import { MEMORY_COLUMNS, rowToMemory } from './memory-row.js';
import type { Queryable } from './queryable.js';
import { ServiceError } from '../services/errors.js';

export interface MemoryReadRecord { memory: Memory; scope: string; authorDisplayName: string; }
export interface ListMemoryFilter { scope?: string; type?: MemoryType; state: MemoryState; limit: number; offset: number; }
interface MemoryReadRow extends Record<string, unknown> { scope_label: string; author_display_name: string; }
function rowToMemoryReadRecord(row: MemoryReadRow): MemoryReadRecord {
  return { memory: rowToMemory(row), scope: row.scope_label, authorDisplayName: row.author_display_name };
}
const READ_SELECT = `${MEMORY_COLUMNS.split(',').map((column) => `m.${column.trim()}`).join(', ')},
  CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END AS scope_label,
  p.display_name AS author_display_name`;
const JOINS = 'FROM memories m JOIN scopes s ON s.id = m.scope_id JOIN principals p ON p.id = m.author_id';
function eligibility(principalParameter: string): string {
  return `(m.expires_at IS NULL OR m.expires_at > now())
    AND EXISTS (SELECT 1 FROM principals caller WHERE caller.id = ${principalParameter} AND caller.disabled_at IS NULL)
    AND (s.kind = 'org' OR EXISTS (SELECT 1 FROM scope_memberships sm
      WHERE sm.principal_id = ${principalParameter} AND sm.scope_id = m.scope_id AND sm.active
      AND continuum_membership_is_effective(sm.active, sm.source_kind)))`;
}
/** UTF-8 content lengths only, not memory bodies. Twelve-fold nested JSON text escaping plus bounded field overhead. */
export const MEMORY_READ_BUDGET_BYTES_SQL = `(4096::bigint + 12::bigint * (
  octet_length(m.body)::bigint + octet_length(m.title)::bigint
  + COALESCE(octet_length(m.metadata::text), 0)::bigint
  + COALESCE(octet_length(array_to_json(m.tags)::text), 0)::bigint
  + octet_length(m.source)::bigint + COALESCE(octet_length(m.source_ref), 0)::bigint))`;
export function requireReadBudget(bytes: number, readBudgetBytes: number): void {
  if (!Number.isSafeInteger(readBudgetBytes) || readBudgetBytes < 1) throw new ServiceError('INVALID_INPUT', 'Read budget must be a positive safe integer');
  if (!Number.isSafeInteger(bytes) || bytes > readBudgetBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Authorized result exceeds the response size limit');
}
/** Metadata preflight avoids bulk hydration. The materialized metadata gate is repeated in the
 * hydration statement's own snapshot, so growth and newly eligible rows cannot bypass admission.
 * metadataSql selects id, budget_bytes and position. hydrationSql joins budget_candidates c.
 */
export async function boundedMemoryReadRows<T extends Record<string, unknown>>(
  queryable: Queryable, metadataSql: string, values: unknown[], hydrationSql: string, readBudgetBytes: number,
): Promise<T[]> {
  requireReadBudget(1024, readBudgetBytes);
  const probe = await queryable.query<{ budget_bytes: string | number }>(metadataSql, values);
  requireReadBudget(probe.rows.reduce((sum, row) => sum + Number(row.budget_bytes), 1024), readBudgetBytes);
  const parameter = `$${values.length + 1}`;
  const { rows } = await queryable.query<T & { budget_exceeded: boolean; candidate_count: string }>(
    `WITH budget_candidates AS MATERIALIZED (${metadataSql}),
     read_budget AS (SELECT COALESCE(sum(budget_bytes), 0) + 1024 > ${parameter}::bigint AS budget_exceeded,
       count(*) AS candidate_count FROM budget_candidates)
     SELECT read_budget.budget_exceeded, read_budget.candidate_count, hydrated.*
       FROM read_budget LEFT JOIN LATERAL (SELECT admitted.* FROM (${hydrationSql}) admitted WHERE NOT read_budget.budget_exceeded) hydrated
         ON NOT read_budget.budget_exceeded`, [...values, readBudgetBytes],
  );
  if (rows[0]?.budget_exceeded) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Authorized result exceeds the response size limit');
  const results = rows.filter((row) => row.id !== null && row.id !== undefined);
  if (results.length !== Number(rows[0]?.candidate_count ?? 0)) throw new ServiceError('PAYLOAD_TOO_LARGE', 'Authorized result could not be read within the response size limit');
  return results;
}
async function readRows(
  queryable: Queryable, where: string, suffix: string, values: unknown[], readBudgetBytes?: number,
): Promise<MemoryReadRow[]> {
  if (readBudgetBytes === undefined) return (await queryable.query<MemoryReadRow>(`SELECT ${READ_SELECT} ${JOINS} WHERE ${where} ${suffix}`, values)).rows;
  const metadataSql = `SELECT m.id, ${MEMORY_READ_BUDGET_BYTES_SQL}
    + 12::bigint * (octet_length(s.name)::bigint + octet_length(p.display_name)::bigint) AS budget_bytes,
    row_number() OVER (ORDER BY m.updated_at DESC, m.id DESC) AS position
    ${JOINS} WHERE ${where} ${suffix}`;
  return boundedMemoryReadRows<MemoryReadRow>(queryable, metadataSql, values,
    `SELECT ${READ_SELECT} ${JOINS} JOIN budget_candidates c ON c.id = m.id ORDER BY c.position`, readBudgetBytes);
}
export async function getReadableMemory(queryable: Queryable, principalId: string, memoryId: string, readBudgetBytes?: number): Promise<MemoryReadRecord | null> {
  const rows = await readRows(queryable, `m.id = $1 AND ${eligibility('$2')}`, '', [memoryId, principalId], readBudgetBytes);
  return rows[0] ? rowToMemoryReadRecord(rows[0]) : null;
}
export async function listReadableMemories(queryable: Queryable, principalId: string, filter: ListMemoryFilter, readBudgetBytes?: number): Promise<MemoryReadRecord[]> {
  const where = `${eligibility('$1')} AND m.state = $2 AND ($3::text IS NULL OR m.type = $3)
    AND ($4::text IS NULL OR CASE WHEN s.kind = 'org' THEN 'org' ELSE s.kind || ':' || s.name END = $4)`;
  const rows = await readRows(queryable, where, 'ORDER BY m.updated_at DESC, m.id DESC LIMIT $5 OFFSET $6',
    [principalId, filter.state, filter.type ?? null, filter.scope ?? null, filter.limit, filter.offset], readBudgetBytes);
  return rows.map(rowToMemoryReadRecord);
}

/** Lock only an authorized source identity/size before loading its old content for a mutation. */
export async function getBudgetedMemoryForUpdate(queryable: Queryable, memoryId: string,
  principalId: string, readBudgetBytes: number): Promise<Memory | null> {
  requireReadBudget(1024, readBudgetBytes);
  const probe = await queryable.query<{ id: string; budget_bytes: string }>(
    `SELECT m.id, ${MEMORY_READ_BUDGET_BYTES_SQL} AS budget_bytes
      FROM memories m JOIN scopes s ON s.id=m.scope_id WHERE m.id=$1
      AND EXISTS (SELECT 1 FROM principals caller WHERE caller.id=$2 AND caller.disabled_at IS NULL)
      AND (s.kind='org' OR EXISTS (SELECT 1 FROM scope_memberships sm
        WHERE sm.principal_id=$2 AND sm.scope_id=m.scope_id AND sm.active
        AND continuum_membership_is_effective(sm.active,sm.source_kind))) FOR UPDATE OF m`, [memoryId, principalId]);
  if (!probe.rows.length) return null;
  requireReadBudget(Number(probe.rows[0].budget_bytes) + 1024, readBudgetBytes);
  // The row lock prevents body/metadata growth between size admission and hydration.
  const rows = (await queryable.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id=$1`, [memoryId])).rows;
  return rows.length ? rowToMemory(rows[0]) : null;
}
