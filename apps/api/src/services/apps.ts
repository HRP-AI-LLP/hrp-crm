/** Switching built-in apps on and off per workspace (see APPS in @synapse/shared). */
import { APPS, appModuleKey, type TenantMeta } from '@synapse/shared';
import { badRequest, notFound } from '../lib/errors';
import { defaultWarehouse } from './inventory';
import type { RecordCtx } from './records';

export function enabledApps(meta: TenantMeta): Set<string> {
  return new Set(meta.modules.filter((m) => m.enabled && m.key.startsWith('app.')).map((m) => m.key.slice(4)));
}

export function listApps(meta: TenantMeta) {
  const on = enabledApps(meta);
  return Object.values(APPS).map((a) => ({ key: a.key, name: a.name, description: a.description, requires: a.requires, enabled: on.has(a.key), objects: a.objects.map((o) => o.plural) }));
}
import { ensureBooks } from './books/ledger';
import { ROLE_AREAS } from '@synapse/shared';

export async function enableApp(ctx: RecordCtx, key: string) {
  const app = APPS[key];
  if (!app) throw notFound('Unknown app');
  const on = enabledApps(ctx.meta);
  for (const r of app.requires) if (!on.has(r)) throw badRequest(`Switch on ${APPS[r]?.name ?? r} first`);
  const mk = appModuleKey(key);
  for (const o of app.objects) {
    await ctx.tx.query(
      `insert into custom_objects (tenant_id, key, label, plural_label, icon, is_standard, module_key) values ($1,$2,$3,$4,$5,true,$6)
       on conflict (tenant_id, key) do update set module_key = excluded.module_key, is_standard = true`,
      [ctx.tenantId, o.key, o.label, o.plural, o.icon, mk],
    );
  }
  await ctx.tx.query(
    `insert into tenant_modules (tenant_id, module_key, version, is_enabled) values ($1,$2,'1',true)
     on conflict (tenant_id, module_key) do update set is_enabled = true`,
    [ctx.tenantId, mk],
  );
  for (const r of app.roles ?? []) {
    await ctx.tx.query(`insert into roles (tenant_id, key, name, description, is_system, permissions) values ($1,$2,$3,$4,true,$5) on conflict (tenant_id, key) do nothing`, [
      ctx.tenantId, r.key, r.name, r.description, JSON.stringify({ ...r.permissions, apps: ROLE_AREAS[r.key] ?? [] }),
    ]);
  }
  // sales reps work on their own orders; everyone else follows their role's "*" rule
  if (key === 'orders') {
    await ctx.tx.query(
      `update roles set permissions = jsonb_set(permissions, '{objects,sales_order}', '{"read":"own","create":true,"update":"own","delete":"none"}'::jsonb, true)
        where tenant_id = $1 and key = 'sales_rep' and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? 'sales_order')`,
      [ctx.tenantId],
    );
  }
  if (key === 'purchasing') {
    await ctx.tx.query(
      `update roles set permissions = jsonb_set(jsonb_set(permissions, '{objects,purchase_order}', '{"read":"all","create":false,"update":"none","delete":"none"}'::jsonb, true),
                                                '{objects,vendor}', '{"read":"all","create":false,"update":"none","delete":"none"}'::jsonb, true)
        where tenant_id = $1 and key = 'sales_rep' and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? 'purchase_order')`,
      [ctx.tenantId],
    );
  }
  if (key === 'projects') {
    // people see the projects they run or work on (membership); managers see their team's
    for (const [role, perm] of [
      ['sales_rep', { read: 'own', create: true, update: 'own', delete: 'none' }],
      ['sales_manager', { read: 'team', create: true, update: 'team', delete: 'none' }],
      ['read_only', { read: 'all', create: false, update: 'none', delete: 'none' }],
      ['inventory_manager', { read: 'own', create: false, update: 'own', delete: 'none' }],
      ['operations', { read: 'own', create: true, update: 'own', delete: 'none' }],
      ['technician', { read: 'own', create: false, update: 'own', delete: 'none' }],
      ['service_agent', { read: 'own', create: false, update: 'own', delete: 'none' }],
      ['accounts', { read: 'all', create: false, update: 'none', delete: 'none' }],
      ['accountant', { read: 'all', create: false, update: 'none', delete: 'none' }],
    ] as const)
      await ctx.tx.query(
        `update roles set permissions = jsonb_set(permissions, '{objects,project}', $3::jsonb, true)
          where tenant_id = $1 and key = $2 and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? 'project')`,
        [ctx.tenantId, role, JSON.stringify(perm)],
      );
  }
  if (key === 'manufacturing') {
    // planners and the store run production; sales can see where an order is; accounts can audit it
    const view = { read: 'all', create: false, update: 'none', delete: 'none' };
    const none = { read: 'none', create: false, update: 'none', delete: 'none' };
    const grants: [string, string, Record<string, unknown>][] = [
      ['sales_rep', 'work_order', view],
      ['sales_rep', 'job_work', none],
      ['sales_manager', 'work_order', view],
      ['sales_manager', 'job_work', view],
      ['read_only', 'work_order', view],
      ['read_only', 'job_work', view],
      ['inventory_manager', 'work_order', { read: 'all', create: true, update: 'all', delete: 'own' }],
      ['inventory_manager', 'job_work', { read: 'all', create: true, update: 'all', delete: 'own' }],
      ['operations', 'work_order', { read: 'all', create: true, update: 'all', delete: 'own' }],
      ['operations', 'job_work', { read: 'all', create: true, update: 'all', delete: 'own' }],
      ['technician', 'work_order', none],
      ['technician', 'job_work', none],
      ['service_agent', 'work_order', none],
      ['service_agent', 'job_work', none],
      ['accounts', 'work_order', view],
      ['accounts', 'job_work', view],
      ['accountant', 'work_order', view],
      ['accountant', 'job_work', view],
    ];
    for (const [role, obj, perm] of grants)
      await ctx.tx.query(
        `update roles set permissions = jsonb_set(permissions, array['objects', $3::text], $4::jsonb, true)
          where tenant_id = $1 and key = $2 and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? $3::text)`,
        [ctx.tenantId, role, obj, JSON.stringify(perm)],
      );
    // people who only look at orders do not see what they cost
    for (const role of ['sales_rep', 'sales_manager', 'read_only'])
      await ctx.tx.query(
        `update roles set permissions = jsonb_set(case when permissions ? 'fields' then permissions else permissions || '{"fields":{}}'::jsonb end, '{fields,work_order}', $3::jsonb, true)
          where tenant_id = $1 and key = $2 and is_system and not coalesce(permissions -> 'fields' ? 'work_order', false)`,
        [ctx.tenantId, role, JSON.stringify({ material_cost: 'hidden', operation_cost: 'hidden' })],
      );
  }
  if (key === 'books') {
    // everyone files their own expenses and claims; sales managers see and approve their team's.
    // Bills and vendor payments stay with accounts (sales roles otherwise inherit "*" create rights).
    const none = { read: 'none', create: false, update: 'none', delete: 'none' };
    const view = { read: 'all', create: false, update: 'none', delete: 'none' };
    const grants: [string, string, Record<string, unknown>][] = [
      ['sales_rep', 'expense', { read: 'own', create: true, update: 'own', delete: 'own' }],
      ['sales_rep', 'bill', none],
      ['sales_rep', 'vendor_payment', none],
      ['sales_manager', 'expense', { read: 'team', create: true, update: 'team', delete: 'own' }],
      ['sales_manager', 'bill', view],
      ['sales_manager', 'vendor_payment', view],
      ['read_only', 'expense', none],
      ...(['inventory_manager', 'operations', 'technician', 'service_agent'] as const).map((r) => [r, 'expense', { read: 'own', create: true, update: 'own', delete: 'own' }] as [string, string, Record<string, unknown>]),
      ['accounts', 'expense', view],
    ];
    for (const [role, object, perm] of grants)
      await ctx.tx.query(
        `update roles set permissions = jsonb_set(permissions, array['objects', $3::text], $4::jsonb, true)
          where tenant_id = $1 and key = $2 and is_system and permissions ? 'objects' and not (permissions -> 'objects' ? $3::text)`,
        [ctx.tenantId, role, object, JSON.stringify(perm)],
      );
    await ensureBooks(ctx.tx, ctx.tenantId);
  }
  if (key === 'inventory' || key === 'orders' || key === 'purchasing') await defaultWarehouse(ctx);
  return { ok: true };
}

export async function disableApp(ctx: RecordCtx, key: string) {
  if (!APPS[key]) throw notFound('Unknown app');
  const on = enabledApps(ctx.meta);
  for (const other of Object.values(APPS)) if (on.has(other.key) && other.requires.includes(key)) throw badRequest(`${other.name} needs this app; switch it off first`);
  await ctx.tx.query(`update tenant_modules set is_enabled = false where tenant_id = $1 and module_key = $2`, [ctx.tenantId, appModuleKey(key)]);
  return { ok: true };
}
