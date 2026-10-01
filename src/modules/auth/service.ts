import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { UnauthenticatedError } from '../../common/errors/domain-errors.js';
import type { AuthUser, AuthVerifier } from './types.js';

export const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;

/** HS256 JWT verification + (dev-only) issuance. */
export class JwtAuthService implements AuthVerifier {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly issuer: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || !USER_ID_PATTERN.test(payload.sub)) {
        throw new UnauthenticatedError('Token has no valid subject');
      }
      return { id: payload.sub };
    } catch (err) {
      if (err instanceof UnauthenticatedError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new UnauthenticatedError('Token expired');
      throw new UnauthenticatedError('Invalid token');
    }
  }

  async issue(userId: string): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
    return { access_token: token, token_type: 'Bearer', expires_in: this.ttlSeconds };
  }
}
