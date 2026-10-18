import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, countBy, createShow, key, startHarness, type Harness } from './helpers/harness.js';
import { assertReconciled } from './helpers/reconcile.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function reserve(showId: string, userId: string, body: Record<string, unknown>) {
  return api(h, 'POST', `/shows/${showId}/reserve`, { token: await h.token(userId), body });
}

async function reservationCount(showId: string): Promise<number> {
  const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM reservations WHERE show_id = $1', [showId]);
  return rows[0].n;
}

describe('idempotency', () => {
  it('same key + same body returns the original reservation without creating another', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = key();
    const first = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const retry = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await reservationCount(show.id)).toBe(1);
    await assertReconciled(h, show.id);
  });

  it('same key + same seats in a different order / extra fields is the same request', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = key();
    const first = await reserve(show.id, 'alice', { seats: ['A2', 'A10', 'A1'], idempotency_key: k });
    const retry = await reserve(show.id, 'alice', { idempotency_key: k, seats: ['A10', 'A1', 'A2'], note: 'x' });
    expect(retry.status).toBe(201);
    expect(retry.body.reservation_id).toBe(first.body.reservation_id);
    expect(await reservationCount(show.id)).toBe(1);
  });

  it('same key + different body is 409 and changes nothing', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = key();
    await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    const res = await reserve(show.id, 'alice', { seats: ['A2'], idempotency_key: k });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const superset = await reserve(show.id, 'alice', { seats: ['A1', 'A2'], idempotency_key: k });
    expect(superset.status).toBe(409);
    expect(await reservationCount(show.id)).toBe(1);
    await assertReconciled(h, show.id);
  });

  it('100 concurrent retries with the same key create exactly one reservation', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => reserve(show.id, 'alice', { seats: ['A5', 'A6'], idempotency_key: k })),
    );
    expect(countBy(results, (r) => r.status)).toEqual({ 201: 100 });
    expect(new Set(results.map((r) => r.body.reservation_id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(99);
    expect(await reservationCount(show.id)).toBe(1);
    await assertReconciled(h, show.id);
  });

  it('concurrent same-key requests with different bodies: one wins, others 409', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = key();
    const results = await Promise.all(
      ['A1', 'A2', 'A3', 'A4', 'A5'].flatMap((seat) =>
        Array.from({ length: 10 }, () => reserve(show.id, 'alice', { seats: [seat], idempotency_key: k })),
      ),
    );
    const winners = results.filter((r) => r.status === 201);
    expect(new Set(winners.map((r) => r.body.reservation_id)).size).toBe(1);
    const winningSeat = winners[0]!.body.seats[0];
    // Everyone who sent the winning body got the replay; everyone else got a conflict.
    expect(winners).toHaveLength(10);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'IDEMPOTENCY_CONFLICT')).toBe(true);
    expect(countBy(results, (r) => r.status)).toEqual({ 201: 10, 409: 40 });
    expect(winningSeat).toMatch(/^A[1-5]$/);
    expect(await reservationCount(show.id)).toBe(1);
    await assertReconciled(h, show.id);
  });

  it('keys are scoped per user: two users may use the same key independently', async () => {
    const show = await createShow(h, { seats: 10 });
    const k = 'shared-key';
    const a = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    const b = await reserve(show.id, 'bob', { seats: ['A2'], idempotency_key: k });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.reservation_id).not.toBe(b.body.reservation_id);
    // Bob cannot replay Alice's reservation with her key.
    const bobReplay = await reserve(show.id, 'bob', { seats: ['A1'], idempotency_key: k });
    expect(bobReplay.status).toBe(409);
    expect(bobReplay.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('a declined attempt does not consume the key: retry succeeds once the seat is free', async () => {
    const show = await createShow(h, { seats: 2 });
    const holder = await reserve(show.id, 'bob', { seats: ['A1'], idempotency_key: key() });
    const k = key();
    expect((await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k })).status).toBe(409);

    await api(h, 'POST', `/reservations/${holder.body.reservation_id}/cancel`, { token: await h.token('bob') });
    const retry = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replayed')).toBeNull();
    await assertReconciled(h, show.id);
  });

  it('replaying a key after cancellation returns the cancelled reservation and does not re-reserve', async () => {
    const show = await createShow(h, { seats: 2 });
    const k = key();
    const first = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    await api(h, 'POST', `/reservations/${first.body.reservation_id}/cancel`, { token: await h.token('alice') });

    const replay = await reserve(show.id, 'alice', { seats: ['A1'], idempotency_key: k });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ reservation_id: first.body.reservation_id, status: 'cancelled' });
    const state = await api(h, 'GET', `/shows/${show.id}`);
    expect(state.body.counts.available).toBe(2);
    await assertReconciled(h, show.id);
  });
});
