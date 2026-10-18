import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './config/env.js';
import type { Pool } from './db/pool.js';
import { registerErrorHandler } from './common/errors/error-handler.js';
import { ShowService } from './modules/shows/service.js';
import { showRoutes } from './modules/shows/routes.js';
import { JwtAuthService } from './modules/auth/service.js';
import { requireAuth } from './modules/auth/middleware.js';
import { devTokenRoutes } from './modules/auth/routes.js';
import { ReservationService } from './modules/reservations/service.js';
import { reservationRoutes } from './modules/reservations/routes.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
}

export async function buildApp({ env, pool }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
  });

  registerErrorHandler(app);
  app.decorateRequest('authUser', null);

  const auth = new JwtAuthService(env.JWT_SECRET, env.JWT_ISSUER, env.JWT_TTL_SECONDS);
  const authenticate = requireAuth(auth);
  const shows = new ShowService(pool, env.PER_USER_LIMIT);
  const reservations = new ReservationService(pool);

  app.get('/health/live', async () => ({ status: 'ok' }));
  if (env.AUTH_DEV_TOKENS_ENABLED) {
    await app.register(devTokenRoutes, { auth });
  }
  await app.register(showRoutes, { shows, authenticate });
  await app.register(reservationRoutes, { reservations, authenticate });

  return app;
}
