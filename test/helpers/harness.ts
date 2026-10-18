import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { JwtAuthService } from '../../src/modules/auth/service.js';

export const TEST_JWT_SECRET = 'test-secret-test-secret-test-secret-0001';

export interface Harness {
  app: FastifyInstance;
  pool: Pool;
  env: Env;
  baseUrl: string;
  token(userId: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Real app listening on a random port, backed by the shared test database.
 * Requests go over real HTTP so concurrency goes through the real pool.
 */
export async function startHarness(
  overrides: Partial<Record<string, string>> = {},
  logStream?: { write(line: string): void },
): Promise<Harness> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    JWT_SECRET: TEST_JWT_SECRET,
    LOG_LEVEL: 'silent',
    DB_POOL_MAX: '20',
    AUTH_DEV_TOKENS_ENABLED: 'true',
    ...overrides,
  });
  const pool = createPool(env);
  const app = await buildApp({ env, pool, logStream });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const auth = new JwtAuthService(env.JWT_SECRET, env.JWT_ISSUER, env.JWT_TTL_SECONDS);

  return {
    app,
    pool,
    env,
    baseUrl,
    token: async (userId) => (await auth.issue(userId)).access_token,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  h: Harness,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

export async function createShow(
  h: Harness,
  input: { seats: string[] | number; price_paise?: number; per_user_limit?: number; name?: string },
): Promise<{ id: string; seats: string[] }> {
  const seats = typeof input.seats === 'number' ? seatRange(input.seats) : input.seats;
  const res = await api(h, 'POST', '/shows', {
    token: await h.token('admin'),
    body: {
      name: input.name ?? `show-${randomUUID().slice(0, 8)}`,
      seats,
      price_paise: input.price_paise ?? 25_000,
      ...(input.per_user_limit ? { per_user_limit: input.per_user_limit } : {}),
    },
  });
  if (res.status !== 201) throw new Error(`createShow failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, seats };
}

export function seatRange(n: number, row = 'A'): string[] {
  return Array.from({ length: n }, (_, i) => `${row}${i + 1}`);
}

export function key(): string {
  return randomUUID();
}

export function countBy<T>(items: T[], fn: (t: T) => string | number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = String(fn(i));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
