/**
 * PBKDF2-SHA256 password hashing on WebCrypto (identical in Workers, browsers and Node 22).
 * Cloudflare Workers caps PBKDF2 at 100k iterations; the cost is encoded in the hash so it can be
 * raised later (e.g. when hashing moves to an Argon2id service) and old hashes keep verifying.
 */
const ITERATIONS = 100_000;
const enc = new TextEncoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
}

export async function hashPassword(password: string, iterations = ITERATIONS): Promise<string> {
  const iter = Math.min(Math.max(Math.floor(iterations), 10_000), ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iter);
  return `pbkdf2$sha256$${iter}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // burn comparable time so missing users are not distinguishable by latency
    await derive(password, new Uint8Array(16), ITERATIONS);
    return false;
  }
  const [scheme, hash, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2' || hash !== 'sha256' || !iter || !saltB64 || !hashB64) return false;
  if (!(Number(iter) >= 1_000 && Number(iter) <= ITERATIONS)) return false;
  const bits = new Uint8Array(await derive(password, unb64(saltB64), Number(iter)));
  const expected = unb64(hashB64);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= (bits[i] as number) ^ (expected[i] as number);
  return diff === 0;
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 200) return 'Password is too long';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'Use at least three of: lowercase, uppercase, digits, symbols';
  return null;
}
