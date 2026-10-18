import { randomUUID } from 'node:crypto';
import { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Env } from '../config/env.js';

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Fastify/pino options: JSON lines, ISO timestamps, string levels, a
 * request_id on every line logged through request.log, and redaction of
 * credentials so tokens never reach log storage.
 */
export function loggerOptions(
  env: Env,
  stream?: { write(line: string): void },
): Pick<
  FastifyServerOptions,
  'logger' | 'genReqId' | 'logController'
> {
  return {
    logger: {
      level: env.LOG_LEVEL,
      base: { service: 'seat-reservation', env: env.NODE_ENV },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          '*.access_token',
          '*.token',
          '*.password',
        ],
        censor: '[REDACTED]',
      },
      ...(stream ? { stream } : {}),
    },
    // Propagate a caller-supplied correlation id when it is well-formed;
    // otherwise mint one. (Never trust arbitrary header content into logs.)
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    logController: new LogController({
      requestIdLogLabel: 'request_id',
      // Replaced by a single structured "http_request" line in registerRequestLogging.
      disableRequestLogging: true,
    }),
  };
}

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/health/live' || route === '/health/ready' || route === '/metrics') return; // probe noise
    const entry = {
      event: 'http_request',
      method: request.method,
      route,
      status_code: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime * 100) / 100,
      user_id: request.authUser?.id,
    };
    // 4xx (incl. 409 conflicts) are expected client outcomes, not app errors.
    if (reply.statusCode >= 500) request.log.warn(entry, 'request failed');
    else request.log.info(entry, 'request completed');
  });
}
