import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Pool } from './db/pool.js';
import { registerErrorHandler } from './common/errors/error-handler.js';
import { ShowService } from './modules/shows/service.js';
import { showRoutes } from './modules/shows/routes.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
}

export async function buildApp({ env, pool }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  registerErrorHandler(app);

  const shows = new ShowService(pool, env.PER_USER_LIMIT);

  app.get('/health/live', async () => ({ status: 'ok' }));
  await app.register(showRoutes, { shows });

  return app;
}
