import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../../common/utils/validation.js';
import { CreateShowBody, ShowIdParams } from './schemas.js';
import type { ShowService } from './service.js';

export async function showRoutes(app: FastifyInstance, opts: { shows: ShowService }): Promise<void> {
  const { shows } = opts;

  app.post('/shows', async (request, reply) => {
    const body = parseOrThrow(CreateShowBody, request.body);
    const show = await shows.createShow(body);
    request.log.info(
      { event: 'show_created', show_id: show.id, total_seats: show.total_seats },
      'show created',
    );
    return reply.status(201).send(show);
  });

  app.get('/shows/:showId', async (request) => {
    const { showId } = parseOrThrow(ShowIdParams, request.params);
    return shows.getShowState(showId);
  });
}
