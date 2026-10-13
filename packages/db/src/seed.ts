/**
 * Seeds a demo tenant with sample data (dev / preview branches only).
 *
 *   DATABASE_URL_OWNER    owner connection string
 *   SEED_TENANT_SLUG      default "demo"
 *   SEED_ADMIN_EMAIL      default "admin@demo.hrpsynapse.local"
 *   SEED_ADMIN_PASSWORD   default: random, printed once
 *   BASE_DOMAIN           e.g. hrpsynapse.com → registers demo.hrpsynapse.com
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@synapse/shared';
import pg from 'pg';

export async function seed(connectionString: string) {
  const slug = process.env.SEED_TENANT_SLUG ?? 'demo';
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@demo.hrpsynapse.local';
  const generated = !process.env.SEED_ADMIN_PASSWORD;
  const password = process.env.SEED_ADMIN_PASSWORD ?? `Demo-${randomBytes(9).toString('base64url')}!`;
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const existing = await c.query(`select tenant_id from app.resolve_tenant_by_slug($1)`, [slug]);
    if (existing.rowCount) {
      console.log(`tenant "${slug}" already exists, skipping seed`);
      return;
    }
    await c.query('begin');
    const { rows } = await c.query<{ id: string }>(`select app.create_tenant($1, $2, $3, $4, $5, $6) as id`, [
      slug, 'Demo Realty Pvt Ltd', process.env.BASE_DOMAIN ?? null, email, 'Demo Admin', await hashPassword(password),
    ]);
    const tid = rows[0]!.id;
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    const admin = (await c.query<{ id: string }>(`select id from users limit 1`)).rows[0]!.id;
    await c.query(`select set_config('app.user_id', $1, true)`, [admin]);

    const acc = await c.query<{ id: string; name: string }>(
      `insert into accounts (name, domain, industry, owner_id) values
         ('Skyline Developers', 'skyline.example', 'real_estate', $1),
         ('Nimbus Tech', 'nimbus.example', 'technology', $1),
         ('Ganga Finance', 'gangafin.example', 'finance', $1)
       returning id, name`,
      [admin],
    );
    const [a1, a2] = acc.rows;
    const ct = await c.query<{ id: string }>(
      `insert into contacts (first_name, last_name, email, phone, title, account_id, owner_id) values
         ('Priya', 'Sharma', 'priya@skyline.example', '+91 98200 00001', 'Head of Sales', $1, $3),
         ('Arjun', 'Mehta', 'arjun@nimbus.example', '+91 98200 00002', 'CTO', $2, $3)
       returning id`,
      [a1!.id, a2!.id, admin],
    );
    const leadStage = (await c.query<{ id: string; pipeline_id: string; key: string }>(
      `select s.id, s.pipeline_id, s.key from pipeline_stages s join pipelines p on p.id = s.pipeline_id
        where p.object_key = 'lead' and p.is_default order by s.position`,
    )).rows;
    const st = (k: string) => leadStage.find((s) => s.key === k)!;
    await c.query(
      `insert into leads (first_name, last_name, company, email, phone, source, pipeline_id, stage_id, owner_id) values
         ('Rohan', 'Verma', 'Verma Traders', 'rohan@verma.example', '+91 99000 11111', 'website', $1, $2, $5),
         ('Sneha', 'Iyer', 'Iyer & Co', 'sneha@iyer.example', '+91 99000 22222', 'referral', $1, $3, $5),
         ('Kabir', 'Khan', null, 'kabir@mail.example', '+91 99000 33333', 'whatsapp', $1, $4, $5)`,
      [st('new').pipeline_id, st('new').id, st('contacted').id, st('qualified').id, admin],
    );
    const dealStages = (await c.query<{ id: string; pipeline_id: string; key: string }>(
      `select s.id, s.pipeline_id, s.key from pipeline_stages s join pipelines p on p.id = s.pipeline_id
        where p.object_key = 'deal' and p.is_default order by s.position`,
    )).rows;
    const ds = (k: string) => dealStages.find((s) => s.key === k)!;
    await c.query(
      `insert into deals (name, account_id, contact_id, pipeline_id, stage_id, amount, close_date, owner_id) values
         ('Skyline CRM rollout', $1, $3, $5, $6, 1800000, current_date + 30, $9),
         ('Nimbus annual licence', $2, $4, $5, $7, 650000, current_date + 14, $9),
         ('Skyline AI add-on', $1, $3, $5, $8, 240000, current_date + 45, $9)`,
      [a1!.id, a2!.id, ct.rows[0]!.id, ct.rows[1]!.id, ds('prospecting').pipeline_id, ds('qualification').id, ds('proposal').id, ds('negotiation').id, admin],
    );
    await c.query(
      `insert into tasks (title, priority, due_at, assignee_id, related_object, related_id)
       select 'Call ' || full_name || ' to qualify', 'high', now() + interval '1 day', $1, 'lead', id from leads`,
      [admin],
    );
    await c.query('commit');
    console.log(`Seeded tenant "${slug}" (${tid})`);
    console.log(`  admin email:    ${email}`);
    if (generated) console.log(`  admin password: ${password}   (shown once, change it after first login)`);
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) {
    console.error('DATABASE_URL_OWNER is required');
    process.exit(1);
  }
  seed(url).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
