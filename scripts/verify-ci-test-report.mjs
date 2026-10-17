import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const bytes = readFileSync('test-results.json');
const report = JSON.parse(bytes);
if (!report.success || report.numFailedTests || report.numFailedTestSuites || report.numPendingTests
    || !Array.isArray(report.testResults)) throw new Error('Required source tests failed or are incomplete');
const expected = readdirSync('src', { recursive: true }).filter(file => file.endsWith('.test.ts'))
  .map(file => `src/${file.replaceAll('\\', '/')}`).sort();
const actual = report.testResults.map(suite => relative(process.cwd(), suite.name).replaceAll('\\', '/')).sort();
if (actual.length !== new Set(actual).size || JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('Required test files do not match the current checkout');
}
const assertions = report.testResults.flatMap(suite => suite.assertionResults);
if (assertions.some(test => test.status !== 'passed') || assertions.length !== report.numTotalTests
    || assertions.length !== report.numPassedTests) throw new Error('Required test assertions failed or were skipped');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(head) || head !== process.env.GITHUB_SHA) throw new Error('Test checkout provenance mismatch');
const receipt = { head, node: process.version, files: actual, totalFiles: actual.length,
  totalTests: assertions.length, skippedTests: 0, testReportSha256: createHash('sha256').update(bytes).digest('hex') };
writeFileSync('test-coverage.json', `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ head, files: actual.length, tests: assertions.length, skipped: 0 }));
