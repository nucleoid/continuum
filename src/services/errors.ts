export type ServiceErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_SCOPE'
  | 'FORBIDDEN'
  | 'SCOPE_NOT_FOUND'
  | 'MEMORY_NOT_FOUND'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LEASE_LOST'
  | 'COORDINATION_QUOTA_EXCEEDED'
  | 'FENCING_TOKEN_EXHAUSTED'
  | 'COORDINATION_TIMEOUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_SCOPE: 400,
  FORBIDDEN: 403,
  SCOPE_NOT_FOUND: 404,
  MEMORY_NOT_FOUND: 404,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  LEASE_LOST: 409,
  COORDINATION_QUOTA_EXCEEDED: 409,
  FENCING_TOKEN_EXHAUSTED: 409,
  COORDINATION_TIMEOUT: 503,
  PAYLOAD_TOO_LARGE: 413,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ServiceError extends Error {
  readonly status: number;

  constructor(
    readonly code: ServiceErrorCode,
    readonly publicMessage: string,
    options: { cause?: unknown; status?: number; details?: Record<string, unknown> } = {},
  ) {
    super(publicMessage, { cause: options.cause });
    this.name = 'ServiceError';
    this.status = options.status ?? STATUS_BY_CODE[code];
    this.details = options.details;
  }
  readonly details?: Record<string, unknown>;
}

export function asServiceError(error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError('INTERNAL', 'An internal error occurred', { cause: error });
}

export function dependencyUnavailable(error: unknown): ServiceError {
  return new ServiceError(
    'DEPENDENCY_UNAVAILABLE',
    'A required dependency is unavailable',
    { cause: error },
  );
}

export interface ServiceLogger {
  error(message: string, error: unknown): void;
}

export function logInternalServiceError(
  logger: ServiceLogger,
  context: string,
  error: ServiceError,
): void {
  if (error.code === 'INTERNAL') {
    logger.error(`${context}: internal service error`, error.cause ?? error);
  }
}

export function serviceErrorBody(error: ServiceError): {
  error: { code: ServiceErrorCode; message: string; details?: Record<string, unknown> };
} {
  return { error: { code: error.code, message: error.publicMessage, ...(error.details ? { details: error.details } : {}) } };
}
