import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, runBaseline, boundReport, RUNNER_VERSION } from '../dist/evaluation/test-helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
// No environment-selected provider, connector, model judge, or private corpus is loaded.
// A live runner needs separate explicit approval and an implemented bounded adapter.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output') {
  console.error('Usage: npm run eval:memory -- --manifest evals/offline-v1.json --output .fire-off/baseline.json');
  process.exit(2);
}
let timer;
let failureCode = 'PROFILE';
const controller = new AbortController();
try {
  const manifestPath = resolve(args[1]);
  const output = resolve(args[3]);
  const withinFixtures = relative(resolve('evals/fixtures'), output);
  if (!output.endsWith('.json') || output === manifestPath || (!withinFixtures.startsWith('..') && !isAbsolute(withinFixtures))) throw new Error('Invalid output');
  if ((await stat(manifestPath)).size > 16_384) throw new Error('Run manifest bound');
  const text = await readFile(manifestPath, 'utf8');
  if (Buffer.byteLength(text) > 16_384) throw new Error('Run manifest bound');
  const manifest = JSON.parse(text);
  const expected = ['schema', 'mode', 'fixtureVersion', 'seed', 'runner', 'budgetProfile'];
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expected.sort()) || manifest.schema !== 1
      || manifest.mode !== 'offline' || manifest.fixtureVersion !== 'v1' || manifest.seed !== 25
      || manifest.runner !== RUNNER_VERSION || manifest.budgetProfile !== 'frozen-v1') throw new Error('Unsupported run profile');
  const databaseUrl = process.env.CONTINUUM_EVAL_DATABASE_URL;
  if (!databaseUrl) throw new Error('CONTINUUM_EVAL_DATABASE_URL must name a disposable-test maintenance connection');
  failureCode = 'CHECKOUT_METADATA';
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim()) {
    failureCode = 'DIRTY_CHECKOUT'; throw new Error('Commit intended source files before recording a baseline');
  }
  failureCode = 'FIXTURE_SCHEMA';
  const corpus = await loadCorpus();
  timer = setTimeout(() => controller.abort(), corpus.manifest.budgets.maxSetupMs + corpus.manifest.budgets.maxDurationMs);
  failureCode = 'DB_OR_SERVICE';
  const report = await runBaseline(corpus, databaseUrl, head, manifest.seed, controller.signal);
  failureCode = 'REPORT_BOUND';
  const bytes = boundReport({ ...report, runManifest: manifest });
  const human = `# Memory evaluation\n\nHead: ${head}\nFixture: ${report.fixtureManifest}\n` +
    `Mode: offline synthetic stub, no live quality claim\n\nMeasured: ${report.sampleCounts.measured}; unsupported: ${report.sampleCounts.unsupported}; failed: ${report.sampleCounts.failed}\n` +
    `Latency p50/p95: ${report.latencyMs.p50}/${report.latencyMs.p95} ms\n` +
    `Mechanism gate: ${report.gates.mechanism}\nQuality acceptance: ${report.gates.qualityAcceptance}\nRelationship expansion: ${report.gates.relationshipExpansion}\n` +
    `\nCandidate counts and model token usage are unavailable, reported as null. Future adapters are not_supported.\n`;
  await mkdir(dirname(output), { recursive: true });
  failureCode = 'OUTPUT_WRITE';
  await writeFile(output, bytes, { flag: 'wx' });
  await writeFile(output.slice(0, -5) + '.md', human, { flag: 'wx' });
  console.log(JSON.stringify({ output, head, gates: report.gates, sampleCounts: report.sampleCounts }));
  if (report.gates.mechanism !== 'pass') { console.error(JSON.stringify({ status: 'failed', code: 'MECHANISM_FAIL' })); process.exitCode = 1; }
} catch {
  // Connection strings and raw DB/provider errors must never enter an artifact or terminal.
  console.error(JSON.stringify({ status: 'failed', code: controller.signal.aborted ? 'EVALUATION_DEADLINE' : failureCode }));
  process.exitCode = 1;
} finally { clearTimeout(timer); }
