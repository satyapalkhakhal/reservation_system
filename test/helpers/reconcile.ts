import { expect } from 'vitest';
import type { Pool } from '../../src/db/pool.js';
import { api, type Harness } from './harness.js';

/**
 * Cross-checks API state against raw database state. Called after every
 * test that mutates seats.
 */
export async function assertReconciled(h: Harness, showId: string): Promise<void> {
  const res = await api(h, 'GET', `/shows/${showId}`);
  expect(res.status).toBe(200);
  const { counts, total_seats, seats } = res.body;

  // 1. API invariant: available + held + confirmed == total.
  expect(counts.available + counts.held + counts.confirmed).toBe(total_seats);
  expect(seats).toHaveLength(total_seats);

  await assertDbInvariants(h.pool, showId);
}

export async function assertDbInvariants(pool: Pool, showId: string): Promise<void> {
  // 2. Every non-available seat is owned by exactly one confirmed reservation
  //    and that ownership is mirrored in an active reservation_seats row.
  const orphans = await pool.query(
    `SELECT ss.seat_number
       FROM show_seats ss
       LEFT JOIN reservations r ON r.id = ss.reservation_id
       LEFT JOIN reservation_seats rs ON rs.seat_id = ss.id AND rs.reservation_id = ss.reservation_id AND rs.active
      WHERE ss.show_id = $1 AND ss.status <> 'available'
        AND (r.id IS NULL OR r.status <> 'confirmed' OR rs.seat_id IS NULL)`,
    [showId],
  );
  expect(orphans.rows).toEqual([]);

  // 3. No seat appears in more than one active reservation.
  const doubles = await pool.query(
    `SELECT rs.seat_id, count(*) FROM reservation_seats rs
       JOIN show_seats ss ON ss.id = rs.seat_id
      WHERE ss.show_id = $1 AND rs.active
      GROUP BY rs.seat_id HAVING count(*) > 1`,
    [showId],
  );
  expect(doubles.rows).toEqual([]);

  // 4. Active reservation_seats rows == confirmed seats (no ghost ownership).
  const active = await pool.query<{ active: number; confirmed: number }>(
    `SELECT
       (SELECT count(*)::int FROM reservation_seats rs JOIN show_seats ss ON ss.id = rs.seat_id
         WHERE ss.show_id = $1 AND rs.active) AS active,
       (SELECT count(*)::int FROM show_seats WHERE show_id = $1 AND status = 'confirmed') AS confirmed`,
    [showId],
  );
  expect(active.rows[0]!.active).toBe(active.rows[0]!.confirmed);

  // 5. Per-user counters equal actual confirmed seats, and never exceed the limit.
  const quotas = await pool.query(
    `SELECT q.user_id, q.seats_reserved, s.per_user_limit,
            COALESCE((SELECT sum(r.seat_count)::int FROM reservations r
                       WHERE r.show_id = q.show_id AND r.user_id = q.user_id AND r.status = 'confirmed'), 0) AS actual
       FROM user_show_quotas q JOIN shows s ON s.id = q.show_id
      WHERE q.show_id = $1`,
    [showId],
  );
  for (const q of quotas.rows) {
    expect(q.seats_reserved, `quota counter for ${q.user_id}`).toBe(q.actual);
    expect(q.actual, `per-user limit for ${q.user_id}`).toBeLessThanOrEqual(q.per_user_limit);
  }

  // 6. Reservation amounts are integer paise = price * seats.
  const amounts = await pool.query(
    `SELECT r.id FROM reservations r JOIN shows s ON s.id = r.show_id
      WHERE r.show_id = $1 AND r.amount_paise <> s.price_paise * r.seat_count`,
    [showId],
  );
  expect(amounts.rows).toEqual([]);
}
