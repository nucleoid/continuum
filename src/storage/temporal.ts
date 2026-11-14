import type { Queryable } from './queryable.js';
import { parseEventAnnotation, type EventAnnotationInput, type EventInspection, type EventWindow } from '../temporal/model.js';
import type { Budget } from '../pipeline/budget.js';
import { boundedMemoryReadRows } from './memory-reads.js';

export async function writeEventAnnotation(client: Queryable, actor: string, memoryId: string, value: EventAnnotationInput): Promise<EventInspection> {
  return (await client.query<{ result: EventInspection }>('SELECT continuum_event_write($1,$2,$3) AS result',
    [actor, memoryId, JSON.stringify(parseEventAnnotation(value))])).rows[0].result;
}
/** Composes only constant SQL identifiers supplied by internal queries. */
export function eventPredicate(params: unknown[], actor: string | undefined, filter: EventWindow | undefined, memoryId = 'm.id'): string {
  if (!filter) return '';
  params.push(actor ?? null, JSON.stringify(filter));
  return ` AND continuum_event_matches($${params.length-1}::uuid,${memoryId},$${params.length}::jsonb)`;
}
export async function readEventAnnotations(client: Queryable, actor: string, ids: readonly string[], locked = true,
  readBudgetBytes?: number, budget?: Budget): Promise<Map<string, EventInspection | null>> {
  if (!ids.length) return new Map();
  const values = [actor,ids,locked];
  const sql = `SELECT id,continuum_event_read($1,id,$3) AS event FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) selected`;
  readBudgetBytes ??= budget?.available('hydratedBytes');
  const rows = readBudgetBytes === undefined ? (await client.query<{ id: string; event: EventInspection | null }>(sql,values)).rows
    : await boundedMemoryReadRows<{ id: string; event: EventInspection | null }>(client,
      `SELECT id,COALESCE((continuum_event_metadata($1,id,$3)->>'bytes')::bigint,0) AS budget_bytes,
        row_number() OVER (ORDER BY id) AS position FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) selected`, values,
      'SELECT c.id,continuum_event_read($1,c.id,$3) AS event FROM budget_candidates c ORDER BY c.position', readBudgetBytes,budget,true);
  return new Map(rows.map(row => [row.id,row.event]));
}
