import type { PoolClient } from '../../db/pool.js';
import type { Queryable } from '../../db/queryable.js';
import type { LockedSeat, Reservation } from './types.js';

/*
 * Every function taking a PoolClient is meant to run inside the caller's
 * transaction. Lock order used by ALL writers (reserve and cancel):
 *
 *   1. user_show_quotas row  (per user+show)
 *   2. reservations row      (cancel only)
 *   3. show_seats rows       (ORDER BY seat_number)
 */

/**
 * Lock 1: the per-(user, show) row. Creates it on first use. Every reservation
 * or cancellation by this user for this show queues here, so the per-user
 * limit (and idempotency check) are evaluated one-at-a-time per user.
 *
 * INSERT .. ON CONFLICT DO NOTHING is race-safe: a concurrent inserter waits on
 * the unique index until the first commits, then does nothing.
 */
export async function lockUserQuota(client: PoolClient, userId: string, showId: string): Promise<number> {
  await client.query(
    `INSERT INTO user_show_quotas (user_id, show_id) VALUES ($1, $2)
     ON CONFLICT (user_id, show_id) DO NOTHING`,
    [userId, showId],
  );
  const { rows } = await client.query<{ seats_reserved: number }>(
    `SELECT seats_reserved FROM user_show_quotas
      WHERE user_id = $1 AND show_id = $2
        FOR UPDATE`,
    [userId, showId],
  );
  return rows[0]!.seats_reserved;
}

export async function adjustUserQuota(
  client: PoolClient,
  userId: string,
  showId: string,
  delta: number,
): Promise<void> {
  await client.query(
    `UPDATE user_show_quotas SET seats_reserved = seats_reserved + $3
      WHERE user_id = $1 AND show_id = $2`,
    [userId, showId, delta],
  );
}

/**
 * Lock 3: the requested seat rows, in deterministic seat_number order
 * (COLLATE "C"). FOR UPDATE blocks until any concurrent transaction holding
 * these rows commits/rolls back, after which PostgreSQL re-reads the latest
 * committed version of the row, so `status` returned here is authoritative
 * for as long as this transaction is open.
 */
export async function lockSeats(client: PoolClient, showId: string, seatNumbers: string[]): Promise<LockedSeat[]> {
  const { rows } = await client.query<LockedSeat>(
    `SELECT id, seat_number, status
       FROM show_seats
      WHERE show_id = $1 AND seat_number = ANY($2::text[])
      ORDER BY seat_number
        FOR UPDATE`,
    [showId, seatNumbers],
  );
  return rows;
}

export async function insertReservation(
  client: PoolClient,
  input: { show_id: string; user_id: string; seat_count: number; amount_paise: number },
): Promise<Reservation> {
  const { rows } = await client.query<Reservation>(
    `INSERT INTO reservations (show_id, user_id, status, seat_count, amount_paise)
     VALUES ($1, $2, 'confirmed', $3, $4)
     RETURNING id, show_id, user_id, status, seat_count, amount_paise, created_at, cancelled_at`,
    [input.show_id, input.user_id, input.seat_count, input.amount_paise],
  );
  return rows[0]!;
}

export async function insertReservationSeats(
  client: PoolClient,
  reservationId: string,
  seatIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO reservation_seats (reservation_id, seat_id)
     SELECT $1, unnest($2::uuid[])`,
    [reservationId, seatIds],
  );
}

/**
 * Flip locked seats to confirmed. The `status = 'available'` guard is
 * redundant while we hold the row locks; it is there so this statement can
 * never overwrite a seat owned by someone else. Returns rows changed.
 */
export async function confirmSeats(client: PoolClient, seatIds: string[], reservationId: string): Promise<number> {
  const result = await client.query(
    `UPDATE show_seats
        SET status = 'confirmed', reservation_id = $2, updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'available'`,
    [seatIds, reservationId],
  );
  return result.rowCount ?? 0;
}

export async function findReservationWithSeats(
  db: Queryable,
  reservationId: string,
): Promise<(Reservation & { seats: string[] }) | null> {
  const { rows } = await db.query<Reservation & { seats: string[] }>(
    `SELECT r.id, r.show_id, r.user_id, r.status, r.seat_count, r.amount_paise, r.created_at, r.cancelled_at,
            array_agg(ss.seat_number ORDER BY ss.seat_number) AS seats
       FROM reservations r
       JOIN reservation_seats rs ON rs.reservation_id = r.id
       JOIN show_seats ss ON ss.id = rs.seat_id
      WHERE r.id = $1
      GROUP BY r.id`,
    [reservationId],
  );
  return rows[0] ?? null;
}

export interface StoredIdempotencyKey {
  request_hash: string;
  reservation_id: string;
}

/**
 * Called while holding the user's quota lock, so under READ COMMITTED this
 * sees any key committed by a concurrent request that held the lock before us.
 */
export async function findIdempotencyKey(
  client: PoolClient,
  userId: string,
  showId: string,
  idempotencyKey: string,
): Promise<StoredIdempotencyKey | null> {
  const { rows } = await client.query<StoredIdempotencyKey>(
    `SELECT request_hash, reservation_id FROM idempotency_keys
      WHERE user_id = $1 AND show_id = $2 AND idempotency_key = $3`,
    [userId, showId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function insertIdempotencyKey(
  client: PoolClient,
  input: { user_id: string; show_id: string; idempotency_key: string; request_hash: string; reservation_id: string },
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (user_id, show_id, idempotency_key, request_hash, reservation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.user_id, input.show_id, input.idempotency_key, input.request_hash, input.reservation_id],
  );
}

export async function findReservation(db: Queryable, reservationId: string): Promise<Reservation | null> {
  const { rows } = await db.query<Reservation>(
    `SELECT id, show_id, user_id, status, seat_count, amount_paise, created_at, cancelled_at
       FROM reservations WHERE id = $1`,
    [reservationId],
  );
  return rows[0] ?? null;
}

/** Lock 2 (cancel only): the reservation row. */
export async function lockReservation(client: PoolClient, reservationId: string): Promise<Reservation> {
  const { rows } = await client.query<Reservation>(
    `SELECT id, show_id, user_id, status, seat_count, amount_paise, created_at, cancelled_at
       FROM reservations WHERE id = $1
        FOR UPDATE`,
    [reservationId],
  );
  return rows[0]!;
}

/** Lock 3 (cancel): the seats this reservation currently owns, in seat order. */
export async function lockSeatsOwnedBy(client: PoolClient, reservationId: string): Promise<LockedSeat[]> {
  const { rows } = await client.query<LockedSeat>(
    `SELECT id, seat_number, status
       FROM show_seats
      WHERE reservation_id = $1
      ORDER BY seat_number
        FOR UPDATE`,
    [reservationId],
  );
  return rows;
}

/**
 * Release seats back to available. The `reservation_id = $1` guard means this
 * can only ever touch seats still owned by THIS reservation: it can never
 * overwrite a seat that belongs to someone else.
 */
export async function releaseSeats(client: PoolClient, reservationId: string): Promise<number> {
  const result = await client.query(
    `UPDATE show_seats
        SET status = 'available', reservation_id = NULL, updated_at = now()
      WHERE reservation_id = $1`,
    [reservationId],
  );
  return result.rowCount ?? 0;
}

export async function deactivateReservationSeats(client: PoolClient, reservationId: string): Promise<void> {
  await client.query(`UPDATE reservation_seats SET active = false WHERE reservation_id = $1 AND active`, [
    reservationId,
  ]);
}

export async function markCancelled(client: PoolClient, reservationId: string): Promise<Reservation> {
  const { rows } = await client.query<Reservation>(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND status = 'confirmed'
      RETURNING id, show_id, user_id, status, seat_count, amount_paise, created_at, cancelled_at`,
    [reservationId],
  );
  return rows[0]!;
}
