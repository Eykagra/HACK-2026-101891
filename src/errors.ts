/**
 * Typed domain errors.
 *
 * Expected failures are values inside the engine (`Result`) and typed errors at
 * the service boundary. `src/http/problem.ts` is the single place that maps
 * them to HTTP, so no handler ever invents a status code and no stack trace
 * ever reaches a client.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CYCLE_DETECTED'
  | 'SELF_EDGE'
  | 'DUPLICATE_DEPENDENCY'
  | 'UNKNOWN_TASK'
  | 'STALE_WRITE'
  | 'RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationFailed = (message: string, issues: unknown[] = []) =>
  new AppError('VALIDATION_FAILED', 422, message, { issues });

export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} was not found.`);

/**
 * The invalid dependency is never persisted: the service validates and writes
 * inside one transaction, so raising this rolls the insert back and leaves the
 * existing graph byte-identical.
 */
export const cycleDetected = (message: string, cyclePath: string[], cycleKeys: string[]) =>
  new AppError('CYCLE_DETECTED', 409, message, { cyclePath, cycleKeys });

export const selfEdge = (message: string) => new AppError('SELF_EDGE', 409, message);

export const duplicateDependency = (message: string) =>
  new AppError('DUPLICATE_DEPENDENCY', 409, message);

export const unknownTask = (message: string) => new AppError('UNKNOWN_TASK', 422, message);

export const staleWrite = (expected: number, actual: number) =>
  new AppError(
    'STALE_WRITE',
    409,
    'This task changed in another tab or window. Reload and try again.',
    { expectedVersion: expected, currentVersion: actual },
  );

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError('RATE_LIMITED', 429, 'Too many requests. Please slow down.', {
    retryAfterSeconds,
  });

export const aiUnavailable = (message: string, details: Record<string, unknown> = {}) =>
  new AppError('AI_UNAVAILABLE', 503, message, details);

export const forbidden = (message: string) => new AppError('FORBIDDEN', 403, message);
