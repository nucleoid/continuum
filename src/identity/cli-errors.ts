import { asServiceError } from '../services/errors.js';

export function cliFailure(event: string, error: unknown): string {
  const safe = asServiceError(error);
  return JSON.stringify({ event, code: safe.code, message: safe.publicMessage });
}
