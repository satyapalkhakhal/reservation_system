import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { parseOrThrow } from '../../common/utils/validation.js';
import { DomainError } from '../../common/errors/domain-errors.js';
import { isDbUnavailable } from '../../common/errors/error-handler.js';
import { declineReasonFor, type Metrics } from '../../observability/metrics.js';
import { annotate } from '../../observability/logger.js';
import { currentUser } from '../auth/middleware.js';
import { ReservationIdParams, ReserveBody, ReserveParams } from './schemas.js';
import type { ReservationService } from './service.js';

export async function reservationRoutes(
  app: FastifyInstance,
  opts: { reservations: ReservationService; authenticate: preHandlerAsyncHookHandler; metrics: Metrics },
): Promise<void> {
  const { reservations, authenticate, metrics } = opts;

  app.post('/shows/:showId/reserve', { preHandler: authenticate }, async (request, reply) => {
    const user = currentUser(request);
    const endTimer = metrics.reservationDuration.startTimer();
    let result;
    try {
      const { showId } = parseOrThrow(ReserveParams, request.params);
      const body = parseOrThrow(ReserveBody, request.body);
      result = await reservations.reserve({
        userId: user.id,
        showId,
        seats: body.seats,
        idempotencyKey: body.idempotency_key,
      });
    } catch (err) {
      const reason =
        err instanceof DomainError ? declineReasonFor(err.code) : isDbUnavailable(err) ? 'unavailable' : undefined;
      if (reason) {
        metrics.reservationsDeclined.labels(reason).inc();
        // Expected business outcome: logged at info, not error. The error
        // handler builds the response.
        annotate(request, {
          event: 'reservation_declined',
          reason,
          show_id: (request.params as { showId?: string }).showId,
          ...(err instanceof DomainError && err.details ? { details: err.details } : {}),
        });
      }
      throw err;
    } finally {
      endTimer();
    }

    const { reservation, replayed } = result;
    const showId = reservation.show_id;
    if (replayed) metrics.reservationsDeclined.labels('idempotent_replay').inc();
    else metrics.reservationsConfirmed.inc();
    annotate(request, {
      event: replayed ? 'reservation_idempotent_replay' : 'reservation_confirmed',
      show_id: showId,
      reservation_id: reservation.reservation_id,
      seats: reservation.seats,
    });
    // A replay returns the original response (same status and body); the header
    // lets clients distinguish it.
    if (replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(201).send(reservation);
  });

  app.post('/reservations/:reservationId/cancel', { preHandler: authenticate }, async (request) => {
    const { reservationId } = parseOrThrow(ReservationIdParams, request.params);
    const user = currentUser(request);

    const reservation = await reservations.cancel(user.id, reservationId);
    metrics.reservationsCancelled.inc();
    annotate(request, {
      event: 'reservation_cancelled',
      show_id: reservation.show_id,
      reservation_id: reservation.reservation_id,
      seats: reservation.seats,
    });
    return reservation;
  });
}
