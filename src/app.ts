import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';

export interface AppDeps {
  env: Env;
}

export async function buildApp({ env }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  app.get('/health/live', async () => ({ status: 'ok' }));

  return app;
}
