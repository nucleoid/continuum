const phases = new Set(['validation', 'create-roles', 'database-grants', 'sync-administration',
  'application-schema', 'provider-schema', 'provider-extension', 'provider-grants', 'default-privileges']);
// Captured database output can contain credentials. Return only controlled codes.
export function safeBootstrapFailure(output) {
  const text = String(output);
  const match = /fresh database bootstrap failed at ([a-z-]+) \(([A-Z0-9]{5})\); review approved inputs and database state/.exec(text);
  if (match && phases.has(match[1])) return { code: 'BOOTSTRAP_SQL_FAILURE', phase: match[1], sqlstate: match[2] };
  if (/cat: [^\r\n]*: Permission denied/.test(text)) return { code: 'SECRET_READ_DENIED', phase: 'secret-read', sqlstate: null };
  if (/psql: (?:error: )?[^\r\n]*: Permission denied/.test(text)) return { code: 'SQL_ASSET_READ_DENIED', phase: 'sql-input', sqlstate: null };
  if (/psql: (?:error: )?connection to server[^\r\n]*failed/.test(text)) return { code: 'DATABASE_CONNECTION_FAILURE', phase: 'connect', sqlstate: null };
  if (/psql: not found/.test(text)) return { code: 'DATABASE_CLIENT_UNAVAILABLE', phase: 'client', sqlstate: null };
  if (/FATAL: {1,2}password authentication failed for user/.test(text)) return { code: 'DATABASE_AUTH_FAILURE', phase: 'connect', sqlstate: null };
  return { code: 'BOOTSTRAP_FAILURE_UNCLASSIFIED', phase: null, sqlstate: null };
}