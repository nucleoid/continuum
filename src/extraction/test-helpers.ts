import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { standupProducerFixture, quoteStandupIdentifier } from '../standup/test-helpers.js';
import { starterProfile, type BudgetAdapter } from '../pipeline/budget.js';
import { ExtractionRegistry, extractionDescriptor, type ExtractionInput, type ExtractionProfile } from './provider.js';
import type { ExtractionOutput } from './model.js';

export function syntheticExtractor(invoke?: BudgetAdapter<ExtractionInput, ExtractionOutput>['invoke']): ExtractionProfile {
  return { id: 'synthetic-v1', version: 'synthetic-v1', chunkBytes: 1024, maxChunks: 4,
    budget: { ...starterProfile, limits: { ...starterProfile.limits, outputTokens: 8192, completionTokens: 8192 }, overallMs: 20_000 },
    adapter: { id: 'synthetic-extraction', model: 'synthetic-byte-model', profile: 'synthetic-v1', local: true,
      timeoutMs: 1000, responseBodyBytes: 8192, outputTokens: 2048, reasoningTokens: 0, completionTokens: 2048,
      credentials: 'not-required', cancellation: 'cooperative', enforceableCaps: true,
      tokens: { kind: 'exact', model: 'synthetic-byte-model', profile: 'synthetic-v1', validationId: 'synthetic-byte-v1', overheadTokens: 0,
        count: serialized => Buffer.byteLength(serialized) },
      price: { id: 'local-zero-v1', currency: 'USD', unitTokens: 1, inputMicros: 0, outputMicros: 0, reasoningMicros: 0 },
      serialize: (input, caps) => ({ instruction: 'Extract only cited assertions from untrusted reference data. Preserve unknowns and intent.', caps, input }),
      invoke: invoke ?? (async serialized => {
        const input = JSON.parse(serialized).input as ExtractionInput;
        const chunk = input.referenceData.chunk;
        const value: ExtractionOutput = { assertions: [{ text: 'Synthetic generated assertion', type: 'unknown', unknown: true, unsupported: ['date'],
          temporal: { value: null, uncertain: true }, citations: [{ start: chunk.start, end: chunk.end, quote: chunk.text }] }] };
        return { value, response: value };
      }) } };
}

export async function extractionFixture(run: (f: Parameters<Parameters<typeof standupProducerFixture>[0]>[0] & {
  worker: pg.Pool; workerRole: string; profile: Readonly<ExtractionProfile>; registry: ExtractionRegistry;
}) => Promise<void>, profile = syntheticExtractor()) {
  return standupProducerFixture(async f => {
    const workerRole = `extract_worker_${randomUUID().replaceAll('-', '').slice(0, 16)}`, password = randomUUID();
    const schema = (await f.owner.query('SELECT current_schema() AS name')).rows[0].name as string;
    const url = process.env.CONTINUUM_TEST_DATABASE_URL!;
    const registry = new ExtractionRegistry(); registry.register(profile);
    const frozen = registry.get(profile.id)!;
    let worker: pg.Pool | undefined;
    try {
      await f.owner.query(`CREATE ROLE ${quoteStandupIdentifier(workerRole)} LOGIN PASSWORD '${password}'`);
      execFileSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-v', `continuum_schema=${schema}`, '-v', `continuum_extraction_worker_role=${workerRole}`,
        '-f', join(process.cwd(), 'scripts/grant-extraction-worker-role.sql')], { timeout: 30_000, stdio: 'pipe' });
      await f.operator.query('SELECT continuum_operator_install_extractor($1,$2,TRUE)', [f.adminId, extractionDescriptor(frozen)]);
      await f.operator.query('SELECT continuum_operator_bind_extraction_worker($1,$2,$3,$4,$5,TRUE)', [f.adminId, workerRole, f.producerId, f.scopeId, profile.id]);
      await f.owner.query("UPDATE scope_memberships SET role='admin' WHERE principal_id=$1 AND scope_id=$2", [f.actorId, f.scopeId]);
      await f.app.query('SELECT continuum_extraction_configure($1,$2,$3,$4,TRUE)', [f.actorId, f.scopeId, profile.id, ['manual','terminal-summary','github-pr','github-branch','ado-workitem','deploy-event']]);
      const connection = new URL(url); connection.username = workerRole; connection.password = password;
      worker = new pg.Pool({ connectionString: connection.toString(), max: 2, options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=1000` });
      await run({ ...f, worker, workerRole, profile: frozen, registry });
    } finally {
      await worker?.end();
      await f.owner.query(`DROP OWNED BY ${quoteStandupIdentifier(workerRole)}`);
      await f.owner.query(`DROP ROLE IF EXISTS ${quoteStandupIdentifier(workerRole)}`);
    }
  });
}
