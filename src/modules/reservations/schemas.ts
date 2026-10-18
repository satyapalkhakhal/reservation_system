import { z } from 'zod';
import { SEAT_LABEL } from '../shows/schemas.js';

// Unknown fields (e.g. a spoofed "user_id") are stripped: identity comes from the token only.
export const ReserveBody = z.object({
  seats: z.array(SEAT_LABEL).min(1).max(100),
});
export type ReserveBody = z.infer<typeof ReserveBody>;

export const ReserveParams = z.object({
  showId: z.uuid('showId must be a UUID'),
});

export const ReservationIdParams = z.object({
  reservationId: z.uuid('reservationId must be a UUID'),
});
