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
// Only recognized client/orchestration error lines may leave private capture.
// Scrub before bounding, then check the complete result for every known secret.
export function sanitizedBootstrapLines(output, secrets) {
 if (!Array.isArray(secrets) || secrets.length !== 5 || secrets.some(value=>typeof value !== 'string' || value.length<32)) return [];
 let text = String(output);
 for (const secret of secrets) text = text.replaceAll(secret, '[redacted-secret]');
 text = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[redacted-url]')
  .replace(/[a-f0-9]{32,}/gi, '[redacted-token]')
  .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:;"']+/g, '[redacted-path]');
 const lines = text.split(/\r?\n/).filter(line=>/^(?:psql:|cat:|Error response from daemon:|the input device|\[redacted-path\]:)/.test(line))
  .slice(0,8).map(line=>line.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240));
 if (secrets.some(secret=>lines.some(line=>line.includes(secret)))) return [];
 return lines;
}
export function buildOwnerBoundaryProbeFunction(definition,probe) {
 return definition.replace('SECURITY DEFINER','SECURITY INVOKER').replace('BEGIN',probe);
}
