import { closePool, getPool } from './pool.js';
import { runMigrations } from './migrator.js';

async function main(): Promise<void> {
  const pool = getPool();
  const applied = await runMigrations(pool);
  if (applied.length === 0) {
    console.log('No new migrations to apply.');
  } else {
    for (const m of applied) {
      console.log(`Applied ${m.name}`);
    }
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
