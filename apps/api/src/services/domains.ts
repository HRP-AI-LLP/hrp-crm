/**
 * Workspace hostnames.
 *
 * Cloudflare's free Universal SSL certificate covers hrpai.in and *.hrpai.in only — one level.
 * A workspace host like acme.hrpsynapse.hrpai.in is two levels deep, so a wildcard route would
 * serve it without a valid certificate. Instead, each vanity host is attached to the Worker as a
 * Workers Custom Domain, which issues its own certificate for that exact hostname at no cost.
 * This is opt-in (needs CF_TENANT_DOMAINS_TOKEN); without it every workspace uses the shared
 * app host (hrpsynapse.hrpai.in) and picks its workspace at sign-in.
 */
import type { Env } from '../env';

export function vanityEnabled(env: Env): boolean {
  return !!(env.CF_TENANT_DOMAINS_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_NAME && env.WORKER_NAME && env.BASE_DOMAIN);
}

export function vanityHost(env: Env, slug: string): string {
  return `${slug}.${env.BASE_DOMAIN}`.toLowerCase();
}

export async function attachWorkerDomain(env: Env, hostname: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!vanityEnabled(env)) return { ok: false, error: 'Vanity workspace domains are not configured' };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${env.CF_TENANT_DOMAINS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hostname, service: env.WORKER_NAME, zone_name: env.CF_ZONE_NAME }),
  }).catch((e: Error) => ({ ok: false, status: 0, json: async () => ({ errors: [{ message: e.message }] }) }) as unknown as Response);
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[] };
  if (!res.ok || j.success === false) return { ok: false, error: j.errors?.[0]?.message ?? `HTTP ${res.status}` };
  return { ok: true };
}

export function signInUrl(env: Env, slug: string, hasVanity: boolean): string | null {
  if (hasVanity) return `https://${vanityHost(env, slug)}/login`;
  if (env.APP_HOST) return `https://${env.APP_HOST}/login?workspace=${encodeURIComponent(slug)}`;
  return null;
}
