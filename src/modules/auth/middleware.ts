import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { UnauthenticatedError } from '../../common/errors/domain-errors.js';
import type { AuthUser, AuthVerifier } from './types.js';

/** preHandler that requires `Authorization: Bearer <token>` and sets request.authUser. */
export function requireAuth(verifier: AuthVerifier): preHandlerAsyncHookHandler {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
    const header = request.headers.authorization;
    if (!header) throw new UnauthenticatedError('Missing Authorization header');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match?.[1]) throw new UnauthenticatedError('Authorization header must be "Bearer <token>"');
    request.authUser = await verifier.verify(match[1]);
  };
}

/** For handlers behind requireAuth. Identity only ever comes from here. */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw new UnauthenticatedError('Not authenticated');
  return request.authUser;
}
