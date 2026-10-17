import { readFileSync } from 'node:fs';
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const skipped = result.testResults.flatMap(suite => suite.assertionResults)
  .filter(test => ['pending', 'skipped', 'todo', 'disabled'].includes(test.status));
if (!result.success || result.numFailedTests || result.numFailedTestSuites) throw new Error('Required source tests failed');
if (skipped.length) throw new Error(`Required suite has ${skipped.length} skipped tests; inspect DB/psql prerequisites before claiming coverage`);
