import { describe, expect, it } from 'vitest';
import { parseEventAnnotation, parseEventWindow, eventMatches, orderEventResults } from './model.js';

const instant = (at = '2026-02-01T00:00:00Z') => parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'instant', instant: at });
describe('explicit event time', () => {
  it('normalizes offsets while retaining notation and permits future assertions', () => {
    expect(instant('2099-01-01T13:00:00+13:00')).toMatchObject({ instant: '2099-01-01T00:00:00.000Z', original: '2099-01-01T13:00:00+13:00' });
  });
  it('normalizes partial precision into a period, never a point or capture time', () => {
    expect(parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'month', value: '2024-02', timezone: '+13:00' }))
      .toMatchObject({ start: '2024-01-31T11:00:00.000Z', end: '2024-02-29T11:00:00.000Z', precision: 'month' });
    expect(() => parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'day', value: '2024-02-01' })).toThrow();
  });
  it.each(['2025-02-29T00:00:00Z','2024-02-30T00:00:00Z','2026-01-01','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','infinity'])('rejects invalid or uncertain instant %s', value => {
    expect(() => instant(value)).toThrow();
  });
  it('uses half-open overlap, containment and distinct instant semantics', () => {
    const range = parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'range', start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' });
    const window = parseEventWindow({ from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' });
    expect(eventMatches(range, window)).toBe(false);
    expect(eventMatches(instant(), window)).toBe(true);
    expect(eventMatches(range, parseEventWindow({ at: '2026-01-01T00:00:00Z' }))).toBe(true);
    expect(eventMatches(range, parseEventWindow({ at: '2026-02-01T00:00:00Z' }))).toBe(false);
    expect(eventMatches(parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'range', end: '2026-02-01T00:00:00Z' }), parseEventWindow({ to: '2026-01-01T00:00:00Z' }))).toBe(true);
  });
  it('requires explicit inclusion of unknown, ambiguous, historical and mention-only dates', () => {
    const values = [undefined, parseEventAnnotation({ status: 'unknown' }), parseEventAnnotation({ status: 'ambiguous', candidates: [{ notation: 'next Friday' }] }), parseEventAnnotation({ status: 'known', assertion: 'mentioned', precision: 'instant', instant: '2026-02-01T00:00:00Z' })];
    for (const value of values) {
      expect(eventMatches(value, parseEventWindow({ at: '2026-02-01T00:00:00Z' }))).toBe(false);
      expect(eventMatches(value, parseEventWindow({ at: '2026-02-01T00:00:00Z', includeUnknown: true }))).toBe(true);
    }
  });
  it('rejects conflicting shapes, empty/reversed windows and excess candidates', () => {
    for (const value of [{}, { from: '2026-02-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }, { at: '2026-02-01T00:00:00Z', from: '2026-01-01T00:00:00Z' }, { from: '2026-01-01' }, { at: '2026-01-01T00:00:00Z', includeUnknown: 'true' }]) expect(() => parseEventWindow(value)).toThrow();
    expect(() => parseEventAnnotation({ status: 'ambiguous', candidates: Array.from({ length: 9 }, () => ({ notation: 'Friday' })) })).toThrow();
    expect(() => parseEventAnnotation({ status: 'unknown', instant: '2026-01-01T00:00:00Z' })).toThrow();
    expect(() => parseEventAnnotation({ status: 'known', assertion: 'asserted', precision: 'range' })).toThrow();
  });
  it('hints preserve eligibility and relevance, break ties by overlap then stable ID', () => {
    const rows = [{ id: 'b', score: 1 }, { id: 'c', score: 2 }, { id: 'a', score: 1 }];
    const events = new Map([['b', instant()]]);
    expect(orderEventResults(rows, parseEventWindow({ at: '2026-02-01T00:00:00Z' }), events).map(r => r.id)).toEqual(['c','b','a']);
    expect(rows.map(r => r.id)).toEqual(['b','c','a']);
  });
});
