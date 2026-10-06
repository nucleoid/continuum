import { getPool, closePool } from '../storage/pool.js';
import { cliFailure } from './cli-errors.js';
import { runMembershipSync } from './sync-runner.js';

async function main(): Promise<void> {
  const pool = getPool();
  try {
    const result = await runMembershipSync(pool);
    process.stdout.write(`${JSON.stringify({ event: 'entra_membership_sync_complete', ...result })}\n`);
  } finally {
    await closePool();
  }
}

void main().catch((error) => {
  process.stderr.write(`${cliFailure('entra_membership_sync_failed', error)}\n`);
  process.exitCode = 1;
});
