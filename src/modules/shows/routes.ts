import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { parseOrThrow } from '../../common/utils/validation.js';
import { annotate } from '../../observability/logger.js';
import { CreateShowBody, ShowIdParams } from './schemas.js';
import type { ShowService } from './service.js';

export async function showRoutes(
  app: FastifyInstance,
  opts: { shows: ShowService; authenticate: preHandlerAsyncHookHandler; authorizeAdmin: preHandlerAsyncHookHandler },
): Promise<void> {
  const { shows, authenticate, authorizeAdmin } = opts;

  // Admins only (ADMIN_USER_IDS); everyone else gets 403.
  app.post('/shows', { preHandler: [authenticate, authorizeAdmin] }, async (request, reply) => {
    const body = parseOrThrow(CreateShowBody, request.body);
    const show = await shows.createShow(body);
    annotate(request, { event: 'show_created', show_id: show.id, total_seats: show.total_seats });
    return reply.status(201).send(show);
  });

  app.get('/shows/:showId', async (request) => {
    const { showId } = parseOrThrow(ShowIdParams, request.params);
    return shows.getShowState(showId);
  });
}
