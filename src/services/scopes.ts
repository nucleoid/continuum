import type { ScopeRef } from '../types.js';
import { parseScopeString as parseScopeModel } from '../scopes/model.js';
import { ServiceError } from './errors.js';

export function validateScopeRef(ref: ScopeRef): ScopeRef {
  if (ref.kind === 'org' ? ref.name !== '' : ref.name.length === 0) {
    throw new ServiceError('INVALID_SCOPE', 'Invalid scope');
  }
  return ref;
}

export function parseScopeString(value: string): ScopeRef {
  try {
    return validateScopeRef(parseScopeModel(value));
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INVALID_SCOPE', 'Invalid scope', { cause: error });
  }
}
