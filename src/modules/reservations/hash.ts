import { createHash } from 'node:crypto';

/**
 * Deterministic fingerprint of a reservation request, used to detect an
 * idempotency key being reused for a different request.
 *
 * Built from explicitly normalized fields, never from JSON.stringify of the
 * body, so property order, whitespace, unknown fields, or seat order cannot
 * produce false mismatches. `seats` must already be de-duplicated and sorted.
 * The "v1" prefix lets the scheme evolve without colliding with old hashes.
 */
export function reservationRequestHash(showId: string, normalizedSeats: readonly string[]): string {
  const canonical = ['v1', showId.toLowerCase(), normalizedSeats.join(',')].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
