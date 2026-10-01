export interface AuthUser {
  /** Stable user identifier taken from the verified token's `sub` claim. */
  id: string;
}

/**
 * Anything that can turn a bearer token into a user. The app depends only on
 * this interface; swapping HS256 dev tokens for a JWKS/OIDC verifier means
 * providing another implementation.
 */
export interface AuthVerifier {
  verify(token: string): Promise<AuthUser>;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}
