import type { Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { ShowNotFoundError, ValidationError } from '../../common/errors/domain-errors.js';
import { findDuplicates } from '../../common/utils/validation.js';
import { compareSeatsForDisplay } from '../../common/utils/seat-sort.js';
import * as repo from './repository.js';
import type { CreateShowBody } from './schemas.js';
import type { SeatState, SeatStatus, Show, ShowState } from './types.js';

export class ShowService {
  constructor(
    private readonly pool: Pool,
    private readonly defaultPerUserLimit: number,
  ) {}

  async createShow(input: CreateShowBody): Promise<ShowState> {
    const duplicates = findDuplicates(input.seats);
    if (duplicates.length > 0) {
      throw new ValidationError('Duplicate seat labels', { seats: duplicates });
    }
    const perUserLimit = input.per_user_limit ?? this.defaultPerUserLimit;

    const show = await withTransaction(this.pool, async (client) => {
      const created = await repo.insertShow(client, {
        name: input.name,
        price_paise: input.price_paise,
        per_user_limit: perUserLimit,
      });
      await repo.insertSeats(client, created.id, input.seats);
      return created;
    });

    return toShowState(
      show,
      input.seats.map((seat) => ({ seat, status: 'available' as const })),
    );
  }

  async getShowState(showId: string): Promise<ShowState> {
    const found = await repo.findShowWithSeats(this.pool, showId);
    if (!found) throw new ShowNotFoundError(showId);
    return toShowState(found.show, found.seats);
  }
}

export function toShowState(show: Show, seats: SeatState[]): ShowState {
  const counts: Record<SeatStatus, number> = { available: 0, held: 0, confirmed: 0 };
  for (const s of seats) counts[s.status] += 1;
  return {
    id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    per_user_limit: show.per_user_limit,
    created_at: show.created_at.toISOString(),
    total_seats: seats.length,
    counts,
    seats: [...seats].sort((a, b) => compareSeatsForDisplay(a.seat, b.seat)),
  };
}
