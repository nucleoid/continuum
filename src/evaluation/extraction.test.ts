import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { extractionFixture, syntheticExtractor } from '../extraction/test-helpers.js';
import { processExtraction } from '../workers/extraction.js';
import { createMemory } from '../storage/memories.js';
import type { ExtractionInput } from '../extraction/provider.js';
import type { ExtractionOutput } from '../extraction/model.js';

it('evaluates separately versioned persisted synthetic extraction without qualifying a model', async () => {
  const bytes = await readFile(resolve('evals/extraction-pilot-v1.json'));
  const spec = JSON.parse(bytes.toString());
  const samples: Array<Record<string, unknown>> = [];
  const observations: number[] = [];
  let markedUnknowns = 0, correctUnknowns = 0;
  const failures = { sourceChanges: 0, uncitedAssertions: 0, verifiedAssertions: 0, falseUnknowns: 0, missingUnknowns: 0, unsettledAttempts: 0, spendMicros: 0 };
  const profile = syntheticExtractor(async wire => {
    const input = JSON.parse(wire).input as ExtractionInput, chunk = input.referenceData.chunk;
    const source = JSON.parse(chunk.text) as { body: string };
    const value: ExtractionOutput = { assertions: source.body === 'EMPTY' ? [] : [{ text: source.body,
      type: source.body === 'UNKNOWN' ? 'unknown' : 'fact', unknown: source.body === 'UNKNOWN', unsupported: [],
      temporal: { value: null, uncertain: true }, citations: [{ start: chunk.start, end: chunk.end, quote: chunk.text }] }] };
    return { value, response: value };
  });
  await extractionFixture(async f => {
    for (const [index, body] of ['KNOWN', 'UNKNOWN', 'EMPTY'].entries()) {
      const memory = await createMemory(f.app, { scopeId: f.scopeId, scopeKind: 'user', authorId: f.actorId, type: 'decision', title: 'Synthetic evaluation source', body, source: 'manual' });
      const started = performance.now();
      expect(await processExtraction(f.worker, randomUUID(), f.profile)).toBe('processed');
      observations.push(performance.now() - started);
      const result = (await f.app.query('SELECT continuum_extraction_status($1,$2,TRUE) AS result', [f.actorId, memory.id])).rows[0].result;
      expect(result.status).toBe('complete'); expect(result.completed).toBe(1);
      const current = (await f.owner.query('SELECT body FROM memories WHERE id=$1', [memory.id])).rows[0].body;
      failures.sourceChanges += Number(current !== body);
      for (const item of result.items) {
        failures.uncitedAssertions += Number(item.data.assertion.citations.length === 0);
        failures.verifiedAssertions += Number(item.data.status !== 'generated/unverified');
        failures.falseUnknowns += Number(item.data.assertion.unknown && body !== 'UNKNOWN');
        failures.missingUnknowns += Number(!item.data.assertion.unknown && body === 'UNKNOWN');
        markedUnknowns += Number(item.data.assertion.unknown);
        correctUnknowns += Number(item.data.assertion.unknown && body === 'UNKNOWN');
      }
      failures.unsettledAttempts += result.budget.unsettledAttempts;
      failures.spendMicros += result.budget.charged.spendMicros;
      expect(result.items).toHaveLength(body === 'EMPTY' ? 0 : 1);
      samples.push({ id: spec.cases[index], status: result.status, completed: result.completed, assertions: result.assertions,
        budget: result.budget, elapsedMs: observations[index] });
    }
  }, profile);
  expect(failures).toEqual(spec.gates);
  // Reports are opt-in after expensive source/package work, in a quiet task
  // environment. Every requested report path is exclusive and task-local.
  const requested = process.env.CONTINUUM_EXTRACTION_EVAL_REPORT;
  if (requested) {
    const output = resolve(requested), root = resolve('.fire-off');
    if (dirname(output) !== root || !output.endsWith('.json')) throw new Error('Extraction report must be a new task-local JSON file');
    const head = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', process.cwd(), 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty || process.env.CONTINUUM_EVAL_SOURCE_SHA !== head) throw new Error('Extraction report requires clean exact source identity');
    const ordered = [...observations].sort((a, b) => a - b);
    await writeFile(output, JSON.stringify({ version: spec.version, fixtureHash: createHash('sha256').update(bytes).digest('hex'),
      head, model: profile.adapter.model, profile: profile.version, locality: 'local', prompt: 'source-reference-v1', schema: 'extraction-v1',
      failures, samples, p50Ms: ordered[1], p95Ms: ordered[2], unknownPrecision: markedUnknowns ? correctUnknowns / markedUnknowns : null,
      contradictionPrecision: null, contradictionQualification: 'not-supported by this synthetic extractor',
      realModelQualified: false, pairedPerformanceQualified: false, normalizedStorageQualified: false,
      qualification: spec.qualification }, null, 2) + '\n', { flag: 'wx' });
  }
}, 120_000);
