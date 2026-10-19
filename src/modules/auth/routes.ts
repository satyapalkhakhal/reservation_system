import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../common/utils/validation.js';
import { annotate } from '../../observability/logger.js';
import { USER_ID_PATTERN, type JwtAuthService } from './service.js';

const DevTokenBody = z.object({
  user_id: z.string().regex(USER_ID_PATTERN, 'user_id must be 1-255 chars of [A-Za-z0-9._:@-]'),
});

/**
 * POST /auth/dev-token: issues a signed token for any user id.
 * Registered only when AUTH_DEV_TOKENS_ENABLED=true. It stands in for a real
 * identity provider so evaluators and the burst script can obtain tokens.
 */
export async function devTokenRoutes(app: FastifyInstance, opts: { auth: JwtAuthService }): Promise<void> {
  app.post('/auth/dev-token', async (request, reply) => {
    const { user_id } = parseOrThrow(DevTokenBody, request.body);
    const token = await opts.auth.issue(user_id);
    annotate(request, { event: 'dev_token_issued', user_id });
    return reply.status(201).send(token);
  });
}
