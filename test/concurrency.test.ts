import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, countBy, createShow, key, seatRange, startHarness, type ApiResponse, type Harness } from './helpers/harness.js';
import { assertReconciled } from './helpers/reconcile.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const tokens = new Map<string, string>();
async function tokenFor(userId: string): Promise<string> {
  let t = tokens.get(userId);
  if (!t) {
    t = await h.token(userId);
    tokens.set(userId, t);
  }
  return t;
}

async function reserve(showId: string, userId: string, seats: string[], idempotency_key = key()) {
  return api(h, 'POST', `/shows/${showId}/reserve`, { token: await tokenFor(userId), body: { seats, idempotency_key } });
}

function expectNo5xx(results: ApiResponse[]): void {
  const errors = results.filter((r) => r.status >= 500);
  expect(errors.map((r) => r.body), 'no 5xx under contention').toEqual([]);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('concurrency', () => {
  it('500 different users racing for one seat: exactly one 201, 499 x 409 SEAT_TAKEN', async () => {
    const show = await createShow(h, { seats: 100 });
    await Promise.all(Array.from({ length: 500 }, (_, i) => tokenFor(`storm-${i}`)));

    const results = await Promise.all(Array.from({ length: 500 }, (_, i) => reserve(show.id, `storm-${i}`, ['A12'])));

    expectNo5xx(results);
    expect(countBy(results, (r) => r.status)).toEqual({ 201: 1, 409: 499 });
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SEAT_TAKEN')).toBe(true);

    const winner = results.find((r) => r.status === 201)!;
    const { rows } = await h.pool.query(
      `SELECT r.user_id FROM show_seats ss JOIN reservations r ON r.id = ss.reservation_id
        WHERE ss.show_id = $1 AND ss.seat_number = 'A12'`,
      [show.id],
    );
    expect(rows).toEqual([{ user_id: winner.body.user_id }]);
    const state = await api(h, 'GET', `/shows/${show.id}`);
    expect(state.body.counts).toEqual({ available: 99, held: 0, confirmed: 1 });
    await assertReconciled(h, show.id);
  });

  it('overlapping multi-seat requests: every seat has at most one owner, all-or-nothing holds', async () => {
    const show = await createShow(h, { seats: 12, per_user_limit: 4 });
    const seats = seatRange(12);
    const requests = Array.from({ length: 300 }, (_, i) => {
      const n = 1 + (i % 3);
      const start = Math.floor(Math.random() * (12 - n + 1));
      // Randomize request order to exercise lock ordering ([A2, A1] vs [A1, A2]).
      return { user: `ov-${i}`, seats: shuffle(seats.slice(start, start + n)) };
    });

    const results = await Promise.all(requests.map((r) => reserve(show.id, r.user, r.seats)));
    expectNo5xx(results);
    expect(Object.keys(countBy(results, (r) => r.status)).sort()).toEqual(['201', '409']);

    // The union of winning seat sets is disjoint and matches confirmed seats exactly.
    const won = results.filter((r) => r.status === 201).flatMap((r) => r.body.seats as string[]);
    expect(new Set(won).size).toBe(won.length);
    const state = await api(h, 'GET', `/shows/${show.id}`);
    const confirmed = state.body.seats.filter((s: any) => s.status === 'confirmed').map((s: any) => s.seat);
    expect(confirmed.sort()).toEqual([...won].sort());
    await assertReconciled(h, show.id);
  });

  it('opposite lock orders ([A1..A5] vs reversed) never deadlock into 5xx', async () => {
    const show = await createShow(h, { seats: 5, per_user_limit: 5 });
    const forward = seatRange(5);
    const backward = [...forward].reverse();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => reserve(show.id, `dl-${i}`, i % 2 ? forward : backward)),
    );
    expectNo5xx(results);
    expect(countBy(results, (r) => r.status)).toEqual({ 201: 1, 409: 199 });
    await assertReconciled(h, show.id);
  });

  it('one user, 20 concurrent single-seat requests: exactly 4 succeed (per-user limit)', async () => {
    const show = await createShow(h, { seats: 30 });
    const results = await Promise.all(seatRange(20).map((s) => reserve(show.id, 'greedy', [s])));
    expectNo5xx(results);
    expect(countBy(results, (r) => r.status)).toEqual({ 201: 4, 409: 16 });
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'PER_USER_LIMIT')).toBe(true);

    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM show_seats ss JOIN reservations r ON r.id = ss.reservation_id
        WHERE ss.show_id = $1 AND r.user_id = 'greedy'`,
      [show.id],
    );
    expect(rows[0].n).toBe(4);
    await assertReconciled(h, show.id);
  });

  it('one user, mixed multi-seat concurrent requests: never more than the limit', async () => {
    const show = await createShow(h, { seats: 40, per_user_limit: 4 });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const n = 1 + (i % 3);
        return reserve(show.id, 'greedy2', seatRange(40).slice(i, i + n));
      }),
    );
    expectNo5xx(results);
    const total = results.filter((r) => r.status === 201).reduce((acc, r) => acc + r.body.seats.length, 0);
    expect(total).toBeLessThanOrEqual(4);
    expect(total).toBeGreaterThan(0); // something was actually booked
    await assertReconciled(h, show.id);
  });

  it('many users, each firing 10 concurrent requests, on a contended show', async () => {
    const show = await createShow(h, { seats: 50, per_user_limit: 4 });
    const seats = seatRange(50);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, u) =>
        Array.from({ length: 10 }, () => {
          const n = 1 + Math.floor(Math.random() * 2);
          const start = Math.floor(Math.random() * (50 - n));
          return reserve(show.id, `crowd-${u}`, seats.slice(start, start + n));
        }),
      ).flat(),
    );
    expectNo5xx(results);
    await assertReconciled(h, show.id);
  });

  it('reserve/cancel churn: concurrent cancels and re-bookings stay consistent', async () => {
    const show = await createShow(h, { seats: 10, per_user_limit: 2 });
    const initial = await Promise.all(seatRange(10).map((s, i) => reserve(show.id, `churn-${i}`, [s])));
    expect(initial.every((r) => r.status === 201)).toBe(true);

    const ops: Promise<ApiResponse>[] = [];
    initial.forEach((r, i) => {
      // Owner cancels (twice, concurrently) while others try to grab the seat.
      for (let c = 0; c < 2; c++) {
        ops.push(
          tokenFor(`churn-${i}`).then((t) => api(h, 'POST', `/reservations/${r.body.reservation_id}/cancel`, { token: t })),
        );
      }
      for (let g = 0; g < 5; g++) ops.push(reserve(show.id, `grab-${i}-${g}`, r.body.seats));
    });
    const results = await Promise.all(ops);
    expectNo5xx(results);

    const cancels = results.filter((r) => r.body?.status === 'cancelled' || r.body?.error?.code === 'ALREADY_CANCELLED');
    expect(countBy(cancels, (r) => r.status)).toEqual({ 200: 10, 409: 10 });
    await assertReconciled(h, show.id);
  });
});
