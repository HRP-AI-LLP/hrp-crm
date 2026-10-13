import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { AppEnv } from '../env';

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg: string, details?: unknown) => new ApiError(409, 'conflict', msg, details);
export const tooMany = (msg = 'Too many requests') => new ApiError(429, 'rate_limited', msg);

/** Maps Postgres errors to safe API errors without leaking internals. */
function fromPg(err: { code?: string; constraint?: string; detail?: string }): ApiError | null {
  switch (err.code) {
    case '23505':
      return conflict('A record with the same unique value already exists', { constraint: err.constraint });
    case '23503':
      return badRequest('A referenced record does not exist or is not accessible', { constraint: err.constraint });
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22003':
      return badRequest('Invalid value', { constraint: err.constraint });
    case '42501':
      return forbidden();
    case '40001':
    case '40P01':
      return new ApiError(409, 'retry', 'Concurrent update, please retry');
    default:
      return null;
  }
}

export function onError(err: Error, c: Context<AppEnv>) {
  const requestId = c.get('requestId');
  let e: ApiError;
  if (err instanceof ApiError) e = err;
  else if (err instanceof ZodError) e = badRequest('Validation failed', err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  else if (err instanceof HTTPException) e = new ApiError(err.status as ContentfulStatusCode, 'http_error', err.message);
  else e = fromPg(err as never) ?? new ApiError(500, 'internal', 'Internal error');

  if (e.status >= 500) {
    console.error(JSON.stringify({ level: 'error', requestId, msg: err.message, stack: err.stack?.split('\n').slice(0, 5) }));
  }
  return c.json({ error: { code: e.code, message: e.message, details: e.details, requestId } }, e.status);
}
