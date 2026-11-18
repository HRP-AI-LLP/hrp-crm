/**
 * The CA portal. The business invites its chartered accountant as a user with the "Chartered
 * accountant (CA)" role: they sign in to a portal of their own with the compliance calendar, the
 * financial statements, GST and TDS returns, the audit trail and read-only invoices, bills and
 * payments — nothing of the CRM. Every filing has a conversation; each side is told when the other
 * writes, and the business is told when the CA files something.
 */
import { APPS, hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { assertBooksAdmin } from './ledger';

export const CA_ROLE = 'chartered_accountant';

/** The people who keep the books and the CA may see filings; changing settings stays with the books. */
export function assertComplianceAccess(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (!hasAdmin(p, 'books') && !hasAdmin(p, 'compliance')) throw forbidden('Requires the books or the compliance permission');
}

export async function ensureCaRole(ctx: RecordCtx) {
  const r = APPS.books!.roles!.find((x) => x.key === CA_ROLE)!;
  await ctx.tx.query(`insert into roles (tenant_id, key, name, description, is_system, permissions) values ($1,$2,$3,$4,true,$5) on conflict (tenant_id, key) do nothing`, [
    ctx.tenantId, r.key, r.name, r.description, JSON.stringify(r.permissions),
  ]);
  return (await ctx.tx.one<{ id: string }>(`select id from roles where tenant_id = $1 and key = $2`, [ctx.tenantId, CA_ROLE]))!.id;
}

export async function listAccountants(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  return ctx.tx.query(
    `select u.id, u.full_name, u.email, u.status, u.last_login_at, u.attributes ->> 'firm' as firm
       from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where u.tenant_id = $1 and r.key = $2 order by u.status, u.full_name`,
    [ctx.tenantId, CA_ROLE],
  );
}

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  fullName: z.string().trim().min(1).max(120),
  firm: z.string().trim().max(120).nullish(),
  assignFilings: z.boolean().default(true),
});

/** Creates the CA's login (invited) with the CA role; optionally makes them the one who files. */
export async function addAccountant(ctx: RecordCtx, input: z.infer<typeof inviteSchema>) {
  await assertBooksAdmin(ctx);
  const roleId = await ensureCaRole(ctx);
  const exists = await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and lower(email) = $2`, [ctx.tenantId, input.email]);
  let id: string;
  let invited = false;
  if (exists) {
    // someone already in the workspace (e.g. the CA's article) gets the CA role as well
    id = exists.id;
    await ctx.tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, id, roleId]);
  } else {
    const u = await ctx.tx.one<{ id: string }>(`insert into users (tenant_id, email, full_name, status, attributes) values ($1,$2,$3,'invited',$4) returning id`, [
      ctx.tenantId, input.email, input.fullName, JSON.stringify(input.firm ? { firm: input.firm } : {}),
    ]);
    id = u!.id;
    await ctx.tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3)`, [ctx.tenantId, id, roleId]);
    invited = true;
  }
  if (input.assignFilings) {
    await ctx.tx.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{compliance}', coalesce(settings -> 'compliance', '{}'::jsonb) || jsonb_build_object('defaultAssigneeId', $2::text)) where id = $1`, [ctx.tenantId, id]);
    await ctx.tx.query(`update compliance_items set assignee_id = $2, updated_at = now() where tenant_id = $1 and assignee_id is null and status in ('pending','in_progress')`, [ctx.tenantId, id]);
  }
  return { id, invited };
}

/** Takes the CA role away (and switches off a login that has nothing else). */
export async function removeAccountant(ctx: RecordCtx, userId: string) {
  await assertBooksAdmin(ctx);
  const u = await ctx.tx.one<{ is_owner: boolean }>(`select is_owner from users where tenant_id = $1 and id = $2`, [ctx.tenantId, userId]);
  if (!u) throw notFound();
  if (u.is_owner) throw badRequest('The workspace owner cannot be removed');
  await ctx.tx.query(`delete from user_roles where tenant_id = $1 and user_id = $2 and role_id = (select id from roles where tenant_id = $1 and key = $3)`, [ctx.tenantId, userId, CA_ROLE]);
  const left = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from user_roles where tenant_id = $1 and user_id = $2`, [ctx.tenantId, userId]);
  if (!left?.n) await ctx.tx.query(`update users set status = 'disabled' where tenant_id = $1 and id = $2`, [ctx.tenantId, userId]);
  return { ok: true, disabled: !left?.n };
}

/* ───────────── conversation on a filing ───────────── */

export async function comments(ctx: RecordCtx, itemId: string) {
  assertComplianceAccess(ctx);
  return ctx.tx.query(
    `select c.id, c.body, c.created_at, c.author_id, coalesce(u.full_name, 'Someone') as author,
            exists (select 1 from user_roles ur join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id where ur.tenant_id = c.tenant_id and ur.user_id = c.author_id and r.key = $3) as from_ca
       from compliance_comments c left join users u on u.tenant_id = c.tenant_id and u.id = c.author_id
      where c.tenant_id = $1 and c.item_id = $2 order by c.created_at`,
    [ctx.tenantId, itemId, CA_ROLE],
  );
}

/** Everyone on the filing's side gets told: the CA(s) when the business writes, the business when the CA does. */
async function tell(ctx: RecordCtx, itemId: string, title: string, body: string) {
  const me = ctx.principal.user.id;
  const item = await ctx.tx.one<{ name: string; assignee_id: string | null }>(`select name, assignee_id from compliance_items where tenant_id = $1 and id = $2`, [ctx.tenantId, itemId]);
  if (!item) throw notFound();
  const iAmCa = !hasAdmin(ctx.principal.permissions, 'books');
  const to = iAmCa
    ? await ctx.tx.query<{ id: string }>(
        `select distinct u.id from users u left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          where u.tenant_id = $1 and u.status = 'active' and (u.is_owner or r.permissions -> 'admin' ? 'books' or r.permissions -> 'admin' ? '*')`,
        [ctx.tenantId],
      )
    : await ctx.tx.query<{ id: string }>(
        `select distinct u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          where u.tenant_id = $1 and u.status = 'active' and r.key = $2`,
        [ctx.tenantId, CA_ROLE],
      );
  const link = iAmCa ? '/books#compliance' : '/ca';
  for (const u of to) if (u.id !== me) await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'compliance',$3,$4,$5)`, [ctx.tenantId, u.id, `${title}: ${item.name}`.slice(0, 200), body.slice(0, 500), link]);
}

export async function addComment(ctx: RecordCtx, itemId: string, body: string) {
  assertComplianceAccess(ctx);
  if (!(await ctx.tx.one(`select 1 from compliance_items where tenant_id = $1 and id = $2`, [ctx.tenantId, itemId]))) throw notFound();
  const r = await ctx.tx.one<{ id: string }>(`insert into compliance_comments (tenant_id, item_id, body) values ($1,$2,$3) returning id`, [ctx.tenantId, itemId, body]);
  await tell(ctx, itemId, `${ctx.principal.user.fullName} wrote`, body);
  return { id: r!.id };
}

/** Called after a filing changes: the business hears when its CA files or asks for something. */
export async function afterItemUpdate(ctx: RecordCtx, itemId: string, status?: string) {
  if (hasAdmin(ctx.principal.permissions, 'books')) return;
  if (status === 'filed') await tell(ctx, itemId, 'Filed by your CA', `${ctx.principal.user.fullName} marked it filed`);
  else if (status) await tell(ctx, itemId, 'Updated by your CA', `${ctx.principal.user.fullName} set it to ${status.replace('_', ' ')}`);
}

export function assertNotCaOnly(ctx: RecordCtx, what: string) {
  if (!hasAdmin(ctx.principal.permissions, 'books')) throw forbidden(`Only the people who keep the books can ${what}`);
}

