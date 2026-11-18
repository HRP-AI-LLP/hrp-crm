/**
 * IT services for clients: the client's asset register (hardware, software licences with seats,
 * cloud, domains and certificates) with an assignment / repair / renewal history and renewal
 * reminders, an encrypted credentials vault where every reveal is recorded, and technical
 * documents (runbooks, architecture, configuration) kept per client with a version number.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import type { Db, Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';

function assertClientRead(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'projects') || objectPerm(p, 'account').read !== 'none') return;
  throw forbidden('You cannot see clients');
}
function assertClientWrite(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'projects') || objectPerm(p, 'account').update !== 'none' || objectPerm(p, 'project').update !== 'none') return;
  throw forbidden('You cannot change client records');
}

/* ───────────── assets ───────────── */

export interface AssetInput {
  accountId: string;
  contactId?: string | null;
  kind: string;
  name: string;
  make?: string | null;
  model?: string | null;
  serialNo?: string | null;
  assetTag?: string | null;
  location?: string | null;
  vendorName?: string | null;
  purchasedOn?: string | null;
  cost?: number | null;
  warrantyEndsOn?: string | null;
  renewsOn?: string | null;
  seats?: number | null;
  seatsUsed?: number | null;
  status?: 'in_use' | 'in_stock' | 'repair' | 'retired';
  notes?: string | null;
}

export async function listAssets(ctx: RecordCtx, q: { accountId?: string | null; kind?: string | null; status?: string | null; search?: string | null; renewingDays?: number | null }) {
  assertClientRead(ctx);
  return ctx.tx.query(
    `select x.*, x.cost::float8 as cost, a.name as account, c.full_name as assigned_to,
            least(x.warranty_ends_on, x.renews_on) as next_date, (least(x.warranty_ends_on, x.renews_on) - current_date) as days_left
       from client_assets x join accounts a on a.tenant_id = x.tenant_id and a.id = x.account_id left join contacts c on c.tenant_id = x.tenant_id and c.id = x.contact_id
      where x.tenant_id = $1 and ($2::uuid is null or x.account_id = $2) and ($3::text is null or x.kind = $3) and ($4::text is null or x.status = $4)
        and ($5::text is null or x.name ilike '%' || $5 || '%' or x.serial_no ilike '%' || $5 || '%' or x.asset_tag ilike '%' || $5 || '%' or x.model ilike '%' || $5 || '%')
        and ($6::int is null or (x.status <> 'retired' and least(x.warranty_ends_on, x.renews_on) between current_date - 30 and current_date + $6))
      order by a.name, x.kind, x.name limit 1000`,
    [ctx.tenantId, q.accountId ?? null, q.kind ?? null, q.status ?? null, q.search?.trim() || null, q.renewingDays ?? null],
  );
}

export async function saveAsset(ctx: RecordCtx, id: string | null, input: AssetInput) {
  assertClientWrite(ctx);
  if (input.seats != null && input.seatsUsed != null && input.seatsUsed > input.seats) throw badRequest('More seats in use than bought');
  const vals = [
    input.accountId, input.contactId ?? null, input.kind, input.name, input.make ?? null, input.model ?? null, input.serialNo ?? null, input.assetTag ?? null, input.location ?? null, input.vendorName ?? null,
    input.purchasedOn ?? null, input.cost ?? null, input.warrantyEndsOn ?? null, input.renewsOn ?? null, input.seats ?? null, input.seatsUsed ?? null, input.status ?? 'in_use', input.notes ?? null,
  ];
  if (id) {
    const before = await ctx.tx.one<{ contact_id: string | null; status: string; renews_on: string | null }>(`select contact_id, status, renews_on::text from client_assets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (!before) throw notFound('Asset not found');
    await ctx.tx.query(
      `update client_assets set account_id = $3, contact_id = $4, kind = $5, name = $6, make = $7, model = $8, serial_no = $9, asset_tag = $10, location = $11, vendor_name = $12,
              purchased_on = $13, cost = $14, warranty_ends_on = $15, renews_on = $16, seats = $17, seats_used = $18, status = $19, notes = $20, updated_at = now(),
              reminded_on = case when $16::date is distinct from renews_on then null else reminded_on end
        where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id, ...vals],
    );
    // the history follows what changed
    if ((before.contact_id ?? null) !== (input.contactId ?? null)) await event(ctx.tx, ctx.tenantId, id, input.contactId ? 'assigned' : 'returned', input.contactId ?? before.contact_id, null);
    if (before.status !== (input.status ?? 'in_use')) {
      const k = input.status === 'repair' ? 'repair' : input.status === 'retired' ? 'retired' : 'note';
      await event(ctx.tx, ctx.tenantId, id, k, null, `Status: ${before.status.replace('_', ' ')} → ${(input.status ?? 'in_use').replace('_', ' ')}`);
    }
    if ((before.renews_on ?? null) !== (input.renewsOn ?? null) && input.renewsOn && before.renews_on && input.renewsOn > before.renews_on) await event(ctx.tx, ctx.tenantId, id, 'renewed', null, `Renewed until ${input.renewsOn}`);
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into client_assets (tenant_id, account_id, contact_id, kind, name, make, model, serial_no, asset_tag, location, vendor_name, purchased_on, cost, warranty_ends_on, renews_on, seats, seats_used, status, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
    [ctx.tenantId, ...vals],
  );
  await event(ctx.tx, ctx.tenantId, r!.id, 'added', null, null);
  if (input.contactId) await event(ctx.tx, ctx.tenantId, r!.id, 'assigned', input.contactId, null);
  return { id: r!.id };
}

async function event(tx: Tx, tenantId: string, assetId: string, kind: string, contactId: string | null, note: string | null) {
  await tx.query(`insert into asset_events (tenant_id, asset_id, kind, contact_id, note) values ($1,$2,$3,$4,$5)`, [tenantId, assetId, kind, contactId, note]);
}

export async function addAssetNote(ctx: RecordCtx, id: string, note: string) {
  assertClientWrite(ctx);
  if (!(await ctx.tx.one(`select 1 from client_assets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]))) throw notFound('Asset not found');
  await event(ctx.tx, ctx.tenantId, id, 'note', null, note);
  return { ok: true };
}

export async function assetHistory(ctx: RecordCtx, id: string) {
  assertClientRead(ctx);
  return ctx.tx.query(
    `select e.kind, e.note, e.at, c.full_name as contact, u.full_name as actor from asset_events e left join contacts c on c.tenant_id = e.tenant_id and c.id = e.contact_id
       left join users u on u.tenant_id = e.tenant_id and u.id = e.actor_id where e.tenant_id = $1 and e.asset_id = $2 order by e.at desc limit 200`,
    [ctx.tenantId, id],
  );
}

export async function deleteAsset(ctx: RecordCtx, id: string) {
  assertClientWrite(ctx);
  await ctx.tx.query(`delete from client_assets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Daily: tells the account owner about warranties and renewals ending within 30 days (once each). */
export async function assetRenewalSweep(env: Env, db: Db, tenantId: string) {
  return db.tx({ tenantId }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    if (!ctx) return { reminded: 0 };
    const due = await tx.query<{ id: string; name: string; account: string; owner_id: string | null; d: string }>(
      `select x.id, x.name, a.name as account, a.owner_id, least(x.warranty_ends_on, x.renews_on)::text as d
         from client_assets x join accounts a on a.tenant_id = x.tenant_id and a.id = x.account_id
        where x.tenant_id = $1 and x.status <> 'retired' and x.reminded_on is null and least(x.warranty_ends_on, x.renews_on) between current_date and current_date + 30`,
      [tenantId],
    );
    const fallback = (await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [tenantId]))?.id ?? null;
    for (const x of due) {
      const to = x.owner_id ?? fallback;
      if (to) {
        await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'reminder',$3,$4,'/it/assets')`, [
          tenantId, to, `Renewal due: ${x.name}`, `${x.account} · ${x.d}`,
        ]);
      }
      await tx.query(`update client_assets set reminded_on = current_date where tenant_id = $1 and id = $2`, [tenantId, x.id]);
    }
    return { reminded: due.length };
  });
}

/* ───────────── credentials vault ───────────── */

function encKey(env: Env) {
  if (!env.DATA_ENCRYPTION_KEY) throw badRequest('The vault needs DATA_ENCRYPTION_KEY set on the server');
  return env.DATA_ENCRYPTION_KEY;
}

/** Who may open a secret: the vault permission, project admins, or the client's account owner. */
async function assertReveal(ctx: RecordCtx, accountId: string) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'vault') || hasAdmin(p, 'projects')) return;
  const own = await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2 and owner_id = $3`, [ctx.tenantId, accountId, ctx.principal.user.id]);
  if (!own) throw forbidden('Opening client credentials needs the "Reveal client credentials" permission');
}

export async function listSecrets(ctx: RecordCtx, accountId: string | null) {
  assertClientRead(ctx);
  return ctx.tx.query(
    `select s.id, s.account_id, a.name as account, s.title, s.url, s.username, s.notes, s.created_at, s.updated_at, s.last_revealed_at, u.full_name as last_revealed_by
       from client_secrets s join accounts a on a.tenant_id = s.tenant_id and a.id = s.account_id left join users u on u.tenant_id = s.tenant_id and u.id = s.last_revealed_by
      where s.tenant_id = $1 and ($2::uuid is null or s.account_id = $2) order by a.name, s.title`,
    [ctx.tenantId, accountId],
  );
}

export async function saveSecret(ctx: RecordCtx, env: Env, id: string | null, input: { accountId: string; title: string; url?: string | null; username?: string | null; secret?: string | null; notes?: string | null }) {
  await assertReveal(ctx, input.accountId);
  if (id) {
    const cipher = input.secret ? await encryptSecret(encKey(env), input.secret, ctx.tenantId) : null;
    const r = await ctx.tx.one(
      `update client_secrets set account_id = $3, title = $4, url = $5, username = $6, notes = $7, secret_ciphertext = coalesce($8, secret_ciphertext), updated_at = now() where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, input.accountId, input.title, input.url ?? null, input.username ?? null, input.notes ?? null, cipher],
    );
    if (!r) throw notFound('Entry not found');
    return { id };
  }
  if (!input.secret) throw badRequest('Enter the password or key to keep');
  const cipher = await encryptSecret(encKey(env), input.secret, ctx.tenantId);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into client_secrets (tenant_id, account_id, title, url, username, secret_ciphertext, notes) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, input.accountId, input.title, input.url ?? null, input.username ?? null, cipher, input.notes ?? null],
  );
  return { id: r!.id };
}

/** Opens one secret; who opened it and when is kept on the entry and in the audit log. */
export async function revealSecret(ctx: RecordCtx, env: Env, id: string) {
  const s = await ctx.tx.one<{ account_id: string; secret_ciphertext: string; title: string }>(`select account_id, secret_ciphertext, title from client_secrets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!s) throw notFound('Entry not found');
  await assertReveal(ctx, s.account_id);
  const secret = await decryptSecret(encKey(env), s.secret_ciphertext, ctx.tenantId);
  await ctx.tx.query(`update client_secrets set last_revealed_at = now(), last_revealed_by = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, ctx.principal.user.id]);
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1,'secret_revealed','client_secret',$2,$3)`, [ctx.tenantId, id, JSON.stringify({ title: s.title })]);
  return { secret };
}

export async function deleteSecret(ctx: RecordCtx, id: string) {
  const s = await ctx.tx.one<{ account_id: string }>(`select account_id from client_secrets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!s) throw notFound('Entry not found');
  await assertReveal(ctx, s.account_id);
  await ctx.tx.query(`delete from client_secrets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/* ───────────── technical documents ───────────── */

export async function listDocs(ctx: RecordCtx, q: { accountId?: string | null; kind?: string | null; search?: string | null }) {
  assertClientRead(ctx);
  return ctx.tx.query(
    `select d.id, d.account_id, a.name as account, d.project_id, d.kind, d.title, d.version, d.updated_at, u.full_name as updated_by, length(coalesce(d.body, '')) as size
       from tech_docs d join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id left join users u on u.tenant_id = d.tenant_id and u.id = d.updated_by
      where d.tenant_id = $1 and ($2::uuid is null or d.account_id = $2) and ($3::text is null or d.kind = $3) and ($4::text is null or d.title ilike '%' || $4 || '%' or d.body ilike '%' || $4 || '%')
      order by d.updated_at desc limit 500`,
    [ctx.tenantId, q.accountId ?? null, q.kind ?? null, q.search?.trim() || null],
  );
}

export async function getDoc(ctx: RecordCtx, id: string) {
  assertClientRead(ctx);
  const d = await ctx.tx.one(`select d.*, a.name as account from tech_docs d join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id where d.tenant_id = $1 and d.id = $2`, [ctx.tenantId, id]);
  if (!d) throw notFound('Document not found');
  return d;
}

export async function saveDoc(ctx: RecordCtx, id: string | null, input: { accountId: string; projectId?: string | null; kind: string; title: string; body?: string | null }) {
  assertClientWrite(ctx);
  if (id) {
    const r = await ctx.tx.one(
      `update tech_docs set account_id = $3, project_id = $4, kind = $5, title = $6, body = $7, version = version + 1, updated_by = $8, updated_at = now() where tenant_id = $1 and id = $2 returning id, version`,
      [ctx.tenantId, id, input.accountId, input.projectId ?? null, input.kind, input.title, input.body ?? null, ctx.principal.user.id],
    );
    if (!r) throw notFound('Document not found');
    return r;
  }
  const r = await ctx.tx.one(`insert into tech_docs (tenant_id, account_id, project_id, kind, title, body) values ($1,$2,$3,$4,$5,$6) returning id, version`, [
    ctx.tenantId, input.accountId, input.projectId ?? null, input.kind, input.title, input.body ?? null,
  ]);
  return r!;
}

export async function deleteDoc(ctx: RecordCtx, id: string) {
  assertClientWrite(ctx);
  await ctx.tx.query(`delete from tech_docs where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}
