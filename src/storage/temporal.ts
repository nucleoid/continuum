import type { Queryable } from './queryable.js';
import { parseEventAnnotation, type EventAnnotationInput, type EventInspection, type EventWindow } from '../temporal/model.js';
import type { Budget } from '../pipeline/budget.js';
import { boundedMemoryReadRows } from './memory-reads.js';

// SQL caps payloads at8192 bytes and adds256 bytes of inspection provenance.
export const MAX_EVENT_INSPECTION_BYTES = 8192 + 256;

/** Select a bounded identity cut using overlap flags, before loading source
 * bodies. Final delivery still validates current annotations and orders once. */
export async function selectEventCandidates<T extends { id: string; score: number }>(client: Queryable,
  actor: string | undefined, candidates: readonly T[], window: EventWindow | undefined, limit: number): Promise<T[]> {
  if (!window || !actor || !candidates.length) return candidates.slice(0,limit);
  if (candidates.length>100) throw new RangeError('Too many event candidates');
  const rows=(await client.query<{ id: string; overlaps: boolean }>(
    `WITH locked AS MATERIALIZED (SELECT id FROM memories WHERE id=ANY($2::uuid[]) ORDER BY id FOR SHARE)
     SELECT id,continuum_event_matches($1,id,$3::jsonb) AS overlaps FROM locked`,
    [actor,candidates.map(c=>c.id),JSON.stringify({...window,includeUnknown:false})])).rows;
  const overlaps=new Map(rows.map(row=>[row.id,Number(row.overlaps)]));
  const cut=new Set([...candidates].sort((a,b)=>b.score-a.score || (overlaps.get(b.id)??0)-(overlaps.get(a.id)??0)
    || a.id.localeCompare(b.id)).slice(0,limit).map(c=>c.id));
  return candidates.filter(c=>cut.has(c.id));
}

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
  readBudgetBytes?: number, budget?: Budget, includeHistoricalUnknown = false): Promise<Map<string, EventInspection | null>> {
  if (!ids.length) return new Map();
  const values = [actor,ids,locked];
  const read = includeHistoricalUnknown ? 'continuum_event_read' : 'continuum_event_optional_read';
  const metadata = includeHistoricalUnknown ? 'continuum_event_metadata' : 'continuum_event_optional_metadata';
  const sql = `SELECT id,${read}($1,id,$3) AS event FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) selected`;
  readBudgetBytes ??= budget?.available('hydratedBytes');
  const rows = readBudgetBytes === undefined ? (await client.query<{ id: string; event: EventInspection | null }>(sql,values)).rows
    : await boundedMemoryReadRows<{ id: string; event: EventInspection | null }>(client,
      `SELECT id,COALESCE((${metadata}($1,id,$3)->>'bytes')::bigint,0) AS budget_bytes,
        row_number() OVER (ORDER BY id) AS position FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) selected`, values,
      `SELECT c.id,CASE WHEN c.budget_bytes>0 THEN ${read}($1,c.id,$3) ELSE NULL END AS event
        FROM budget_candidates c ORDER BY c.position`, readBudgetBytes,budget,true);
  return new Map(rows.map(row => [row.id,row.event]));
}
