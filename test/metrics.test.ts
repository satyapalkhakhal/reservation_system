import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createShow, key, startHarness, type Harness } from './helpers/harness.js';

function metricValue(text: string, name: string, labels = ''): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `));
  if (!line) throw new Error(`metric ${name}${labels} not found`);
  return Number(line.split(' ')[1]);
}

describe('metrics', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('counters and seat gauges reconcile with API state', async () => {
    const before = await (await fetch(`${h.baseUrl}/metrics`)).text();
    const show = await createShow(h, { seats: 6, per_user_limit: 2 });
    const t = await h.token('metrics-user');
    const k = key();
    const reserve = (seats: string[], idempotency_key = key(), token = t) =>
      api(h, 'POST', `/shows/${show.id}/reserve`, { token, body: { seats, idempotency_key } });

    expect((await reserve(['A1'], k)).status).toBe(201); // confirmed
    expect((await reserve(['A1'], k)).status).toBe(201); // idempotent_replay
    expect((await reserve(['A2'], k)).status).toBe(409); // idempotency_conflict
    expect((await reserve(['A1'], key(), await h.token('other'))).status).toBe(409); // seat_taken
    expect((await reserve(['A2', 'A3'])).status).toBe(409); // per_user_limit (1 + 2 > 2)

    const res = await fetch(`${h.baseUrl}/metrics`);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const after = await res.text();

    const delta = (name: string, labels = '') =>
      metricValue(after, name, labels) - (before.includes(`${name}${labels} `) ? metricValue(before, name, labels) : 0);

    expect(delta('reservations_confirmed_total')).toBe(1);
    expect(delta('reservations_declined_total', '{reason="idempotent_replay"}')).toBe(1);
    expect(delta('reservations_declined_total', '{reason="idempotency_conflict"}')).toBe(1);
    expect(delta('reservations_declined_total', '{reason="seat_taken"}')).toBe(1);
    expect(delta('reservations_declined_total', '{reason="per_user_limit"}')).toBe(1);

    // Seat gauges come straight from PostgreSQL: they equal the sum over all shows.
    const db = await h.pool.query(`SELECT status, count(*)::int AS n FROM show_seats GROUP BY status`);
    const byStatus = Object.fromEntries(db.rows.map((r) => [r.status, r.n]));
    expect(metricValue(after, 'seats_available')).toBe(byStatus.available ?? 0);
    expect(metricValue(after, 'seats_confirmed')).toBe(byStatus.confirmed ?? 0);
    expect(metricValue(after, 'seats_held')).toBe(0);

    // No high-cardinality identifiers in labels.
    expect(after).not.toMatch(/user_id=|reservation_id=|request_id=|show_id=/);
    // Responses by class: the 409 declines are 4xx; nothing failed.
    expect(metricValue(after, 'http_responses_total', '{class="5xx"}')).toBe(0);
    expect(delta('http_responses_total', '{class="4xx"}')).toBe(3); // conflict, seat taken, per-user limit

    // Only the agreed, human-readable set: no runtime or per-route metrics.
    const names = new Set(
      after
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.replace(/[{ ].*/, '').replace(/_(bucket|sum|count)$/, '')),
    );
    expect([...names].sort()).toEqual(
      [
        'http_responses_total',
        'reservation_duration_seconds',
        'reservations_cancelled_total',
        'reservations_confirmed_total',
        'reservations_declined_total',
        'seats_available',
        'seats_confirmed',
        'seats_held',
        'seats_total',
      ].sort(),
    );
  });
});
