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
import { healthRoutes } from './modules/health/routes.js';
import { createMetrics } from './observability/metrics.js';
import { metricsPlugin } from './observability/http-metrics.js';
import { loggerOptions, registerRequestLogging } from './observability/logger.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
  /** Separate small pool for readiness checks. Defaults to `pool`. */
  healthPool?: Pool;
  /** Override log destination (tests capture log lines). */
  logStream?: { write(line: string): void };
}

export async function buildApp({ env, pool, healthPool, logStream }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    ...loggerOptions(env, logStream),
    // Behind a load balancer/proxy (Render, Fly, etc.): honour X-Forwarded-*.
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  registerRequestLogging(app);
  registerErrorHandler(app);
  app.decorateRequest('authUser', null);

  const auth = new JwtAuthService(env.JWT_SECRET, env.JWT_ISSUER, env.JWT_TTL_SECONDS);
  const authenticate = requireAuth(auth);
  const shows = new ShowService(pool, env.PER_USER_LIMIT);
  const reservations = new ReservationService(pool);
  const metrics = createMetrics(pool);

  // Hooks registered inside a plugin apply only to that plugin's routes unless
  // the plugin is unencapsulated; register the HTTP hook at the root instead.
  await metricsPlugin(app, { metrics, aggregatorPort: env.METRICS_AGG_PORT });
  await app.register(healthRoutes, { healthPool: healthPool ?? pool });
  if (env.AUTH_DEV_TOKENS_ENABLED) {
    await app.register(devTokenRoutes, { auth });
  }
  await app.register(showRoutes, { shows, authenticate });
  await app.register(reservationRoutes, { reservations, authenticate, metrics });

  return app;
}
