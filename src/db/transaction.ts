import type { Pool, PoolClient } from './pool.js';
import { PG, pgErrorCode } from './pg-errors.js';

export interface TransactionOptions {
  /**
   * How many times to re-run the whole transaction after a deadlock or
   * serialization failure. Our lock ordering should make these impossible;
   * this is a backstop so they never surface as a 500.
   */
  maxAttempts?: number;
}

const RETRYABLE = new Set<string>([PG.DEADLOCK_DETECTED, PG.SERIALIZATION_FAILURE]);

/**
 * Run `fn` inside BEGIN/COMMIT on a single pooled client.
 *
 * - Every query inside `fn` MUST use the provided `client` (never the pool),
 *   so all work shares one connection and one transaction.
 * - Any throw triggers ROLLBACK and is re-thrown (domain errors included).
 * - The client is always released; if ROLLBACK itself fails the connection
 *   is destroyed rather than returned to the pool in an unknown state.
 * - Isolation is the PostgreSQL default, READ COMMITTED, which the
 *   reservation protocol relies on (each statement sees rows committed
 *   before it started, including after waiting on a row lock).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseError = rollbackErr as Error;
      }
      const code = pgErrorCode(err);
      if (code && RETRYABLE.has(code) && attempt < maxAttempts) {
        await sleep(jitter(attempt));
        continue;
      }
      throw err;
    } finally {
      client.release(releaseError);
    }
  }
}

function jitter(attempt: number): number {
  return Math.floor(Math.random() * 20 * attempt) + 5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
