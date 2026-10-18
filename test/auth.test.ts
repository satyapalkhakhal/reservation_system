import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { api, createShow, key, startHarness, TEST_JWT_SECRET, type Harness } from './helpers/harness.js';
import { assertReconciled } from './helpers/reconcile.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function sign(opts: { secret?: string; sub?: string; issuer?: string; exp?: number | string }) {
  let jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer(opts.issuer ?? 'seat-reservation');
  if (opts.sub !== undefined) jwt = jwt.setSubject(opts.sub);
  jwt = jwt.setExpirationTime(opts.exp ?? '1h');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? TEST_JWT_SECRET));
}

describe('authentication', () => {
  it('identity comes from the token', async () => {
    const show = await createShow(h, { seats: 2 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: await h.token('user-123'),
      body: { seats: ['A1'], idempotency_key: key() },
    });
    expect(res.status).toBe(201);
    expect(res.body.user_id).toBe('user-123');
  });

  it('a spoofed user_id in the body cannot change identity', async () => {
    const show = await createShow(h, { seats: 2 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: await h.token('alice'),
      body: { seats: ['A1'], idempotency_key: key(), user_id: 'victim', userId: 'victim' },
    });
    expect(res.status).toBe(201);
    expect(res.body.user_id).toBe('alice');
    const owner = await h.pool.query('SELECT user_id FROM reservations WHERE id = $1', [res.body.reservation_id]);
    expect(owner.rows[0].user_id).toBe('alice');
    await assertReconciled(h, show.id);
  });

  it.each([
    ['missing header', undefined],
    ['garbage token', 'not.a.jwt'],
  ])('rejects %s with 401', async (_name, token) => {
    const show = await createShow(h, { seats: 1 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, { token, body: { seats: ['A1'], idempotency_key: key() } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['wrong secret', { secret: 'some-other-secret-some-other-secret-xx', sub: 'alice' }],
    ['expired', { sub: 'alice', exp: Math.floor(Date.now() / 1000) - 60 }],
    ['wrong issuer', { sub: 'alice', issuer: 'someone-else' }],
    ['no subject', {}],
  ])('rejects a token with %s', async (_name, opts) => {
    const show = await createShow(h, { seats: 1 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: await sign(opts),
      body: { seats: ['A1'], idempotency_key: key() },
    });
    expect(res.status).toBe(401);
  });

  it('rejects alg=none tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'alice', iss: 'seat-reservation' })).toString('base64url');
    const show = await createShow(h, { seats: 1 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: `${header}.${payload}.`,
      body: { seats: ['A1'], idempotency_key: key() },
    });
    expect(res.status).toBe(401);
  });

  it('a user cannot cancel another user\'s reservation (403) and nothing changes', async () => {
    const show = await createShow(h, { seats: 2 });
    const r = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: await h.token('alice'),
      body: { seats: ['A1'], idempotency_key: key() },
    });
    const res = await api(h, 'POST', `/reservations/${r.body.reservation_id}/cancel`, {
      token: await h.token('mallory'),
      body: { user_id: 'alice' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const state = await api(h, 'GET', `/shows/${show.id}`);
    expect(state.body.counts.confirmed).toBe(1);
    await assertReconciled(h, show.id);
  });

  it('dev-token endpoint issues usable tokens and is absent when disabled', async () => {
    const issued = await api(h, 'POST', '/auth/dev-token', { body: { user_id: 'dev-user' } });
    expect(issued.status).toBe(201);
    expect(issued.body.token_type).toBe('Bearer');
    const show = await createShow(h, { seats: 1 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, {
      token: issued.body.access_token,
      body: { seats: ['A1'], idempotency_key: key() },
    });
    expect(res.body.user_id).toBe('dev-user');

    const locked = await startHarness({ AUTH_DEV_TOKENS_ENABLED: 'false' });
    try {
      expect((await api(locked, 'POST', '/auth/dev-token', { body: { user_id: 'x' } })).status).toBe(404);
    } finally {
      await locked.close();
    }
  });
});
