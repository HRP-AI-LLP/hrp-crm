/**
 * Network restrictions: IPv4 / IPv6 CIDR matching and the workspace network policy check.
 * Only Cloudflare's `cf-connecting-ip` is trusted in production (X-Forwarded-For is client-controlled).
 */
import type { SecurityPolicy } from '@synapse/shared';
import type { Env } from '../env';
import { ApiError } from './errors';

function v4(ip: string): bigint | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s) || Number(s) > 255) return null;
    n = (n << 8n) | BigInt(Number(s));
  }
  return n;
}

function v6(ip: string): bigint | null {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4(tail[1]!);
    if (n === null) return null;
    s = `${s.slice(0, -tail[1]!.length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

export function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const a = v4(ip.trim());
  if (a !== null) return { v: 4, n: a };
  const b = v6(ip.trim());
  if (b === null) return null;
  // IPv4-mapped IPv6 behaves as IPv4
  if (b >> 32n === 0xffffn) return { v: 4, n: b & 0xffffffffn };
  return { v: 6, n: b };
}

/** "203.0.113.0/24", "2001:db8::/32" or a single address. Returns null when malformed. */
export function parseCidr(cidr: string): { v: 4 | 6; net: bigint; bits: number } | null {
  const [addr, len] = cidr.trim().split('/');
  const ip = parseIp(addr ?? '');
  if (!ip) return null;
  const max = ip.v === 4 ? 32 : 128;
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : -1;
  if (bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { v: ip.v, net: ip.n & mask, bits };
}

export function ipInList(ip: string, cidrs: string[]): boolean {
  const a = parseIp(ip);
  if (!a) return false;
  for (const c of cidrs) {
    const r = parseCidr(c);
    if (!r || r.v !== a.v) continue;
    const max = r.v === 4 ? 32 : 128;
    const mask = r.bits === 0 ? 0n : ((1n << BigInt(r.bits)) - 1n) << BigInt(max - r.bits);
    if ((a.n & mask) === r.net) return true;
  }
  return false;
}

export function requestIp(env: Env, header: (n: string) => string | undefined): string | null {
  const cf = header('cf-connecting-ip');
  if (cf) return cf;
  if (env.APP_ENV === 'production') return null;
  return header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/** Why the network policy refuses this request, or null when allowed. */
export function networkRefusal(env: Env, policy: SecurityPolicy | undefined, header: (n: string) => string | undefined): string | null {
  const ips = policy?.ipAllowlist ?? [];
  const countries = policy?.countries ?? [];
  if (!ips.length && !countries.length) return null;
  const ip = requestIp(env, header);
  if (ips.length) {
    if (!ip) return env.APP_ENV === 'production' ? 'Your network address could not be determined' : null;
    if (!ipInList(ip, ips)) return `Access from this network (${ip}) is not allowed for this workspace`;
  }
  if (countries.length) {
    const cc = header('cf-ipcountry')?.toUpperCase();
    if (!cc) return env.APP_ENV === 'production' ? 'Your country could not be determined' : null;
    if (!countries.includes(cc)) return `Access from this country (${cc}) is not allowed for this workspace`;
  }
  return null;
}

export function assertNetworkAllowed(env: Env, policy: SecurityPolicy | undefined, header: (n: string) => string | undefined) {
  const why = networkRefusal(env, policy, header);
  if (why) throw new ApiError(403, 'network_restricted', why);
}
