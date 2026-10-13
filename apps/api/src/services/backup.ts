/**
 * Workspace backups to R2: every business table of one workspace as gzip'd NDJSON.
 *
 * Layout: backups/<tenantId>/<stamp>/manifest.json + part-00001.ndjson.gz …
 * The run is chunked (one page of one table per step, chained as background jobs) so each step
 * stays inside the Workers CPU budget. Downloading concatenates the parts: concatenated gzip
 * members are one valid .gz stream, every line is {"t": table, "r": row}.
 *
 * Credentials never leave the database: sessions, tokens, API keys, password/MFA material and
 * provider/channel secrets are excluded or blanked. Files (R2 objects) are referenced, not copied.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { enqueue, type Waiter } from './jobs';

const SKIP_TABLES = new Set(['sessions', 'user_tokens', 'api_keys', 'push_subscriptions', 'ai_usage', 'record_index', 'assignment_cursors', 'kb_chunks', 'quotas', 'tenant_counters']);
const BLANK_COLUMNS = /(password|secret|_hash(es)?$|token|mfa_|ciphertext|key_hint)/i;
const PAGE = 2000;
const KEEP = 7;

export interface BackupManifest {
  format: 'synapse-backup/1';
  tenantId: string;
  stamp: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  finishedAt?: string;
  requestedBy: string | null;
  tables: { name: string; keyset: boolean; rows: number }[];
  parts: number;
  bytes: number;
  error?: string;
}

const prefix = (tenantId: string) => `backups/${tenantId}/`;
const manifestKey = (tenantId: string, stamp: string) => `${prefix(tenantId)}${stamp}/manifest.json`;
const partKey = (tenantId: string, stamp: string, n: number) => `${prefix(tenantId)}${stamp}/part-${String(n).padStart(5, '0')}.ndjson.gz`;

function bucket(env: Env): R2Bucket {
  if (!env.FILES) throw badRequest('File storage (R2) is not set up for this server, so backups cannot be stored');
  return env.FILES;
}

async function readManifest(env: Env, tenantId: string, stamp: string): Promise<BackupManifest | null> {
  const o = await bucket(env).get(manifestKey(tenantId, stamp));
  return o ? ((await o.json()) as BackupManifest) : null;
}
async function writeManifest(env: Env, m: BackupManifest) {
  await bucket(env).put(manifestKey(m.tenantId, m.stamp), JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } });
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Starts a backup (one running backup per workspace at a time). */
export async function startBackup(env: Env, db: Db, waiter: Waiter | null, tenantId: string, userId: string | null): Promise<BackupManifest> {
  bucket(env);
  const recent = await listBackups(env, tenantId);
  const running = recent.find((b) => b.status === 'running' && Date.now() - Date.parse(b.startedAt) < 30 * 60_000);
  if (running) return running;
  const tables = await db.tx({ tenantId, readOnly: true }, (tx) =>
    tx.query<{ name: string; keyset: boolean }>(
      `select c.table_name as name, bool_or(k.column_name is not null) as keyset
         from information_schema.columns c
         left join information_schema.columns k on k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = 'id' and k.data_type = 'uuid'
        where c.table_schema = 'public' and c.column_name = 'tenant_id'
        group by c.table_name order by c.table_name`,
    ),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const m: BackupManifest = {
    format: 'synapse-backup/1',
    tenantId,
    stamp,
    status: 'running',
    startedAt: new Date().toISOString(),
    requestedBy: userId,
    tables: [{ name: 'tenants', keyset: false, rows: 0 }, ...tables.filter((t) => !SKIP_TABLES.has(t.name)).map((t) => ({ ...t, rows: 0 }))],
    parts: 0,
    bytes: 0,
  };
  await writeManifest(env, m);
  await enqueue(env, waiter, [{ type: 'backup.step', tenantId, stamp, table: 0 }]);
  return m;
}

function clean(row: Record<string, unknown>) {
  for (const k of Object.keys(row)) if (BLANK_COLUMNS.test(k)) row[k] = null;
  return row;
}

async function page(tx: Tx, tenantId: string, t: { name: string; keyset: boolean }, after: string | null) {
  if (t.name === 'tenants') {
    const rows = await tx.query<Record<string, unknown>>(`select id, slug, name, settings, created_at from tenants where id = $1`, [tenantId]);
    return { rows, next: null };
  }
  // table names come from information_schema, never from the request
  const ident = `"${t.name.replace(/"/g, '""')}"`;
  if (t.keyset) {
    const rows = await tx.query<Record<string, unknown>>(
      `select * from ${ident} where tenant_id = $1 ${after ? 'and id > $3::uuid' : ''} order by id limit $2`,
      after ? [tenantId, PAGE, after] : [tenantId, PAGE],
    );
    return { rows, next: rows.length === PAGE ? String(rows[rows.length - 1]!.id) : null };
  }
  const offset = after ? Number(after) : 0;
  const rows = await tx.query<Record<string, unknown>>(`select * from ${ident} where tenant_id = $1 order by ctid limit $2 offset $3`, [tenantId, PAGE, offset]);
  return { rows, next: rows.length === PAGE ? String(offset + PAGE) : null };
}

/** One step: one page of one table → one part. Chains the next step. */
export async function backupStep(env: Env, db: Db, waiter: Waiter | null, job: { tenantId: string; stamp: string; table: number; after?: string | null }) {
  const m = await readManifest(env, job.tenantId, job.stamp);
  if (!m || m.status !== 'running') return;
  try {
    const t = m.tables[job.table];
    if (!t) {
      m.status = 'complete';
      m.finishedAt = new Date().toISOString();
      await writeManifest(env, m);
      await pruneBackups(env, job.tenantId);
      return;
    }
    const { rows, next } = await db.tx({ tenantId: job.tenantId, readOnly: true }, (tx) => page(tx, job.tenantId, t, job.after ?? null));
    if (rows.length) {
      const body = await gzip(rows.map((r) => JSON.stringify({ t: t.name, r: clean(r) })).join('\n') + '\n');
      m.parts += 1;
      m.bytes += body.byteLength;
      t.rows += rows.length;
      await bucket(env).put(partKey(job.tenantId, job.stamp, m.parts), body, { httpMetadata: { contentType: 'application/gzip' } });
    }
    await writeManifest(env, m);
    await enqueue(env, waiter, [next ? { type: 'backup.step', tenantId: job.tenantId, stamp: job.stamp, table: job.table, after: next } : { type: 'backup.step', tenantId: job.tenantId, stamp: job.stamp, table: job.table + 1 }]);
  } catch (e) {
    m.status = 'failed';
    m.error = (e as Error).message.slice(0, 300);
    m.finishedAt = new Date().toISOString();
    await writeManifest(env, m);
  }
}

export async function listBackups(env: Env, tenantId: string): Promise<BackupManifest[]> {
  const r2 = bucket(env);
  const listed = await r2.list({ prefix: prefix(tenantId), delimiter: '/' });
  const stamps = (listed.delimitedPrefixes ?? []).map((p) => p.slice(prefix(tenantId).length).replace(/\/$/, '')).sort().reverse().slice(0, 20);
  const out: BackupManifest[] = [];
  for (const s of stamps) {
    const m = await readManifest(env, tenantId, s);
    if (m) out.push(m);
  }
  return out;
}

/** Keeps the newest KEEP finished backups. */
export async function pruneBackups(env: Env, tenantId: string) {
  const all = await listBackups(env, tenantId);
  const done = all.filter((b) => b.status !== 'running');
  for (const old of done.slice(KEEP)) await deleteBackup(env, tenantId, old.stamp);
}

export async function deleteBackup(env: Env, tenantId: string, stamp: string) {
  const r2 = bucket(env);
  let cursor: string | undefined;
  do {
    const l = await r2.list({ prefix: `${prefix(tenantId)}${stamp}/`, cursor });
    if (l.objects.length) await r2.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
}

/** The whole backup as one .gz stream (the parts are concatenated gzip members). */
export async function backupStream(env: Env, tenantId: string, stamp: string): Promise<{ body: ReadableStream; m: BackupManifest }> {
  if (!/^[0-9TZ-]{10,40}$/.test(stamp)) throw notFound();
  const m = await readManifest(env, tenantId, stamp);
  if (!m || m.status !== 'complete') throw notFound('Backup not found or not finished');
  const r2 = bucket(env);
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      n += 1;
      if (n > m.parts) return ctrl.close();
      const o = await r2.get(partKey(tenantId, stamp, n));
      if (!o) return ctrl.error(new Error(`Backup part ${n} is missing`));
      ctrl.enqueue(new Uint8Array(await o.arrayBuffer()));
    },
  });
  return { body, m };
}

/** Daily cron: workspaces that turned on automatic backups get one a day. */
export async function dailyBackups(env: Env, db: Db) {
  if (!env.FILES) return;
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  for (const t of tenants) {
    const on = await db.tx({ tenantId: t.tenant_id, readOnly: true }, (tx) => tx.one<{ on: boolean }>(`select coalesce((settings -> 'backup' ->> 'daily')::boolean, false) as on from tenants where id = $1`, [t.tenant_id]));
    if (on?.on) await startBackup(env, db, null, t.tenant_id, null).catch(() => undefined);
  }
}
