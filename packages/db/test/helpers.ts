import pg from 'pg';
import { migrate } from '../src/migrate';

/**
 * Builds a throwaway database for tests:
 *   TEST_ADMIN_DATABASE_URL  superuser URL (CI: postgres service container)
 * Creates role synapse_owner (non-superuser, like Neon's neondb_owner), a fresh database owned by it,
 * runs all migrations as the owner and returns owner + app connection strings.
 */
export async function createTestDatabase(name: string) {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'synapse_owner') then
        create role synapse_owner login password 'owner_test_pw' createrole;
      end if; end $$;`);
    await admin.query(`alter role synapse_owner with login createrole password 'owner_test_pw'`);
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name} owner synapse_owner`);
  } finally {
    await admin.end();
  }
  const u = new URL(adminUrl);
  const ownerUrl = `postgres://synapse_owner:owner_test_pw@${u.host}/${name}`;
  const appUrl = `postgres://synapse_app:app_test_pw@${u.host}/${name}`;
  await migrate({ connectionString: ownerUrl, appPassword: 'app_test_pw', log: () => undefined });
  return { ownerUrl, appUrl };
}

export async function connect(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/** Runs fn inside a transaction with the tenant context set exactly like the API does. */
export async function asTenant<T>(c: pg.Client, tenantId: string | null, fn: () => Promise<T>, userId?: string): Promise<T> {
  await c.query('begin');
  try {
    await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [tenantId ?? '', userId ?? '']);
    const r = await fn();
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}
