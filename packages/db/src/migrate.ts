/**
 * Forward-only SQL migration runner.
 *
 *   DATABASE_URL_OWNER  owner connection string (direct / non-pooled endpoint)
 *   APP_DB_PASSWORD     optional: enables LOGIN for synapse_app with this password
 *
 * Each file runs in its own transaction under an advisory lock, and applied files are
 * checksum-verified so an edited, already-applied migration fails loudly instead of drifting.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_ID = 72_617_301;

export interface MigrateOptions {
  connectionString: string;
  appPassword?: string | undefined;
  log?: (msg: string) => void;
  statusOnly?: boolean;
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? console.log;
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`create schema if not exists ops`);
    await client.query(`create table if not exists ops.schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>('select name, checksum from ops.schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        continue;
      }
      if (opts.statusOnly) {
        log(`pending  ${file}`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into ops.schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    if (opts.appPassword && !opts.statusOnly) {
      // ALTER ROLE cannot take bind parameters; format(%L) quotes the literal safely server-side.
      const { rows: r } = await client.query<{ stmt: string }>(
        `select format('alter role synapse_app with login password %L', $1::text) as stmt`,
        [opts.appPassword],
      );
      await client.query(r[0]!.stmt);
      log('synapse_app login enabled');
    }

    const check = await client.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = 'synapse_app'`,
    );
    if (check.rows[0]?.rolbypassrls || check.rows[0]?.rolsuper) {
      throw new Error('SECURITY: synapse_app can bypass RLS. Refusing to continue.');
    }
    if (!applied.length && !opts.statusOnly) log('database is up to date');
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    console.error('DATABASE_URL_OWNER is required (owner role, direct endpoint).');
    process.exit(1);
  }
  migrate({ connectionString: url, appPassword: process.env.APP_DB_PASSWORD, statusOnly: process.argv.includes('--status') })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
