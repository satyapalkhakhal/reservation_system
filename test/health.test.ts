import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startHarness, type Harness } from './helpers/harness.js';

describe('health', () => {
  let h: Harness;
  let down: Harness;
  beforeAll(async () => {
    h = await startHarness();
    // Points at a port nothing listens on: database unreachable.
    down = await startHarness({ DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none', DB_POOL_ACQUIRE_TIMEOUT_MS: '1000' });
  });
  afterAll(async () => {
    await h?.close();
    await down?.close();
  });

  it('live is 200 regardless of the database', async () => {
    expect((await api(h, 'GET', '/health/live')).status).toBe(200);
    expect((await api(down, 'GET', '/health/live')).status).toBe(200);
  });

  it('ready is 200 when PostgreSQL answers', async () => {
    const res = await api(h, 'GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', database: 'ok' });
  });

  it('ready fails closed with 503 when PostgreSQL is unreachable', async () => {
    const res = await api(down, 'GET', '/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', database: 'unavailable' });
  });

  it('reservations fail closed with 503 (not 500, never 201) when PostgreSQL is unreachable', async () => {
    const res = await api(down, 'POST', '/shows/00000000-0000-0000-0000-000000000000/reserve', {
      token: await down.token('alice'),
      body: { seats: ['A1'], idempotency_key: 'k1' },
    });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBe('1');
  });
});
