import type { FastifyError, FastifyInstance } from 'fastify';
import { DomainError } from './domain-errors.js';
import { PG, pgErrorCode } from '../../db/pg-errors.js';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// Errors meaning "the database is overloaded or unreachable right now".
// We fail closed with a retryable 503 instead of guessing.
const DB_UNAVAILABLE_CODES = new Set<string>([
  PG.LOCK_NOT_AVAILABLE,
  PG.QUERY_CANCELED,
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', '08003', '08006', '08001', '08004', // connection exceptions
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);

export function isDbUnavailable(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (code && DB_UNAVAILABLE_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : '';
  // pg-pool acquisition timeout / connection loss messages.
  return /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(msg);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | Error>((err, request, reply) => {
    if (err instanceof DomainError) {
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      if (err.statusCode === 503) reply.header('Retry-After', '1');
      return reply.status(err.statusCode).send(body);
    }

    if (isDbUnavailable(err)) {
      request.log.warn({ event: 'database_unavailable', err }, 'database unavailable');
      return reply
        .status(503)
        .header('Retry-After', '1')
        .send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database temporarily unavailable, retry later' } });
    }

    // Fastify's own client errors (malformed JSON, wrong content-type, body too large...).
    const statusCode = (err as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message },
      });
    }

    request.log.error({ event: 'unhandled_error', err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });
}
