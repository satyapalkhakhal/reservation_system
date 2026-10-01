import { z } from 'zod';

export const SEAT_LABEL = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, 'seat must be 1-32 chars of letters, digits, "-" or "_"');

export const CreateShowBody = z.object({
  name: z.string().trim().min(1).max(200),
  seats: z.array(SEAT_LABEL).min(1).max(10_000),
  price_paise: z.number().int('price_paise must be an integer number of paise').min(0).max(Number.MAX_SAFE_INTEGER),
  per_user_limit: z.number().int().min(1).max(1000).optional(),
});
export type CreateShowBody = z.infer<typeof CreateShowBody>;

export const ShowIdParams = z.object({
  showId: z.uuid('showId must be a UUID'),
});
