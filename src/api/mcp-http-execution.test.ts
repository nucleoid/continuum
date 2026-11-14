import { describe, expect, it } from 'vitest';
import { remoteExecutionContext } from './mcp-http-execution.js';
import { Budget } from '../pipeline/budget.js';
import { embedWithBudget } from '../embeddings/provider.js';
import { runReranking } from '../reranking/runner.js';
import { testReranking } from '../reranking/test-helpers.js';

it.each(['embedding', 'reranking'] as const)('retains timed-out budgeted %s work until actual settlement', async kind => {
  const t = testReranking(() => 1);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let invoked!: () => void; const started = new Promise<void>(resolve => { invoked = resolve; });
  const original = t.adapter.invoke;
  t.adapter.timeoutMs = 25;
  t.adapter.invoke = async (wire, caps) => { invoked(); await held; return original(wire, caps); };
  const embedding = { ...t.adapter, id: 'remote-drain-embedding', serialize: (texts: string[], caps: unknown) => ({ texts, caps }),
    invoke: async () => { invoked(); await held; const value = [Array(768).fill(0)]; return { value, response: value }; } };
  const provider = { id: embedding.id, dim: 768, local: true, pipelineAdapter: embedding, embed: async () => [[]] };
  const context = remoteExecutionContext({} as never, provider);
  // Optional while establishing the red case against the old context API.
  const onWork = (context as typeof context & { trackWork?: (work: Promise<unknown>) => void }).trackWork;
  let completed = false;
  const budget = new Budget(t.config().profile);
  const signal = new AbortController().signal;
  const work = context.run(signal, async () => {
    if (kind === 'embedding') {
      await expect(embedWithBudget(context.routing.providers()[0], ['reference'], { budget, signal, ...{ onWork } }))
        .rejects.toMatchObject({ code: 'EMBEDDING_TIMEOUT' });
    } else {
      const result = await runReranking(t.config(), budget, { query: 'reference', candidates: [
        { id: 'c0', title: 'One', excerpt: 'Reference' }, { id: 'c1', title: 'Two', excerpt: 'Reference' }] },
      async () => true, 0, { signal, ...{ onWork } });
      expect(result).toEqual({ status: 'fallback', reason: 'deadline' });
    }
  }).then(() => { completed = true; });
  try {
    await started;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(completed).toBe(false);
  } finally { release(); await work; }
  expect(completed).toBe(true);
});
describe('remote per-call execution context', () => {
  it('prevents post-cancellation SQL side effects but permits transactional rollback', async () => {
    const calls: string[] = [];
    const released: unknown[] = [];
    const client = { query: async (text: string) => { calls.push(text); return { rows: [] }; }, release: (error?: unknown) => { released.push(error); } };
    const pool = { connect: async () => client, query: client.query };
    const context = remoteExecutionContext(pool as never, null);
    const abort = new AbortController();
    await context.run(abort.signal, async () => {
      const borrowed = await context.pool.connect();
      await borrowed.query('BEGIN'); abort.abort();
      expect(() => borrowed.query('INSERT INTO memories')).toThrow();
      await borrowed.query('ROLLBACK'); borrowed.release();
    });
    expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(released).toEqual([true]);
  });
  it('keeps concurrent provider cancellation local to each invocation', async () => {
    const observed: AbortSignal[] = [];
    const provider = { id: 'test', dim: 768, embed: async (_texts: string[], options?: { signal?: AbortSignal }) => {
      observed.push(options!.signal!); return [[]]; } };
    const context = remoteExecutionContext({} as never, provider);
    const first = new AbortController(); const second = new AbortController();
    await Promise.all([context.run(first.signal, () => context.routing.providers()[0].embed(['first'])),
      context.run(second.signal, () => context.routing.providers()[0].embed(['second']))]);
    first.abort(); expect(observed[0].aborted).toBe(true); expect(observed[1].aborted).toBe(false);
  });
});

it('retains provider work hidden by a handler response deadline until real settlement', async () => {
  let settle!: () => void;
  const late = new Promise<number[][]>((resolve) => { settle = () => resolve([[]]); });
  const context = remoteExecutionContext({} as never, { id: 'late', dim: 768, embed: () => late });
  let completed = false;
  const work = context.run(new AbortController().signal, async () => {
    void context.routing.providers()[0].embed(['one']);
    return 'handler-settled';
  }).then(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(completed).toBe(false); settle(); await work; expect(completed).toBe(true);
});
