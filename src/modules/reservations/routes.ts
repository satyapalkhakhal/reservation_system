import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { parseOrThrow } from '../../common/utils/validation.js';
import { currentUser } from '../auth/middleware.js';
import { ReserveBody, ReserveParams } from './schemas.js';
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

    const reservation = await reservations.reserve({ userId: user.id, showId, seats: body.seats });
    request.log.info(
      {
        event: 'reservation_confirmed',
        show_id: showId,
        user_id: user.id,
        reservation_id: reservation.reservation_id,
        seats: reservation.seats,
      },
      'reservation confirmed',
    );
    return reply.status(201).send(reservation);
  });
}
