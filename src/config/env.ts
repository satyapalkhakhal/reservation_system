import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Kernel accept-queue size for the HTTP listener (Node defaults to 511).
  // Bursts of new connections beyond it are dropped by the kernel and surface
  // as connection resets / 502s at the proxy. Capped by net.core.somaxconn.
  LISTEN_BACKLOG: z.coerce.number().int().positive().default(4096),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // disable: plain TCP (local/compose, private networks)
  // verify:  TLS with certificate verification (system CAs, or DATABASE_CA_CERT)
  // no-verify: TLS without verification; explicit opt-in only, never the default
  DATABASE_SSL_MODE: z.enum(['disable', 'verify', 'no-verify']).default('disable'),
  DATABASE_CA_CERT: z.string().optional(),
  // Connections per process. Unset: 20 for a single process, or an equal
  // share of DB_POOL_TOTAL per worker in cluster mode.
  DB_POOL_MAX: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  DB_POOL_TOTAL: z.coerce.number().int().positive().default(160),
  // How long a request may wait for a free pool connection before we answer 503.
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Upper bound on waiting for a row lock inside a transaction (hot-seat queue).
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Node runs JS on one core per process. "auto" = one worker per CPU core
  // (node:cluster, shared listening socket), or a fixed number. 1 = no cluster.
  WEB_CONCURRENCY: z
    .union([z.literal('auto'), z.coerce.number().int().min(1).max(128)])
    .default(1),
  // Internal port (127.0.0.1 only) where the cluster primary serves metrics
  // aggregated across workers; /metrics on any worker proxies to it.
  METRICS_AGG_PORT: z.coerce.number().int().positive().default(9464),

  PER_USER_LIMIT: z.coerce.number().int().positive().default(4),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('seat-reservation'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Exposes POST /auth/dev-token. Assignment/demo convenience only.
  AUTH_DEV_TOKENS_ENABLED: booleanString.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

const DbEnvSchema = EnvSchema.pick({
  DATABASE_URL: true,
  DATABASE_SSL_MODE: true,
  DATABASE_CA_CERT: true,
  DB_POOL_MAX: true,
  DB_POOL_TOTAL: true,
  DB_POOL_ACQUIRE_TIMEOUT_MS: true,
  DB_LOCK_TIMEOUT_MS: true,
  DB_STATEMENT_TIMEOUT_MS: true,
});
export type DbEnv = z.infer<typeof DbEnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseOrThrow(EnvSchema, source);
}

/** Only the database settings (used by the migration CLI). */
export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return parseOrThrow(DbEnvSchema, source);
}

function parseOrThrow<S extends z.ZodType>(schema: S, source: NodeJS.ProcessEnv): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Number of cluster workers (1 = run the app in this process). */
export function resolveWorkers(env: Pick<Env, 'WEB_CONCURRENCY'>, cpus: number): number {
  return env.WEB_CONCURRENCY === 'auto' ? Math.max(1, cpus) : env.WEB_CONCURRENCY;
}

/** Pool size for one process, keeping workers * pool within DB_POOL_TOTAL. */
export function resolvePoolMax(env: Pick<DbEnv, 'DB_POOL_MAX' | 'DB_POOL_TOTAL'>, workers: number): number {
  if (env.DB_POOL_MAX !== undefined) return env.DB_POOL_MAX;
  return workers > 1 ? Math.max(4, Math.floor(env.DB_POOL_TOTAL / workers)) : 20;
}
