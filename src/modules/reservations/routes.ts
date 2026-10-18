import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { parseOrThrow } from '../../common/utils/validation.js';
import { currentUser } from '../auth/middleware.js';
import { ReservationIdParams, ReserveBody, ReserveParams } from './schemas.js';
import type { ReservationService } from './service.js';

export async function reservationRoutes(
  app: FastifyInstance,
  opts: { reservations: ReservationService; authenticate: preHandlerAsyncHookHandler },
): Promise<void> {
  const { reservations, authenticate } = opts;

  app.post('/shows/:showId/reserve', { preHandler: authenticate }, async (request, reply) => {
    const { showId } = parseOrThrow(ReserveParams, request.params);
    const body = parseOrThrow(ReserveBody, request.body);
    const user = currentUser(request);

    const { reservation, replayed } = await reservations.reserve({
      userId: user.id,
      showId,
      seats: body.seats,
      idempotencyKey: body.idempotency_key,
    });
    request.log.info(
      {
        event: replayed ? 'reservation_idempotent_replay' : 'reservation_confirmed',
        show_id: showId,
        user_id: user.id,
        reservation_id: reservation.reservation_id,
        seats: reservation.seats,
      },
      replayed ? 'idempotent replay' : 'reservation confirmed',
    );
    // A replay returns the original response (same status and body); the header
    // lets clients distinguish it.
    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(201).send(reservation);
  });

  app.post('/reservations/:reservationId/cancel', { preHandler: authenticate }, async (request) => {
    const { reservationId } = parseOrThrow(ReservationIdParams, request.params);
    const user = currentUser(request);

    const reservation = await reservations.cancel(user.id, reservationId);
    request.log.info(
      {
        event: 'reservation_cancelled',
        show_id: reservation.show_id,
        user_id: user.id,
        reservation_id: reservation.reservation_id,
        seats: reservation.seats,
      },
      'reservation cancelled',
    );
    return reservation;
  });
}
