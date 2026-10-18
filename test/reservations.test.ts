import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createShow, key, startHarness, type Harness } from './helpers/harness.js';
import { assertReconciled } from './helpers/reconcile.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

async function reserve(showId: string, userId: string, seats: string[], idempotency_key = key()) {
  return api(h, 'POST', `/shows/${showId}/reserve`, {
    token: await h.token(userId),
    body: { seats, idempotency_key },
  });
}

async function seatStatus(showId: string): Promise<Record<string, string>> {
  const res = await api(h, 'GET', `/shows/${showId}`);
  return Object.fromEntries(res.body.seats.map((s: any) => [s.seat, s.status]));
}

describe('POST /shows/:id/reserve', () => {
  it('reserves one seat and returns the documented shape with integer paise', async () => {
    const show = await createShow(h, { seats: 20, price_paise: 25000 });
    const res = await reserve(show.id, 'alice', ['A12']);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      show_id: show.id,
      user_id: 'alice',
      seats: ['A12'],
      amount_paise: 25000,
      status: 'confirmed',
    });
    expect(Number.isInteger(res.body.amount_paise)).toBe(true);
    expect((await seatStatus(show.id)).A12).toBe('confirmed');
    await assertReconciled(h, show.id);
  });

  it('reserves multiple seats atomically; amount = price * seats', async () => {
    const show = await createShow(h, { seats: 10, price_paise: 19999 });
    const res = await reserve(show.id, 'alice', ['A3', 'A1', 'A2']);
    expect(res.status).toBe(201);
    expect(res.body.seats).toEqual(['A1', 'A2', 'A3']);
    expect(res.body.amount_paise).toBe(59997);
    const state = await api(h, 'GET', `/shows/${show.id}`);
    expect(state.body.counts).toEqual({ available: 7, held: 0, confirmed: 3 });
    await assertReconciled(h, show.id);
  });

  it('is all-or-nothing: one taken seat -> 409 and nothing reserved', async () => {
    const show = await createShow(h, { seats: 20 });
    expect((await reserve(show.id, 'bob', ['A13'])).status).toBe(201);

    const res = await reserve(show.id, 'alice', ['A12', 'A13']);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEAT_TAKEN');
    expect(res.body.error.details.seats).toEqual(['A13']);

    const seats = await seatStatus(show.id);
    expect(seats.A12).toBe('available');
    expect(seats.A13).toBe('confirmed');
    await assertReconciled(h, show.id);
  });

  it('enforces the per-user limit (default 4), counting across reservations', async () => {
    const show = await createShow(h, { seats: 10 });
    expect((await reserve(show.id, 'carol', ['A1', 'A2', 'A3'])).status).toBe(201);
    const over = await reserve(show.id, 'carol', ['A4', 'A5']);
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({
      code: 'PER_USER_LIMIT',
      details: { per_user_limit: 4, already_reserved: 3, requested: 2 },
    });
    expect((await reserve(show.id, 'carol', ['A4'])).status).toBe(201);
    expect((await reserve(show.id, 'carol', ['A5'])).status).toBe(409);
    // The limit is per user: someone else can still book.
    expect((await reserve(show.id, 'dave', ['A5'])).status).toBe(201);
    await assertReconciled(h, show.id);
  });

  it('rejects unknown seats with 422 and leaves the rest untouched', async () => {
    const show = await createShow(h, { seats: 3 });
    const res = await reserve(show.id, 'alice', ['A1', 'Z99']);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'UNKNOWN_SEATS', details: { seats: ['Z99'] } });
    expect((await seatStatus(show.id)).A1).toBe('available');
    await assertReconciled(h, show.id);
  });

  it('returns 404 for an unknown show', async () => {
    const res = await reserve('00000000-0000-0000-0000-000000000000', 'alice', ['A1']);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SHOW_NOT_FOUND');
  });

  it.each([
    [{ seats: ['A1'] }, 'missing idempotency_key'],
    [{ seats: [], idempotency_key: 'k' }, 'empty seats'],
    [{ seats: ['A1', 'A1'], idempotency_key: 'k' }, 'duplicate seats'],
    [{ seats: ['A1'], idempotency_key: '' }, 'empty key'],
    [{ seats: ['A1'], idempotency_key: 'has space' }, 'key with space'],
    [{ seats: 'A1', idempotency_key: 'k' }, 'seats not an array'],
  ])('rejects invalid body with 400 (%#: %s)', async (body, _why) => {
    const show = await createShow(h, { seats: 2 });
    const res = await api(h, 'POST', `/shows/${show.id}/reserve`, { token: await h.token('alice'), body });
    expect(res.status).toBe(400);
    await assertReconciled(h, show.id);
  });
});

describe('POST /reservations/:id/cancel', () => {
  it('releases seats, frees quota, and seats can be re-booked', async () => {
    const show = await createShow(h, { seats: 6 });
    const r = await reserve(show.id, 'erin', ['A1', 'A2', 'A3', 'A4']);
    expect(r.status).toBe(201);
    expect((await reserve(show.id, 'erin', ['A5'])).status).toBe(409); // at limit

    const c = await api(h, 'POST', `/reservations/${r.body.reservation_id}/cancel`, { token: await h.token('erin') });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ reservation_id: r.body.reservation_id, status: 'cancelled', seats: ['A1', 'A2', 'A3', 'A4'] });
    expect(c.body.cancelled_at).toBeTypeOf('string');

    const state = await api(h, 'GET', `/shows/${show.id}`);
    expect(state.body.counts).toEqual({ available: 6, held: 0, confirmed: 0 });

    expect((await reserve(show.id, 'erin', ['A5', 'A6', 'A1', 'A2'])).status).toBe(201); // quota freed
    expect((await reserve(show.id, 'frank', ['A3'])).status).toBe(201); // released seat re-bookable
    await assertReconciled(h, show.id);
  });

  it('a second cancel is 409 and does not release seats now owned by someone else', async () => {
    const show = await createShow(h, { seats: 3 });
    const first = await reserve(show.id, 'gina', ['A1']);
    const gina = await h.token('gina');
    expect((await api(h, 'POST', `/reservations/${first.body.reservation_id}/cancel`, { token: gina })).status).toBe(200);

    const second = await reserve(show.id, 'hank', ['A1']);
    expect(second.status).toBe(201);

    const again = await api(h, 'POST', `/reservations/${first.body.reservation_id}/cancel`, { token: gina });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_CANCELLED');
    expect((await seatStatus(show.id)).A1).toBe('confirmed'); // still hank's
    await assertReconciled(h, show.id);
  });

  it('404 for unknown reservation, 400 for malformed id', async () => {
    const t = await h.token('alice');
    expect((await api(h, 'POST', '/reservations/00000000-0000-0000-0000-000000000000/cancel', { token: t })).status).toBe(404);
    expect((await api(h, 'POST', '/reservations/nope/cancel', { token: t })).status).toBe(400);
  });
});
