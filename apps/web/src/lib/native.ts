/**
 * Native app (Capacitor) notifications. The store app loads this same web app; when it runs
 * inside the app, the PushNotifications plugin is available on window.Capacitor.Plugins and the
 * device gets real Android notifications through Firebase instead of browser push.
 */
import { api, post } from './api';

type Listener = { remove(): Promise<void> };
interface PushPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  createChannel?(c: { id: string; name: string; importance: number; description?: string }): Promise<void>;
  addListener(event: 'registration', cb: (t: { value: string }) => void): Promise<Listener>;
  addListener(event: 'registrationError', cb: (e: { error: string }) => void): Promise<Listener>;
  addListener(event: 'pushNotificationActionPerformed', cb: (a: { notification: { data?: { link?: string } } }) => void): Promise<Listener>;
}
interface Cap {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  Plugins?: { PushNotifications?: PushPlugin };
}
const cap = (): Cap | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: Cap }).Capacitor);
const KEY = 'synapse.fcm';

export const isNativeApp = () => cap()?.isNativePlatform?.() === true;
export const nativePushAvailable = () => isNativeApp() && !!cap()?.Plugins?.PushNotifications;
const platform = () => (cap()?.getPlatform?.() === 'ios' ? 'ios' : 'android');

function remember(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
function remembered() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Registers with Firebase and hands the token to Synapse. Resolves once the server has it. */
async function registerToken(p: PushPlugin): Promise<string> {
  const token = await new Promise<string>((resolve, reject) => {
    const subs: Promise<Listener>[] = [];
    const done = () => subs.forEach((s) => s.then((l) => l.remove()).catch(() => undefined));
    subs.push(p.addListener('registration', (t) => (done(), resolve(t.value))));
    subs.push(p.addListener('registrationError', (e) => (done(), reject(new Error(e.error || 'Could not register for notifications')))));
    p.register().catch((e) => (done(), reject(e)));
    setTimeout(() => (done(), reject(new Error('The phone did not answer; try again'))), 15_000);
  });
  await post('/api/v1/push/native', { token, platform: platform(), label: navigator.userAgent.match(/\(([^;)]+);/)?.[1]?.slice(0, 100) });
  remember(token);
  return token;
}

export async function enableNativePush() {
  const p = cap()?.Plugins?.PushNotifications;
  if (!p) throw new Error('Notifications are not available in this app version');
  const perm = await p.requestPermissions();
  if (perm.receive !== 'granted') throw new Error('Allow notifications for HRP Synapse in the phone’s settings');
  await p.createChannel?.({ id: 'synapse', name: 'Synapse', importance: 4, description: 'Follow-ups, assignments and customer messages' }).catch(() => undefined);
  return registerToken(p);
}

/** At start-up inside the app: open tapped notifications, and refresh a rotated token. */
export function initNativePush(navigate: (to: string) => void) {
  const p = cap()?.Plugins?.PushNotifications;
  if (!p || !isNativeApp()) return () => undefined;
  const l = p.addListener('pushNotificationActionPerformed', (a) => {
    const link = a.notification.data?.link;
    if (link && link.startsWith('/')) navigate(link);
  });
  p.checkPermissions()
    .then((r) => (r.receive === 'granted' && remembered() ? registerToken(p) : null))
    .catch(() => undefined);
  return () => void l.then((x) => x.remove()).catch(() => undefined);
}

/** Signing out on the phone: its token stops receiving this person's notifications. */
export async function forgetNativeToken() {
  const t = remembered();
  if (!t) return;
  await api('/api/v1/push/native/unregister', { method: 'POST', body: { token: t } }).catch(() => undefined);
  remember(null);
}

export const hasNativeToken = () => !!remembered();
