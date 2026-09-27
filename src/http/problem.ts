/**
 * RFC 9457 problem details.
 *
 * Every failure leaves the API in the same shape, so the frontend has exactly
 * one error-rendering path. Two properties matter more than the format:
 *
 *  - A rejection carries the *reason* in machine-readable form. A cycle refusal
 *    returns the offending path, so the UI can say "TF-3 → TF-5 → TF-3" instead
 *    of "Bad Request".
 *  - An unexpected error returns a correlation id and nothing else. Stack traces
 *    and SQL fragments stay in the server log where they belong.
 */

import { AppError, type ErrorCode } from '../errors.ts';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
  requestId: string;
  [key: string]: unknown;
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Validation failed',
  NOT_FOUND: 'Not found',
  CYCLE_DETECTED: 'Circular dependency rejected',
  SELF_EDGE: 'A task cannot depend on itself',
  DUPLICATE_DEPENDENCY: 'Dependency already exists',
  UNKNOWN_TASK: 'Unknown task',
  STALE_WRITE: 'Conflicting update',
  RATE_LIMITED: 'Too many requests',
  AI_UNAVAILABLE: 'AI provider unavailable',
  FORBIDDEN: 'Forbidden',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  INTERNAL: 'Internal server error',
};

/** Stable documentation URIs, so clients can branch on `type` not on prose. */
const typeUri = (code: ErrorCode): string =>
  `https://taskflow.pro/problems/${code.toLowerCase().replace(/_/g, '-')}`;

export function toProblem(error: unknown, requestId: string): Problem {
  if (error instanceof AppError) {
    return {
      type: typeUri(error.code),
      title: TITLES[error.code],
      status: error.status,
      detail: error.message,
      code: error.code,
      requestId,
      ...error.details,
    };
  }

  // Unknown errors are opaque by design: the client gets an id to quote, the
  // log gets the detail.
  return {
    type: typeUri('INTERNAL'),
    title: TITLES.INTERNAL,
    status: 500,
    detail: 'An unexpected error occurred. Quote the request id when reporting it.',
    code: 'INTERNAL',
    requestId,
  };
}
