import type pg from 'pg';
import { makeTestPool, resetData } from '../storage/test-helpers.js';
import { createPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { addMembership } from '../storage/memberships.js';
import { createMemory } from '../storage/memories.js';
import { storeMemoryEmbeddingVector } from '../storage/embeddings.js';
import { captureMemory } from './capture.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyRelation,
  relationThresholdFromEnv,
  safeRelationProviderId,
  validateRelationThreshold,
} from './relations.js';

describe('capture relation classification', () => {
  it('classifies normalized exact title and body as a duplicate', () => {
    expect(classifyRelation(
      { type: 'fact', title: ' Deploy policy ', body: 'No Fridays.\r\n' },
      { type: 'fact', title: 'deploy POLICY', body: ' No   Fridays. ' },
    )).toBe('possible-duplicate');
  });

  it.each([
    ['fact', 'fact', 'possible-conflict'],
    ['decision', 'decision', 'possible-conflict'],
    ['fact', 'decision', 'possible-duplicate'],
    ['context', 'context', 'possible-duplicate'],
  ] as const)('classifies nonidentical %s/%s candidates as %s', (left, right, relation) => {
    expect(classifyRelation(
      { type: left, title: 'Policy', body: 'Deploy Fridays.' },
      { type: right, title: 'Policy', body: 'Never deploy Fridays.' },
    )).toBe(relation);
  });
});

describe('relation threshold configuration', () => {
  it('defaults to 0.92 and accepts an explicit bounded number', () => {
    expect(relationThresholdFromEnv({})).toBe(0.92);
    expect(validateRelationThreshold(0.95)).toBe(0.95);
    expect(relationThresholdFromEnv({ CONTINUUM_RELATION_THRESHOLD: '0.95' })).toBe(0.95);
  });

  it.each([NaN, -0.01, 1.01])('rejects invalid numeric threshold %s', (value) => {
    expect(() => validateRelationThreshold(value)).toThrow(/between 0 and 1/);
  });

  it.each([
    '', 'nope', '-1', '1.1', '.92', '00.92', '9.2e-1', '0x1', 'Infinity',
  ])('rejects invalid environment threshold %s', (value) => {
    expect(() => relationThresholdFromEnv({ CONTINUUM_RELATION_THRESHOLD: value }))
      .toThrow(/CONTINUUM_RELATION_THRESHOLD/);
  });
});

describe('relation metadata bounds', () => {
  it('preserves a bounded provider id and redacts unsafe or oversized values', () => {
    expect(safeRelationProviderId('ollama:nomic-embed-text')).toBe('ollama:nomic-embed-text');
    expect(safeRelationProviderId('provider secret=private-value')).toBe('configured');
    expect(safeRelationProviderId(`provider:${'x'.repeat(128)}`)).toBe('configured');
  });
});


describe('bounded remote capture relation hydration', () => {
  let pool: pg.Pool;
  beforeEach(async () => { pool ??= await makeTestPool(); await resetData(pool); });
  afterAll(async () => { await pool?.end(); });
  it('keeps a new capture and its audit but rejects oversized ranked legacy bodies before hydration', async () => {
    const principal = await createPrincipal(pool, { externalId: 'relation-budget', kind: 'user', displayName: 'Reader' });
    const org = (await getScopeByRef(pool, { kind: 'org', name: '' }))!;
    await addMembership(pool, principal.id, org.id, 'writer');
    const vector = [1, ...Array(767).fill(0)];
    const provider = { id: 'relation-budget:fixture', dim: 768, embed: async (texts: string[]) => texts.map(() => vector) };
    const legacy = await createMemory(pool, { scopeId: org.id, scopeKind: 'org', type: 'decision', title: 'Legacy',
      body: 'legacy-body '.repeat(200000), authorId: principal.id, source: 'manual' });
    await storeMemoryEmbeddingVector(pool, legacy.id, vector, provider);
    const sql: string[] = [];
    const observed = new Proxy(pool, { get(target, property) {
      if (property === 'query') return async (text: string, ...args: unknown[]) => {
        sql.push(text);
        return (target.query as (...queryArgs: unknown[]) => unknown)(text, ...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await captureMemory(observed, provider, principal, {
      scope: { kind: 'org', name: '' }, type: 'decision', title: 'New capture', body: 'New reference', source: 'manual',
    }, {}, { readBudgetBytes: 1048576 });
    expect(result).toMatchObject({ embedded: true, related: [], relationErrorCode: 'RELATION_DETECTION_FAILED' });
    expect(sql.some((text) => text.includes('octet_length(m.body)'))).toBe(true);
    expect(sql.some((text) => /SELECT[^;]*m\.title, m\.body/.test(text))).toBe(false);
    expect((await pool.query('SELECT body, state, metadata FROM memories WHERE id=$1', [legacy.id])).rows[0])
      .toEqual({ body: legacy.body, state: 'live', metadata: {} });
    expect((await pool.query('SELECT metadata FROM audit_log WHERE memory_id=$1', [result.memory.id])).rows)
      .toHaveLength(1);
    expect((await pool.query('SELECT metadata FROM audit_log WHERE memory_id=$1', [result.memory.id])).rows[0].metadata)
      .toMatchObject({ embedded: true, relation_error_code: 'RELATION_DETECTION_FAILED' });
    expect((await pool.query('SELECT 1 FROM audit_log WHERE memory_id=$1', [legacy.id])).rowCount).toBe(0);
  });
});
