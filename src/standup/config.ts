export function standupReaderEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CONTINUUM_STANDUP_READER_ENABLED;
  if (raw === undefined || raw === '') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  throw new Error('CONTINUUM_STANDUP_READER_ENABLED must be true or false');
}
