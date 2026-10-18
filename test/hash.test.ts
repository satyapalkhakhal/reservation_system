import { describe, expect, it } from 'vitest';
import { reservationRequestHash } from '../src/modules/reservations/hash.js';
import { normalizeSeats } from '../src/modules/reservations/service.js';

const SHOW = '7d1f0a5e-6a4b-4b8e-9a59-2f2b8d3c1e01';

describe('request hashing (unit)', () => {
  it('is independent of seat order', () => {
    expect(reservationRequestHash(SHOW, normalizeSeats(['A13', 'A2', 'B1']))).toBe(
      reservationRequestHash(SHOW, normalizeSeats(['B1', 'A13', 'A2'])),
    );
  });

  it('differs for different seats or shows', () => {
    const base = reservationRequestHash(SHOW, normalizeSeats(['A1']));
    expect(reservationRequestHash(SHOW, normalizeSeats(['A2']))).not.toBe(base);
    expect(reservationRequestHash(SHOW.replace('01', '02'), normalizeSeats(['A1']))).not.toBe(base);
  });

  it('cannot be confused by label concatenation', () => {
    expect(reservationRequestHash(SHOW, normalizeSeats(['A1', 'B']))).not.toBe(
      reservationRequestHash(SHOW, normalizeSeats(['A1B'])),
    );
  });

  it('normalizeSeats sorts byte-wise (matches COLLATE "C") and rejects duplicates', () => {
    expect(normalizeSeats(['a1', 'B2', 'A10', 'A2'])).toEqual(['A10', 'A2', 'B2', 'a1']);
    expect(() => normalizeSeats(['A1', 'A1'])).toThrow(/Duplicate/);
  });
});
