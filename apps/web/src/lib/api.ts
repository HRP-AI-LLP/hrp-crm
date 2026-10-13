/**
 * API client. The access token lives only in memory; the refresh token is an HttpOnly cookie.
 * On 401 the client refreshes once (single-flight) and retries.
 * On hosts without a workspace mapping (localhost / workers.dev) the workspace slug is sent as
 * X-Tenant; the API only honours that header outside production.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const WS_KEY = 'synapse.workspace';

export function getWorkspace(): string | null {
  try {
    return localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
}
export function setWorkspace(slug: string | null) {
  try {
    if (slug) localStorage.setItem(WS_KEY, slug);
    else localStorage.removeItem(WS_KEY);
  } catch {
    /* storage unavailable */
  }
}
export function setAccessToken(t: string | null) {
  accessToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { field?: string; message: string; path?: string }[],
  ) {
    super(message);
  }
}

let onSessionExpired: (() => void) | null = null;
export function onExpired(fn: () => void) {
  onSessionExpired = fn;
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set('x-requested-with', 'synapse');
  const ws = getWorkspace();
  if (ws) h.set('x-tenant', ws);
  if (accessToken) h.set('authorization', `Bearer ${accessToken}`);
  return h;
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: headers(), credentials: 'same-origin' });
      if (!res.ok) return false;
      const j = (await res.json()) as { accessToken: string };
      accessToken = j.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: HeadersInit } = {}, retry = true): Promise<T> {
  const h = headers(init.headers);
  if (init.body !== undefined) h.set('content-type', 'application/json');
  const res = await fetch(path, { method: init.method ?? 'GET', headers: h, body: init.body === undefined ? undefined : JSON.stringify(init.body), credentials: 'same-origin' });
  if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
    if (await refreshSession()) return api<T>(path, init, false);
    onSessionExpired?.();
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: body ?? {} });
export const patch = <T,>(p: string, body: unknown, headers?: HeadersInit) => api<T>(p, { method: 'PATCH', body, headers });
export const put = <T,>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T,>(p: string) => api<T>(p, { method: 'DELETE' });
