import type { Queryable } from '../../db/queryable.js';
import type { SeatState, Show } from './types.js';

export async function insertShow(
  db: Queryable,
  input: { name: string; price_paise: number; per_user_limit: number },
): Promise<Show> {
  const { rows } = await db.query<Show>(
    `INSERT INTO shows (name, price_paise, per_user_limit)
     VALUES ($1, $2, $3)
     RETURNING id, name, price_paise, per_user_limit, created_at`,
    [input.name, input.price_paise, input.per_user_limit],
  );
  return rows[0]!;
}

export async function insertSeats(db: Queryable, showId: string, seats: string[]): Promise<void> {
  await db.query(
    `INSERT INTO show_seats (show_id, seat_number)
     SELECT $1, unnest($2::text[])`,
    [showId, seats],
  );
}

export async function findShowById(db: Queryable, showId: string): Promise<Show | null> {
  const { rows } = await db.query<Show>(
    `SELECT id, name, price_paise, per_user_limit, created_at FROM shows WHERE id = $1`,
    [showId],
  );
  return rows[0] ?? null;
}

/**
 * Show plus every seat in ONE statement, so the seat list (and the counts
 * derived from it) come from a single consistent snapshot.
 */
export async function findShowWithSeats(
  db: Queryable,
  showId: string,
): Promise<{ show: Show; seats: SeatState[] } | null> {
  const { rows } = await db.query<Show & { seats: SeatState[] }>(
    `SELECT s.id, s.name, s.price_paise, s.per_user_limit, s.created_at,
            COALESCE(
              json_agg(json_build_object('seat', ss.seat_number, 'status', ss.status))
                FILTER (WHERE ss.id IS NOT NULL),
              '[]'::json
            ) AS seats
       FROM shows s
       LEFT JOIN show_seats ss ON ss.show_id = s.id
      WHERE s.id = $1
      GROUP BY s.id`,
    [showId],
  );
  const row = rows[0];
  if (!row) return null;
  const { seats, ...show } = row;
  return { show, seats };
}
