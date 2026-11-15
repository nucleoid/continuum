import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectorFixture } from '../connectors/test-helpers.js';
import { RepositoryEvidenceRegistry } from '../connectors/registry.js';
import { queryConnectorEvidence } from '../services/connector-evidence.js';
import { recallForPrincipal } from '../services/recall.js';
import { createMemory } from '../storage/memories.js';
import { getPrincipal } from '../storage/principals.js';
import { getScopeByRef } from '../storage/scopes.js';
import { readBudgetWorkflow } from '../storage/pipeline-budgets.js';

it('qualifies quiet synthetic baseline/allowed/denied/unavailable/stale repository ablations', async () => {
  const bytes = await readFile(join(process.cwd(), 'evals/repository-evidence-v1.json'));
  const fixture = JSON.parse(bytes.toString());
  const rows: Array<Record<string, unknown>> = [];
  let correct = 0, securityFailures = 0, spendMicros = 0;
  await connectorFixture(async f => {
    const actor = (await getPrincipal(f.app, f.actorId))!, org = (await getScopeByRef(f.owner, { kind: 'org', name: '' }))!;
    const source = await createMemory(f.owner, { scopeId: org.id, scopeKind: 'org', authorId: f.actorId,
      type: 'decision', title: 'Synthetic policy', body: 'Synthetic policy baseline reference', source: 'manual' });
    for (const variant of fixture.variants) {
      const timings: number[] = [], accounting: unknown[] = [];
      for (let sample = 0; sample < fixture.samplesPerVariant; sample++) {
        const options = await f.options();
        f.proof.decision = variant.id === 'denied-code' ? 'deny' : 'allow';
        f.proof.commit = variant.id === 'stale-code' ? null : 'a'.repeat(40);
        if (variant.id === 'unavailable-code') options.registry = new RepositoryEvidenceRegistry();
        const callsBefore = f.queryCalls.mock.calls.length;
        const started = performance.now();
        let outcome: string;
        if (variant.id === 'non-code-baseline') {
          const baseline = await recallForPrincipal(f.app, null, actor, { query: 'synthetic policy', limit: 5 }, {}, undefined, undefined, options.budget);
          expect(baseline.results.some(result => result.memory.id === source.id)).toBe(true);
          outcome = 'baseline';
        } else {
          const result = await queryConnectorEvidence(f.app, f.actorId, f.mappingId,
            { evidenceClass: 'source-code', query: 'synthetic source', commit: 'a'.repeat(40), maxResults: 2 }, options);
          outcome = result.receipt.outcome;
          if (variant.id !== 'allowed-code' && (result.evidence !== undefined || result.evidenceVersion !== undefined
            || f.queryCalls.mock.calls.length !== callsBefore || JSON.stringify(result).includes(f.proof.repository))) securityFailures++;
          if (variant.id === 'allowed-code') expect(result.evidence?.items[0].kind).toBe('vcs');
        }
        timings.push(performance.now() - started);
        if (outcome === variant.expected) correct++;
        const durable = (await readBudgetWorkflow(f.app, options.execution.workflowId)).used;
        expect(options.budget.snapshot().used.spendMicros).toBe(0);
        spendMicros += durable.spendMicros;
        accounting.push({ local: options.budget.report(), durable });
      }
      timings.sort((a, b) => a - b);
      rows.push({ variant: variant.id, samples: timings.length, p50Ms: timings[Math.floor(timings.length * .5)],
        p95Ms: timings[Math.min(timings.length - 1, Math.floor(timings.length * .95))], accounting });
    }
  });
  const total = fixture.variants.length * fixture.samplesPerVariant;
  expect(correct / total).toBe(fixture.gates.outcomeAccuracy);
  expect(securityFailures).toBe(fixture.gates.securityFailures);
  expect(rows.length / fixture.variants.length).toBe(fixture.gates.variantCoverage);
  expect(spendMicros).toBe(fixture.gates.spendMicros);
  const report = { schemaVersion: fixture.schemaVersion, qualification: fixture.qualification,
    fixtureSha256: createHash('sha256').update(bytes).digest('hex'), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    outcomeAccuracy: correct / total, variantCoverage: rows.length / fixture.variants.length, securityFailures, spendMicros,
    spendProvenance: 'Synthetic zero-price fixtures; unknown completion usage retains maxima in complete per-sample accounting', rows };
  await mkdir(join(process.cwd(), '.fire-off'), { recursive: true });
  await writeFile(join(process.cwd(), '.fire-off/repository-evidence-eval.json'), JSON.stringify(report, null, 2) + '\n');
}, 120_000);
