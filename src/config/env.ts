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
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  // How long a request may wait for a free pool connection before we answer 503.
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Upper bound on waiting for a row lock inside a transaction (hot-seat queue).
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

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
