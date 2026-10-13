/**
 * Offline outbox. Field work (visit check-ins, notes, walk-in leads) is saved on the device when
 * the network is down and sent once it is back. Entries belong to one user in one workspace and
 * are only ever sent by that user (shared tablets in a showroom are common).
 *
 * Storage: IndexedDB, one object store. Retries happen on reconnect, on app start and on demand.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, api } from './api';

export interface OutboxItem {
  id: string;
  owner: string; // `${tenantId}:${userId}`
  method: 'POST' | 'PATCH';
  path: string;
  body: unknown;
  label: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

const DB = 'synapse-outbox';
const STORE = 'items';
let cache: OutboxItem[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function reload() {
  try {
    cache = ((await run('readonly', (s) => s.getAll())) as OutboxItem[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    cache = [];
  }
  emit();
}

/** Network failures (not server answers) are what make an item wait. */
const offlineError = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 502;

/**
 * Sends now when possible; otherwise stores it. Returns the server response, or `null` when queued.
 * Validation errors (4xx) are thrown so the form can show them.
 */
export async function sendOrQueue<T>(owner: string, item: { method: 'POST' | 'PATCH'; path: string; body: unknown; label: string }): Promise<T | null> {
  if (navigator.onLine) {
    try {
      return await api<T>(item.path, { method: item.method, body: item.body });
    } catch (e) {
      if (!offlineError(e)) throw e;
    }
  }
  const entry: OutboxItem = { ...item, id: crypto.randomUUID(), owner, createdAt: new Date().toISOString(), attempts: 0 };
  await run('readwrite', (s) => s.put(entry));
  await reload();
  return null;
}

let flushing: Promise<{ sent: number; failed: number }> | null = null;

/** Sends this user's waiting items in order. Items the server rejects stay, marked with the error. */
export function flushOutbox(owner: string) {
  flushing ??= (async () => {
    await reload();
    let sent = 0;
    let failed = 0;
    for (const it of cache.filter((i) => i.owner === owner)) {
      try {
        await api(it.path, { method: it.method, body: it.body });
        await run('readwrite', (s) => s.delete(it.id));
        sent++;
      } catch (e) {
        if (offlineError(e)) break; // still offline: keep the order, try later
        failed++;
        await run('readwrite', (s) => s.put({ ...it, attempts: it.attempts + 1, lastError: (e as Error).message }));
      }
    }
    await reload();
    return { sent, failed };
  })().finally(() => (flushing = null));
  return flushing;
}

export async function discardOutboxItem(id: string) {
  await run('readwrite', (s) => s.delete(id));
  await reload();
}

/** Waiting items of the signed-in user; flushes automatically when the connection returns. */
export function useOutbox(owner: string | null, onFlushed?: (r: { sent: number; failed: number }) => void) {
  const items = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => cache,
    () => cache,
  );
  useEffect(() => {
    if (!owner || typeof indexedDB === 'undefined') return;
    const go = () =>
      void flushOutbox(owner).then((r) => {
        if (r.sent || r.failed) onFlushed?.(r);
      });
    void reload().then(() => {
      if (navigator.onLine && cache.some((i) => i.owner === owner)) go();
    });
    window.addEventListener('online', go);
    return () => window.removeEventListener('online', go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  return owner ? items.filter((i) => i.owner === owner) : [];
}

export function useOnline() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
