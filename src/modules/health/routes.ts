import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../db/pool.js';

const READY_TIMEOUT_MS = 2_000;

/**
 * GET /health/live  - the process is up and serving HTTP. No dependencies.
 * GET /health/ready - PostgreSQL answers SELECT 1 within 2s; otherwise 503.
 *
 * Readiness uses a dedicated 2-connection pool (`healthPool`) so that a
 * saturated request pool during a reservation storm does not report the
 * instance as unready while the database itself is healthy.
 */
export async function healthRoutes(app: FastifyInstance, opts: { healthPool: Pool }): Promise<void> {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    try {
      await withTimeout(opts.healthPool.query('SELECT 1'), READY_TIMEOUT_MS);
      return { status: 'ready', database: 'ok' };
    } catch (err) {
      request.log.warn({ event: 'readiness_failed', err }, 'database not reachable');
      return reply.status(503).send({ status: 'not_ready', database: 'unavailable' });
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
