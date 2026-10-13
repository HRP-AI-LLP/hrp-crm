import { SignJWT, jwtVerify } from 'jose';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
const ISSUER = 'hrp-synapse';

export interface AccessClaims {
  sub: string; // user id
  tid: string; // tenant id
  sid: string; // session id
}

const keyCache = new Map<string, Uint8Array>();
function key(secret: string): Uint8Array {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  let k = keyCache.get(secret);
  if (!k) {
    k = new TextEncoder().encode(secret);
    keyCache.set(secret, k);
  }
  return k;
}

export async function signAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    // audience binds the token to one tenant; verify() rejects it on any other tenant host
    .setAudience(`tenant:${claims.tid}`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key(secret));
}

export async function verifyAccessToken(secret: string, token: string, expectedTenantId: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: `tenant:${expectedTenantId}`,
    algorithms: ['HS256'],
    clockTolerance: 30,
  });
  const tid = payload.tid;
  const sid = payload.sid;
  if (typeof payload.sub !== 'string' || typeof tid !== 'string' || typeof sid !== 'string' || tid !== expectedTenantId) {
    throw new Error('invalid claims');
  }
  return { sub: payload.sub, tid, sid };
}
