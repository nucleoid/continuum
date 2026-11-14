import type { Queryable } from './queryable.js';
import { parseEventAnnotation, type EventAnnotation, type EventInspection, type EventWindow } from '../temporal/model.js';

export async function writeEventAnnotation(client: Queryable, actor: string, memoryId: string, value: EventAnnotation): Promise<EventInspection> {
  return (await client.query<{ result: EventInspection }>('SELECT continuum_event_write($1,$2,$3) AS result',
    [actor, memoryId, JSON.stringify(parseEventAnnotation(value))])).rows[0].result;
}
/** Composes only constant SQL identifiers supplied by internal queries. */
export function eventPredicate(params: unknown[], actor: string | undefined, filter: EventWindow | undefined, memoryId = 'm.id'): string {
  if (!filter) return '';
  params.push(actor ?? null, JSON.stringify(filter));
  return ` AND continuum_event_matches($${params.length-1}::uuid,${memoryId},$${params.length}::jsonb)`;
}
export async function readEventAnnotations(client: Queryable, actor: string, ids: readonly string[], locked = true): Promise<Map<string, EventInspection | null>> {
  if (!ids.length) return new Map();
  const { rows } = await client.query<{ id: string; event: EventInspection | null }>(
    `SELECT id,continuum_event_read($1,id,$3) AS event FROM (SELECT unnest($2::uuid[]) AS id ORDER BY id) selected`, [actor, ids, locked]);
  return new Map(rows.map(row => [row.id,row.event]));
}
