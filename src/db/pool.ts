import pg from 'pg';
import type { DbEnv } from '../config/env.js';

// Return BIGINT (int8) columns as JS numbers. Safe here: paise amounts are
// bounded far below Number.MAX_SAFE_INTEGER, and COUNT(*) results are small.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value out of safe range: ${v}`);
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(env: DbEnv): pg.Pool {
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    ssl: sslConfig(env),
    max: env.DB_POOL_MAX,
    // Also bounds how long a request waits in the pool queue for a client.
    connectionTimeoutMillis: env.DB_POOL_ACQUIRE_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: env.DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'seat-reservation',
  });
}

function sslConfig(env: DbEnv): pg.PoolConfig['ssl'] {
  switch (env.DATABASE_SSL_MODE) {
    case 'disable':
      return undefined;
    case 'verify':
      return { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}) };
    case 'no-verify':
      return { rejectUnauthorized: false };
  }
}
