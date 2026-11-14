import { z } from 'zod';
import { ServiceError } from '../services/errors.js';

const boundedText = (bytes: number) => z.string().min(1).refine(v => Buffer.byteLength(v, 'utf8') <= bytes);
const offset = /^(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const timezone = boundedText(100).refine(value => {
  if (offset.test(value)) return !/[+-]14:(?!00)/.test(value);
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
function utc(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!match || Number(match[1]) < 1 || /[+-]14:(?!00)/.test(value) || value.endsWith('-00:00')) throw new Error('Invalid event instant');
  const [, year, month, day] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) throw new Error('Invalid event calendar');
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) throw new Error('Invalid event instant');
  return at.toISOString();
}
const instantSchema = z.string().refine(value => { try { utc(value); return true; } catch { return false; } });
const candidate = z.object({ notation: boundedText(256), timezone: timezone.optional() }).strict();
function localDate(at: string, zone: string): string {
  if (offset.test(zone)) {
    const minutes = zone === 'Z' ? 0 : (Number(zone.slice(1,3))*60+Number(zone.slice(4))) * (zone[0] === '+' ? 1 : -1);
    return new Date(Date.parse(at)+minutes*60_000).toISOString().slice(0,10);
  }
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(type => parts.find(p => p.type === type)!.value).join('-');
}
function midnight(date: string, zone: string): string {
  if (offset.test(zone)) return utc(`${date}T00:00:00${zone}`);
  const target = Date.parse(`${date}T00:00:00Z`);
  const format = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const wall = (time: number) => {
    const parts = format.formatToParts(new Date(time));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    return Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
  };
  let time = target;
  for(let i=0;i<4;i++) time += target-wall(time);
  if (wall(time)!==target || [time-3_600_000,time+3_600_000,time-7_200_000,time+7_200_000].some(other => wall(other)===target)) throw new Error('Ambiguous event midnight');
  return utc(new Date(time).toISOString());
}
function nextDate(date: string, precision: 'day'|'month'|'year'): string {
  const next = new Date(`${date}T00:00:00Z`);
  if (precision==='year') next.setUTCFullYear(next.getUTCFullYear()+1);
  else if(precision==='month') next.setUTCMonth(next.getUTCMonth()+1);
  else next.setUTCDate(next.getUTCDate()+1);
  return next.toISOString().slice(0,10);
}
const common = { original: boundedText(1024).optional(), timezone: timezone.optional() };
const known = z.object({ status: z.literal('known'), assertion: z.enum(['asserted','mentioned']),
  precision: z.enum(['instant','day','month','year','range']), instant: instantSchema.optional(),
  start: instantSchema.optional(), end: instantSchema.optional(), value: boundedText(10).optional(), ...common }).strict();
export type EventAnnotation = {
  status: 'known'; assertion: 'asserted' | 'mentioned'; precision: 'instant' | 'day' | 'month' | 'year' | 'range';
  instant?: string; start?: string; end?: string; original?: string; timezone?: string;
} | { status: 'unknown'; original?: string; timezone?: string }
  | { status: 'ambiguous'; candidates: Array<{ notation: string; timezone?: string }>; original?: string; timezone?: string };
export interface EventWindow { from?: string; to?: string; at?: string; includeUnknown: boolean }
export interface EventInspection { annotation: EventAnnotation; version: string | null; sourceVersion: string | null }

/** Discovery projects normalized status/precision, never candidate prose. Full
 * original notation remains an independently authorized inspection surface. */
export function recallEventInspection(event: EventInspection) {
  const value=event.annotation;
  if(value.status==='known') {
    const {original:_original,...annotation}=value;
    return {annotation,version:event.version,sourceVersion:event.sourceVersion};
  }
  return {annotation:{status:value.status},version:event.version,sourceVersion:event.sourceVersion};
}

function normalizeAnnotation(input: z.infer<typeof known>): EventAnnotation {
  const value = { ...input };
  if (value.value !== undefined) {
    const pattern = value.precision === 'year' ? /^\d{4}$/ : value.precision === 'month' ? /^\d{4}-\d{2}$/ : value.precision === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : /$a/;
    if (!pattern.test(value.value) || !value.timezone || value.instant || value.start || value.end) throw new Error('Invalid event period');
    const date = value.value + (value.precision === 'year' ? '-01-01' : value.precision === 'month' ? '-01' : '');
    utc(`${date}T00:00:00Z`);
    value.start = midnight(date,value.timezone);
    value.end = midnight(nextDate(date,value.precision as 'day'|'month'|'year'),value.timezone);
    value.original ??= value.value;
  }
  if (value.precision === 'instant') {
    if (!value.instant || value.start || value.end || value.value) throw new Error('Invalid event instant');
    value.original ??= value.instant;
    value.instant = utc(value.instant);
  } else {
    if (value.instant || (!value.start && !value.end)) throw new Error('Invalid event interval');
    value.original ??= `${value.start ?? ''}/${value.end ?? ''}`;
    if (value.start) value.start = utc(value.start);
    if (value.end) value.end = utc(value.end);
    if (value.start && value.end && value.start >= value.end) throw new Error('Empty event interval');
    if (value.precision !== 'range' && (!value.start || !value.end)) throw new Error('Partial precision requires a bounded period');
    if (value.precision !== 'range') {
      if (!value.timezone) throw new Error('Partial precision requires a timezone');
      const date = localDate(value.start!,value.timezone);
      if ((value.precision==='month' && !date.endsWith('-01')) || (value.precision==='year' && !date.endsWith('-01-01'))
        || value.start!==midnight(date,value.timezone) || value.end!==midnight(nextDate(date,value.precision),value.timezone)) throw new Error('Invalid event precision');
    }
  }
  const { value: _period, ...normalized } = value;
  return normalized;
}
const rawAnnotation = z.discriminatedUnion('status', [known,
  z.object({ status: z.literal('unknown'), ...common }).strict(),
  z.object({ status: z.literal('ambiguous'), candidates: z.array(candidate).min(1).max(8), ...common }).strict()]);
export const eventAnnotationSchema = rawAnnotation.transform((value, context): EventAnnotation => {
  try { return value.status === 'known' ? normalizeAnnotation(value) : value; }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid event annotation' }); return z.NEVER; }
});
export type EventAnnotationInput = z.input<typeof eventAnnotationSchema>;
export const eventWindowSchema = z.object({ from: instantSchema.optional(), to: instantSchema.optional(),
  at: instantSchema.optional(), includeUnknown: z.boolean().default(false) }).strict().superRefine((value, context) => {
  if ((!value.from && !value.to && !value.at) || (value.at && (value.from || value.to))
    || (value.from && value.to && utc(value.from) >= utc(value.to))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid event window' });
}).transform(value => ({ ...value, ...(value.from ? { from: utc(value.from) } : {}),
  ...(value.to ? { to: utc(value.to) } : {}), ...(value.at ? { at: utc(value.at) } : {}) }));
export type EventWindowInput = z.input<typeof eventWindowSchema>;

export function parseEventAnnotation(value: unknown): EventAnnotation {
  const parsed = eventAnnotationSchema.safeParse(value);
  if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid event annotation');
  return parsed.data;
}
export function parseEventWindow(value: unknown): EventWindow {
  const parsed = eventWindowSchema.safeParse(value);
  if (!parsed.success) throw new ServiceError('INVALID_INPUT', 'Invalid event window');
  return parsed.data;
}
export function eventMatches(event: EventAnnotation | undefined, window: EventWindow): boolean {
  if (!event || event.status !== 'known' || event.assertion !== 'asserted') return window.includeUnknown;
  const point = event.instant;
  if (window.at) return point ? point === window.at : (!event.start || event.start <= window.at) && (!event.end || window.at < event.end);
  if (point) return (!window.from || window.from <= point) && (!window.to || point < window.to);
  return (!window.from || !event.end || window.from < event.end) && (!window.to || !event.start || event.start < window.to);
}
/** Single final hint ordering. Core score always wins; a hint excludes no row. */
export function orderEventResults<T extends { id: string; score: number; rerankScore?: number }>(rows: readonly T[], window: EventWindow, events: ReadonlyMap<string, EventAnnotation>): T[] {
  const overlaps = (id: string) => Number(eventMatches(events.get(id), { ...window, includeUnknown: false }));
  return [...rows].sort((a,b) => (b.rerankScore ?? b.score)-(a.rerankScore ?? a.score) || b.score-a.score
    || overlaps(b.id)-overlaps(a.id) || a.id.localeCompare(b.id));
}
