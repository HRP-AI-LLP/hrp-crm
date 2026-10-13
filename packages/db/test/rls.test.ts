import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTenant, connect, createTestDatabase } from './helpers';

let app: pg.Client;
let owner: pg.Client;
let tA: string;
let tB: string;
let userA: string;

const one = async <T extends pg.QueryResultRow>(c: pg.Client, sql: string, params: unknown[] = []) => (await c.query<T>(sql, params)).rows[0] as T;

beforeAll(async () => {
  const { ownerUrl, appUrl } = await createTestDatabase('synapse_test_rls');
  owner = await connect(ownerUrl);
  app = await connect(appUrl);
  tA = (await one<{ id: string }>(app, `select app.create_tenant('alpha','Alpha','hrpsynapse.test','a@alpha.test','Alice','h') as id`)).id;
  tB = (await one<{ id: string }>(app, `select app.create_tenant('beta','Beta','hrpsynapse.test','b@beta.test','Bob','h') as id`)).id;
  userA = await asTenant(app, tA, async () => (await one<{ id: string }>(app, `select id from users limit 1`)).id);
  await asTenant(app, tA, () => app.query(`insert into leads (last_name, email) values ('Alpha-Lead','x@alpha.test')`), userA);
  await asTenant(app, tB, () => app.query(`insert into leads (last_name, email) values ('Beta-Lead','y@beta.test')`));
}, 60_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('runtime role', () => {
  it('cannot bypass RLS and is not superuser', async () => {
    const r = await one<{ rolbypassrls: boolean; rolsuper: boolean }>(app, `select rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it('owns no tables', async () => {
    const r = await one<{ n: string }>(app, `select count(*) n from pg_tables where tableowner = current_user`);
    expect(Number(r.n)).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('sees nothing without a tenant context (fail closed)', async () => {
    for (const t of ['leads', 'users', 'roles', 'audit_logs', 'tenants', 'tenant_domains', 'custom_objects']) {
      const r = await one<{ n: string }>(app, `select count(*) n from ${t}`);
      expect(Number(r.n), t).toBe(0);
    }
  });

  it('sees only its own rows', async () => {
    const names = await asTenant(app, tA, async () => (await app.query(`select last_name from leads`)).rows.map((r) => r.last_name));
    expect(names).toEqual(['Alpha-Lead']);
    const tenants = await asTenant(app, tA, async () => (await app.query(`select slug from tenants`)).rows.map((r) => r.slug));
    expect(tenants).toEqual(['alpha']);
  });

  it('rejects writes into another tenant', async () => {
    await expect(asTenant(app, tA, () => app.query(`insert into leads (tenant_id, last_name) values ($1, 'evil')`, [tB]))).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant rows (silently 0 rows)', async () => {
    const res = await asTenant(app, tA, () => app.query(`update leads set last_name = 'pwned' where last_name = 'Beta-Lead'`));
    expect(res.rowCount).toBe(0);
    const del = await asTenant(app, tA, () => app.query(`delete from leads where last_name = 'Beta-Lead'`));
    expect(del.rowCount).toBe(0);
  });

  it('cannot move a row to another tenant', async () => {
    await expect(asTenant(app, tA, () => app.query(`update leads set tenant_id = $1`, [tB]))).rejects.toThrow(/row-level security/);
  });

  it('composite FKs block cross-tenant references even with a guessed id', async () => {
    const betaStage = await asTenant(app, tB, async () => one<{ id: string; pipeline_id: string }>(app, `select id, pipeline_id from pipeline_stages limit 1`));
    await expect(
      asTenant(app, tA, () => app.query(`insert into leads (last_name, pipeline_id, stage_id) values ('x', $1, $2)`, [betaStage.pipeline_id, betaStage.id])),
    ).rejects.toThrow(/foreign key/);
  });

  it('context is transaction scoped and does not leak to the next transaction', async () => {
    await asTenant(app, tA, async () => undefined);
    const r = await one<{ n: string }>(app, `select count(*) n from leads`);
    expect(Number(r.n)).toBe(0);
  });

  it('malformed tenant context fails closed', async () => {
    await expect(asTenant(app, 'not-a-uuid', () => app.query('select count(*) from leads'))).rejects.toThrow(/uuid/);
  });

  it('owner role is also subject to FORCE RLS on tenant tables', async () => {
    const r = await one<{ n: string }>(owner, `select count(*) n from leads`);
    expect(Number(r.n)).toBe(0);
  });
});

describe('platform functions', () => {
  it('resolves hostnames without exposing other tenants', async () => {
    const r = await one<{ tenant_id: string; slug: string }>(app, `select * from app.resolve_tenant_by_host('BETA.hrpsynapse.test')`);
    expect(r.tenant_id).toBe(tB);
    expect(r.slug).toBe('beta');
  });

  it('tenant creation does not leave the new tenant context set', async () => {
    await app.query('begin');
    await app.query(`select app.create_tenant('gamma','Gamma',null,'c@gamma.test','C','h')`);
    const r = await one<{ t: string | null }>(app, `select app.current_tenant_id() t`);
    await app.query('rollback');
    expect(r.t).toBeNull();
  });

  it('app role cannot insert tenants directly', async () => {
    await expect(app.query(`insert into tenants (slug, name) values ('rogue', 'Rogue')`)).rejects.toThrow(/permission denied/);
  });

  it('metadata changes bump meta_version', async () => {
    const before = await asTenant(app, tA, () => one<{ v: number }>(app, `select meta_version v from tenants`));
    await asTenant(app, tA, () => app.query(`insert into custom_fields (object_key, key, label, field_type) values ('lead','budget','Budget','currency')`));
    const after = await asTenant(app, tA, () => one<{ v: number }>(app, `select meta_version v from tenants`));
    expect(after.v).toBeGreaterThan(before.v);
  });
});

describe('audit trail', () => {
  it('records changes with actor and field diff', async () => {
    await asTenant(app, tA, () => app.query(`update leads set company = 'Initech' where last_name = 'Alpha-Lead'`), userA);
    const row = await asTenant(app, tA, () =>
      one<{ actor_id: string; changes: Record<string, unknown> }>(app, `select actor_id, changes from audit_logs where object_key = 'lead' and action = 'update' order by created_at desc limit 1`),
    );
    expect(row.actor_id).toBe(userA);
    expect(row.changes).toHaveProperty('company');
    expect(row.changes).not.toHaveProperty('version');
  });

  it('is append-only for the app role', async () => {
    await expect(asTenant(app, tA, () => app.query(`update audit_logs set action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(asTenant(app, tA, () => app.query(`delete from audit_logs`))).rejects.toThrow(/permission denied/);
  });

  it('is append-only even for the owner', async () => {
    await owner.query('begin');
    await owner.query(`select set_config('app.tenant_id', $1, true)`, [tA]);
    await expect(owner.query(`delete from audit_logs`)).rejects.toThrow(/append-only/);
    await owner.query('rollback');
  });

  it('never captures password hashes', async () => {
    const r = await asTenant(app, tA, () => one<{ n: string }>(app, `select count(*) n from audit_logs where changes ? 'password_hash'`));
    expect(Number(r.n)).toBe(0);
  });
});

describe('custom field index (EAV hybrid)', () => {
  it('mirrors indexed custom fields into typed rows', async () => {
    await asTenant(app, tA, async () => {
      await app.query(`insert into custom_fields (object_key, key, label, field_type, is_indexed) values ('lead','city','City','text',true), ('lead','score2','Score','number',true)`);
      await app.query(`insert into leads (last_name, custom) values ('Idx', '{"city":"Pune","score2":"42","ignored":"x"}')`);
    });
    const rows = await asTenant(app, tA, async () => (await app.query(`select field_key, v_text, v_num from record_index order by field_key`)).rows);
    expect(rows).toEqual([
      { field_key: 'city', v_text: 'pune', v_num: null },
      { field_key: 'score2', v_text: null, v_num: '42' },
    ]);
  });

  it('bad data never breaks a write', async () => {
    await asTenant(app, tA, () => app.query(`insert into leads (last_name, custom) values ('Bad', '{"score2":"not-a-number"}')`));
  });
});
