import type pg from 'pg';
import type { Principal } from '../types.js';
import { recordRead } from '../audit/log.js';
import {
  listOpenStandupThreads,
  listStandupActivity,
  type StandupMemory,
} from '../storage/standup.js';
import { asServiceError, ServiceError } from './errors.js';

const DAY_MS = 86_400_000;
export const MAX_STANDUP_LIMIT = 100;
export const MAX_STANDUP_OFFSET = 10_000;
export const MAX_STANDUP_SINCE_HOURS = 168;
export const MAX_OPEN_THREAD_DAYS = 30;
export const OPEN_THREAD_LOOKBACK_DAYS = 90;

export interface StandupInput {
  sinceHours?: number;
  date?: string;
  timezone?: string;
  limit?: number;
  offset?: number;
  openThreadDays?: number;
  openThreadLimit?: number;
}

export interface StandupResult {
  window: { start: Date; end: Date; timezone: string | null; date: string | null };
  activity: StandupMemory[];
  openThreads: StandupMemory[];
  page: { limit: number; offset: number; nextOffset: number | null };
}

function integer(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ServiceError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new ServiceError('INVALID_INPUT', 'date must use YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new ServiceError('INVALID_INPUT', 'date must be a valid calendar date');
  }
  return { year, month, day };
}

function formatter(timezone: string): Intl.DateTimeFormat {
  if (timezone.length === 0 || timezone.length > 100) {
    throw new ServiceError('INVALID_INPUT', 'timezone must be a valid IANA time zone');
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  } catch (error) {
    throw new ServiceError('INVALID_INPUT', 'timezone must be a valid IANA time zone', { cause: error });
  }
}

function zonedMidnightUtc(date: string, timezone: string): Date {
  const target = validDate(date);
  const fmt = formatter(timezone);
  const targetEpoch = Date.UTC(target.year, target.month - 1, target.day);
  let guess = targetEpoch;
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += targetEpoch - represented;
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== date
      || parts.hour !== '00' || parts.minute !== '00' || parts.second !== '00') {
    throw new ServiceError('INVALID_INPUT', 'date has no unambiguous midnight in timezone');
  }
  return new Date(guess);
}

function nextDate(value: string): string {
  const { year, month, day } = validDate(value);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS).toISOString().slice(0, 10);
}

export async function standupForPrincipal(
  pool: pg.Pool,
  principal: Principal,
  input: StandupInput = {},
  options: { now?: Date; transport?: 'rest' | 'mcp' } = {},
): Promise<StandupResult> {
  try {
    const limit = integer('limit', input.limit ?? 50, 1, MAX_STANDUP_LIMIT);
    const offset = integer('offset', input.offset ?? 0, 0, MAX_STANDUP_OFFSET);
    const openThreadDays = integer('openThreadDays', input.openThreadDays ?? 2, 1, MAX_OPEN_THREAD_DAYS);
    const openThreadLimit = integer('openThreadLimit', input.openThreadLimit ?? 20, 1, MAX_STANDUP_LIMIT);
    if (input.date !== undefined && input.sinceHours !== undefined) {
      throw new ServiceError('INVALID_INPUT', 'date and since are mutually exclusive');
    }
    if (input.date !== undefined && !input.timezone) {
      throw new ServiceError('INVALID_INPUT', 'timezone is required with date');
    }
    if (input.date === undefined && input.timezone !== undefined) {
      throw new ServiceError('INVALID_INPUT', 'timezone is only valid with date');
    }
    const now = options.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new ServiceError('INVALID_INPUT', 'now is invalid');
    const window = input.date !== undefined
      ? {
          start: zonedMidnightUtc(input.date, input.timezone!),
          end: zonedMidnightUtc(nextDate(input.date), input.timezone!),
          timezone: input.timezone!,
          date: input.date,
        }
      : (() => {
          const hours = integer(
            'sinceHours', input.sinceHours ?? 24, 1, MAX_STANDUP_SINCE_HOURS,
          );
          return {
            start: new Date(now.getTime() - hours * 3_600_000),
            end: now,
            timezone: null,
            date: null,
          };
        })();

    const activityPage = await listStandupActivity(
      pool, principal.id, window.start, window.end, limit + 1, offset,
    );
    const hasMore = activityPage.length > limit;
    const activity = activityPage.slice(0, limit);
    const openBefore = new Date(Math.min(
      window.start.getTime(),
      window.end.getTime() - openThreadDays * DAY_MS,
    ));
    const openNotBefore = new Date(window.end.getTime() - OPEN_THREAD_LOOKBACK_DAYS * DAY_MS);
    const openThreads = await listOpenStandupThreads(
      pool, principal.id, openBefore, openNotBefore, openThreadLimit,
    );
    const returned = [...activity, ...openThreads];
    await recordRead(pool, {
      principalId: principal.id,
      metadata: {
        view: 'standup',
        activity_hits: activity.length,
        open_thread_hits: openThreads.length,
        window_start: window.start.toISOString(),
        window_end: window.end.toISOString(),
        ...(options.transport ? { transport: options.transport } : {}),
      },
      memories: returned.map((memory, index) => ({
        memoryId: memory.id,
        scopeId: memory.scopeId,
        metadata: { rank: index + 1 },
      })),
    });
    return {
      window,
      activity,
      openThreads,
      page: { limit, offset, nextOffset: hasMore ? offset + limit : null },
    };
  } catch (error) {
    throw asServiceError(error);
  }
}
