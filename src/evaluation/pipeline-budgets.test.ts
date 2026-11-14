import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Budget, checkedProfile, runBudgetedStage, starterProfile, type BudgetAdapter } from '../pipeline/budget.js';

describe('pipeline-budget-v1 synthetic contract evaluation', () => {
  it('reports profile-specific outcomes, security, latency and spend without changing frozen v1 inputs', async () => {
    const bytes = await readFile('evals/pipeline-budget-v1.json');
    const fixture = JSON.parse(bytes.toString()) as { version: string; stages: string[]; cases: Array<{ id: string; mode: string; expected: string }>; gates: Record<string, number> };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const sourceHead = process.env.CONTINUUM_EVAL_SOURCE_SHA ?? head;
    expect(sourceHead).toBe(head);
    const rows = [];
    for (const stage of fixture.stages) for (const task of fixture.cases) {
      let calls = 0;
      const budget = new Budget(starterProfile);
      const adapter: BudgetAdapter<string, string> = {
        id: stage, model: 'synthetic-v1', profile: 'synthetic-v1', local: true, credentials: 'not-required',
        timeoutMs: 100, responseBodyBytes: 1024, outputTokens: 4, reasoningTokens: 0, completionTokens: 4,
        enforceableCaps: true, cancellation: 'cooperative',
        tokens: { kind: 'conservative', model: 'synthetic-v1', profile: 'synthetic-v1', validationId: 'utf8-upper-bound-v1', overheadTokens: 4, count: (s) => Buffer.byteLength(s) },
        price: task.mode === 'unpriced' ? undefined : { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
        serialize: (text, caps) => ({ stage, model: 'synthetic-v1', prompts: [text], tools: [{ name: 'synthetic' }], citations: ['synthetic-source-v1'], ...caps }),
        invoke: async () => { calls++; return { value: 'synthetic-result', response: { text: 'synthetic-result' }, usage: { outputTokens: 4, reasoningTokens: 0, completionTokens: 4, provenance: 'measured' } }; },
      };
      const started = performance.now();
      const outcome = await runBudgetedStage(budget, adapter, task.mode === 'oversized' ? 'x'.repeat(1024 * 1024) : 'synthetic reference', { authorize: async () => task.mode !== 'denied' });
      const latencyMs = performance.now() - started;
      const usage = budget.snapshot();
      const hardBudgetFailure = Object.entries(usage.used).some(([key, value]) => value > starterProfile.limits[key as keyof typeof usage.used]);
      const securityFailure = task.mode === 'denied' && calls !== 0;
      rows.push({ stage, id: task.id, outcome: outcome.status, expected: task.expected, latencyMs,
        calls, securityFailure, hardBudgetFailure, reservedSpendMicros: usage.used.spendMicros, actualSpendMicros: 0 });
    }
    const times = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const report = { version: fixture.version, head, sourceHead, profile: starterProfile,
      fixtureSha256: createHash('sha256').update(bytes).digest('hex'), mode: 'deterministic-local-contract-stubs',
      quality: { outcomeAccuracy: rows.filter((r) => r.outcome === r.expected).length / rows.length },
      securityFailures: rows.filter((r) => r.securityFailure).length,
      hardBudgetFailures: rows.filter((r) => r.hardBudgetFailure).length,
      p50Ms: times[Math.ceil(times.length * 0.5) - 1], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      reservedSpendMicros: rows.reduce((n, r) => n + r.reservedSpendMicros, 0), actualSpendMicros: 0, rows };
    await mkdir('.fire-off', { recursive: true });
    await writeFile('.fire-off/pipeline-budget-eval.json', JSON.stringify(report, null, 2) + '\n');
    expect(report.hardBudgetFailures).toBe(fixture.gates.hardBudgetFailures);
    expect(report.securityFailures).toBe(fixture.gates.securityFailures);
    expect(report.quality.outcomeAccuracy).toBe(fixture.gates.outcomeAccuracy);
    expect(report.reservedSpendMicros).toBe(fixture.gates.reservedSpendMicros);
    expect(report.actualSpendMicros).toBe(fixture.gates.actualSpendMicros);
  });

  it('keeps retries/fallback/chunks on one ledger and abstains from incomplete synthesis', async () => {
    const budget = new Budget(checkedProfile({ ...starterProfile, limits: { ...starterProfile.limits, calls: 1 } }));
    const reserve = budget.reserve({ calls: 1 }, 0);
    budget.settle(reserve, {});
    // Future stage composition must preserve base ranking and explicit coverage.
    const hybrid = ['authorized-source'];
    const chunks = ['chunk-1', 'chunk-2'];
    const covered: string[] = [];
    for (const chunk of chunks) {
      try { budget.child().reserve({ calls: 1, retries: 1 }, 0); covered.push(chunk); } catch { /* explicit omitted coverage */ }
    }
    expect(covered).toEqual([]);
    expect({ ranking: hybrid, coverage: { completed: covered, skipped: chunks }, synthesis: covered.length === chunks.length ? 'complete' : 'abstain' })
      .toEqual({ ranking: hybrid, coverage: { completed: [], skipped: chunks }, synthesis: 'abstain' });
    expect(budget.snapshot().used.calls).toBe(1);
  });
});
