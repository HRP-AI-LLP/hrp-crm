/**
 * Installable app plumbing: service worker registration, the install prompt, Web Push enrolment.
 * The service worker only exists in production builds (vite.config.ts emits dist/sw.js).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { del, get, post } from './api';

type Navigate = (to: string) => void;

let navigateTo: Navigate | null = null;
let registered = false;

export function registerServiceWorker(navigate: Navigate) {
  navigateTo = navigate;
  if (registered || !('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  registered = true;
  const register = () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
  // a notification was tapped while the app was open: route inside the SPA
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { type?: string; link?: string } | null;
    if (d?.type === 'navigate' && typeof d.link === 'string' && d.link.startsWith('/') && !d.link.startsWith('//')) navigateTo?.(d.link);
  });
}

// ------------------------------------------------------------------------------- install prompt
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export const isStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

/** `install` is set when the browser offers installation (Chrome/Edge/Android). */
export function useInstallPrompt() {
  const ev = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => deferred,
    () => null,
  );
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone();
  return {
    canInstall: !!ev,
    iosHint: ios,
    install: async () => {
      if (!ev) return false;
      await ev.prompt();
      const r = await ev.userChoice;
      deferred = null;
      listeners.forEach((l) => l());
      return r.outcome === 'accepted';
    },
  };
}

// ------------------------------------------------------------------------------- push
export interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
  devices: { id: string; label: string | null; created_at: string; last_success_at: string | null; endpoint_host: string }[];
}

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64u: string) {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) throw new Error('Install the app or reload once online to enable notifications');
  return navigator.serviceWorker.ready;
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Device';
  const br = /edg\//i.test(ua) ? 'Edge' : /chrome\//i.test(ua) ? 'Chrome' : /firefox\//i.test(ua) ? 'Firefox' : /safari\//i.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}${isStandalone() ? ' (app)' : ''}`;
}

/** Asks for permission and registers this device for push. */
export async function enablePush(publicKey: string) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site — allow them in the browser settings');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // a key rotation on the server makes the old subscription useless
  if (sub && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = keyBytes(publicKey);
    if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await post('/api/v1/push/subscriptions', { endpoint: j.endpoint, keys: j.keys, label: deviceLabel() });
}

/** This browser's current push endpoint (null when not subscribed). */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

/** Signing out: this device stops receiving the user's notifications. */
export async function forgetDevice() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await post('/api/v1/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    /* best effort */
  }
}

export const removeDevice = (id: string) => del(`/api/v1/push/subscriptions/${id}`);
export const pushConfig = () => get<PushConfig>('/api/v1/push/config');

export function useCurrentEndpoint() {
  const [ep, setEp] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void currentEndpoint().then(setEp, () => setEp(null));
  }, []);
  return [ep, () => void currentEndpoint().then(setEp, () => setEp(null))] as const;
}
