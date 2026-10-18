import type { Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { PG, pgConstraint, pgErrorCode } from '../../db/pg-errors.js';
import {
  IdempotencyConflictError,
  PerUserLimitError,
  SeatTakenError,
  ShowNotFoundError,
  UnknownSeatsError,
  ValidationError,
} from '../../common/errors/domain-errors.js';
import { compareSeatsForDisplay } from '../../common/utils/seat-sort.js';
import { findDuplicates } from '../../common/utils/validation.js';
import * as showsRepo from '../shows/repository.js';
import * as repo from './repository.js';
import { reservationRequestHash } from './hash.js';
import type { Reservation, ReservationView } from './types.js';

export interface ReserveCommand {
  userId: string; // from the verified token, never from the body
  showId: string;
  seats: string[];
  idempotencyKey: string;
}

export interface ReserveResult {
  reservation: ReservationView;
  /** true when an earlier request with the same key + body is being replayed. */
  replayed: boolean;
}

export class ReservationService {
  constructor(private readonly pool: Pool) {}

  /**
   * THE reservation transaction. All-or-nothing: either every requested seat
   * is confirmed for this user, or nothing changes.
   *
   * Lock order (shared with cancel): user quota row -> seat rows by seat_number.
   */
  async reserve(cmd: ReserveCommand, attempt = 1): Promise<ReserveResult> {
    const seats = normalizeSeats(cmd.seats);
    const requestHash = reservationRequestHash(cmd.showId, seats);

    try {
      return await withTransaction(this.pool, async (client) => {
        // 0. Show price/limit. Shows are immutable once created, so no lock needed.
        const show = await showsRepo.findShowById(client, cmd.showId);
        if (!show) throw new ShowNotFoundError(cmd.showId);

        // 1. Lock this user's quota row: serializes this user's requests for this show.
        const alreadyReserved = await repo.lockUserQuota(client, cmd.userId, cmd.showId);

        // 2. Idempotency, checked under the user lock: concurrent retries of the
        //    same key queue on step 1, and the later ones see the first's key here.
        const existing = await repo.findIdempotencyKey(client, cmd.userId, cmd.showId, cmd.idempotencyKey);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new IdempotencyConflictError();
          const original = await repo.findReservationWithSeats(client, existing.reservation_id);
          if (!original) throw new Error(`Idempotency key points at missing reservation ${existing.reservation_id}`);
          return { reservation: toView(original, original.seats), replayed: true };
        }

        // 3. Lock the requested seats in deterministic order and check them.
        const locked = await repo.lockSeats(client, cmd.showId, seats);
        if (locked.length !== seats.length) {
          const found = new Set(locked.map((s) => s.seat_number));
          throw new UnknownSeatsError(seats.filter((s) => !found.has(s)));
        }
        const unavailable = locked.filter((s) => s.status !== 'available').map((s) => s.seat_number);
        if (unavailable.length > 0) throw new SeatTakenError(unavailable);

        // 4. Per-user limit, evaluated while holding the user's quota lock.
        if (alreadyReserved + seats.length > show.per_user_limit) {
          throw new PerUserLimitError(show.per_user_limit, alreadyReserved, seats.length);
        }

        // 5. Write: reservation, its seats, seat status, quota counter, idempotency key.
        const amount = show.price_paise * seats.length;
        if (!Number.isSafeInteger(amount)) throw new ValidationError('Total amount out of range');
        const reservation = await repo.insertReservation(client, {
          show_id: cmd.showId,
          user_id: cmd.userId,
          seat_count: seats.length,
          amount_paise: amount,
        });
        const seatIds = locked.map((s) => s.id);
        await repo.insertReservationSeats(client, reservation.id, seatIds);
        const confirmed = await repo.confirmSeats(client, seatIds, reservation.id);
        if (confirmed !== seats.length) {
          // Impossible while we hold the row locks; refuse rather than partially reserve.
          throw new Error(`Invariant violated: confirmed ${confirmed} of ${seats.length} locked seats`);
        }
        await repo.adjustUserQuota(client, cmd.userId, cmd.showId, seats.length);
        await repo.insertIdempotencyKey(client, {
          user_id: cmd.userId,
          show_id: cmd.showId,
          idempotency_key: cmd.idempotencyKey,
          request_hash: requestHash,
          reservation_id: reservation.id,
        });

        return { reservation: toView(reservation, seats), replayed: false };
      });
    } catch (err) {
      const code = pgErrorCode(err);
      const constraint = pgConstraint(err);
      // Safety net: the partial unique index caught a double owner.
      if (code === PG.UNIQUE_VIOLATION && constraint === 'reservation_seats_one_active_owner') {
        throw new SeatTakenError(seats);
      }
      // Safety net: another transaction stored this key first (cannot happen while
      // step 1 serializes the user, but if it did, re-running replays or conflicts).
      if (code === PG.UNIQUE_VIOLATION && constraint === 'idempotency_keys_scope_unique' && attempt === 1) {
        return this.reserve(cmd, attempt + 1);
      }
      throw err;
    }
  }
}

/**
 * Reject duplicates and sort with a byte-wise comparison. Seat labels are
 * ASCII-only (schema), so this matches PostgreSQL's COLLATE "C" lock order.
 */
export function normalizeSeats(seats: string[]): string[] {
  const duplicates = findDuplicates(seats);
  if (duplicates.length > 0) throw new ValidationError('Duplicate seats in request', { seats: duplicates });
  return [...seats].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function toView(r: Reservation, seats: string[]): ReservationView {
  return {
    reservation_id: r.id,
    show_id: r.show_id,
    user_id: r.user_id,
    seats: [...seats].sort(compareSeatsForDisplay),
    amount_paise: r.amount_paise,
    status: r.status,
    created_at: r.created_at.toISOString(),
    cancelled_at: r.cancelled_at ? r.cancelled_at.toISOString() : null,
  };
}
