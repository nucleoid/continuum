import { describe, expect, it } from 'vitest';
import { remoteExecutionContext } from './mcp-http-execution.js';
describe('remote per-call execution context', () => {
  it('prevents post-cancellation SQL side effects but permits transactional rollback', async () => {
    const calls: string[] = [];
    const client = { query: async (text: string) => { calls.push(text); return { rows: [] }; }, release: () => undefined };
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
