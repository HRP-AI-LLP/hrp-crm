/**
 * GSTN's API encryption, for providers that pass requests through without doing it for us
 * (India Compliance's "standard" API):
 *
 *  - AES-256 in ECB mode with PKCS#7 padding (app key, session key "sek", response key "rek")
 *  - HMAC-SHA256, base64 (integrity of request and response data; EVC signature)
 *  - RSA PKCS#1 v1.5 with GSTN's public certificate (the app key at login)
 *
 * Web Crypto has neither AES-ECB nor RSA PKCS#1 v1.5 encryption, so both are done here in plain
 * TypeScript (AES per FIPS-197; RSA with BigInt). Tests check them against Node's OpenSSL.
 */

/* ───────────────────────── bytes and base64 ───────────────────────── */

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ───────────────────────── AES (FIPS-197) ───────────────────────── */

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  // multiplicative inverse in GF(2^8) via generator 3, then the affine transform
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x1b : 0);
    x &= 0xff;
  }
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : exp[(255 - log[i]!) % 255]!;
    let s = inv;
    let r = inv;
    for (let k = 0; k < 4; k++) {
      r = ((r << 1) | (r >> 7)) & 0xff;
      s ^= r;
    }
    s ^= 0x63;
    SBOX[i] = s;
    INV[s] = i;
  }
})();

const xt = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = xt(a);
    b >>= 1;
  }
  return p;
};

function expandKey(key: Uint8Array): Uint8Array {
  const nk = key.length / 4;
  if (![4, 6, 8].includes(nk)) throw new Error('AES key must be 16, 24 or 32 bytes');
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t0 = w[4 * i - 4]!;
    let t1 = w[4 * i - 3]!;
    let t2 = w[4 * i - 2]!;
    let t3 = w[4 * i - 1]!;
    if (i % nk === 0) {
      [t0, t1, t2, t3] = [SBOX[t1]! ^ rcon, SBOX[t2]!, SBOX[t3]!, SBOX[t0]!];
      rcon = xt(rcon);
    } else if (nk > 6 && i % nk === 4) {
      [t0, t1, t2, t3] = [SBOX[t0]!, SBOX[t1]!, SBOX[t2]!, SBOX[t3]!];
    }
    w[4 * i] = w[4 * (i - nk)]! ^ t0;
    w[4 * i + 1] = w[4 * (i - nk) + 1]! ^ t1;
    w[4 * i + 2] = w[4 * (i - nk) + 2]! ^ t2;
    w[4 * i + 3] = w[4 * (i - nk) + 3]! ^ t3;
  }
  return w;
}

function encryptBlock(s: Uint8Array, w: Uint8Array) {
  const nr = w.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i]! ^= w[i]!;
  const t = new Uint8Array(16);
  for (let r = 1; r <= nr; r++) {
    // SubBytes + ShiftRows (state is column-major: s[c*4 + row])
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) % 4) * 4 + row]!]!;
    if (r < nr) {
      for (let c = 0; c < 4; c++) {
        const a0 = t[c * 4]!;
        const a1 = t[c * 4 + 1]!;
        const a2 = t[c * 4 + 2]!;
        const a3 = t[c * 4 + 3]!;
        s[c * 4] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3;
        s[c * 4 + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3);
      }
    } else s.set(t);
    for (let i = 0; i < 16; i++) s[i]! ^= w[r * 16 + i]!;
  }
}

function decryptBlock(s: Uint8Array, w: Uint8Array) {
  const nr = w.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i]! ^= w[nr * 16 + i]!;
  const t = new Uint8Array(16);
  for (let r = nr - 1; r >= 0; r--) {
    // InvShiftRows + InvSubBytes
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[((c + row) % 4) * 4 + row] = INV[s[c * 4 + row]!]!;
    for (let i = 0; i < 16; i++) t[i]! ^= w[r * 16 + i]!;
    if (r > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = t[c * 4]!;
        const a1 = t[c * 4 + 1]!;
        const a2 = t[c * 4 + 2]!;
        const a3 = t[c * 4 + 3]!;
        s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    } else s.set(t);
  }
}

/** AES-ECB with PKCS#7 padding; returns base64. */
export function aesEcbEncrypt(data: Uint8Array, key: Uint8Array): string {
  const w = expandKey(key);
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  for (let i = 0; i < out.length; i += 16) encryptBlock(out.subarray(i, i + 16), w);
  return toB64(out);
}

/** Decrypts base64 AES-ECB (PKCS#7) data. */
export function aesEcbDecrypt(b64: string, key: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const buf = fromB64(b64);
  if (buf.length === 0 || buf.length % 16) throw new Error('Encrypted data has a bad length');
  for (let i = 0; i < buf.length; i += 16) decryptBlock(buf.subarray(i, i + 16), w);
  const pad = buf[buf.length - 1]!;
  if (pad < 1 || pad > 16 || buf.subarray(buf.length - pad).some((x) => x !== pad)) throw new Error('Decryption failed (wrong key)');
  return buf.slice(0, buf.length - pad);
}

/* ───────────────────────── HMAC ───────────────────────── */

export async function hmacSha256B64(data: Uint8Array, key: Uint8Array): Promise<string> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64(new Uint8Array(await crypto.subtle.sign('HMAC', k, data)));
}

/* ───────────────────────── RSA PKCS#1 v1.5 ───────────────────────── */

interface Tlv {
  tag: number;
  start: number; // content start
  end: number; // content end
  next: number;
}
function tlv(b: Uint8Array, at: number): Tlv {
  const tag = b[at]!;
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++]!;
  }
  if (p + len > b.length) throw new Error('Bad DER');
  return { tag, start: p, end: p + len, next: p + len };
}
function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end; ) {
    const c = tlv(b, p);
    out.push(c);
    p = c.next;
  }
  return out;
}
const bigint = (b: Uint8Array) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
};
function asn1Time(b: Uint8Array, t: Tlv): Date {
  const s = fromUtf8(b.subarray(t.start, t.end));
  const full = t.tag === 0x17 ? (Number(s.slice(0, 2)) >= 50 ? '19' : '20') + s : s; // UTCTime / GeneralizedTime
  return new Date(Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8), +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14) || 0));
}

export interface RsaPublicKey {
  n: bigint;
  e: bigint;
  bytes: number;
  notAfter: Date | null;
}

/** Reads an RSA public key from a PEM X.509 certificate or a PEM public key (SPKI). */
export function readRsaPublicKey(pem: string): RsaPublicKey {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  const der = fromB64(body);
  let spki: Tlv;
  let notAfter: Date | null = null;
  const top = tlv(der, 0);
  const parts = children(der, top);
  if (/BEGIN CERTIFICATE/.test(pem)) {
    const tbs = children(der, parts[0]!);
    let i = tbs[0]!.tag === 0xa0 ? 1 : 0; // optional version
    i += 3; // serial, signature algorithm, issuer
    const validity = children(der, tbs[i]!);
    notAfter = asn1Time(der, validity[1]!);
    spki = tbs[i + 2]!; // subject, then the key
  } else {
    spki = top;
  }
  const [, bits] = children(der, spki);
  // BIT STRING: first content byte is the unused-bit count, then RSAPublicKey ::= SEQ { n, e }
  const rsa = tlv(der, bits!.start + 1);
  const [n, e] = children(der, rsa);
  const nn = bigint(der.subarray(n!.start, n!.end));
  return { n: nn, e: bigint(der.subarray(e!.start, e!.end)), bytes: Math.ceil(nn.toString(16).length / 2), notAfter };
}

function modPow(b: bigint, e: bigint, m: bigint) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** RSAES-PKCS1-v1_5 encryption; returns base64. */
export function rsaPkcs1Encrypt(data: Uint8Array, key: RsaPublicKey): string {
  const k = key.bytes;
  if (data.length > k - 11) throw new Error('Data too long for RSA');
  const em = new Uint8Array(k);
  em[1] = 2;
  const ps = em.subarray(2, k - data.length - 1);
  crypto.getRandomValues(ps);
  for (let i = 0; i < ps.length; i++) while (ps[i] === 0) ps[i] = crypto.getRandomValues(new Uint8Array(1))[0]!;
  em[k - data.length - 1] = 0;
  em.set(data, k - data.length);
  let c = modPow(bigint(em), key.e, key.n).toString(16);
  c = c.padStart(k * 2, '0');
  const out = new Uint8Array(k);
  for (let i = 0; i < k; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return toB64(out);
}

/** A random app key: 32 characters, used as the AES-256 key for the login. */
export function newAppKey(): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(r, (x) => a[x % 36]).join('');
}
