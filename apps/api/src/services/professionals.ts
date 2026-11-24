/**
 * Accountants & CAs — manage the outside finance people a business works with, decide per person which
 * functionality and which data each one sees, and let them ask for more.
 *
 * The authoritative access config lives on the professionals row (`access` jsonb): per module, one of
 *   view     — read only
 *   download — read + run and download reports/exports for that data
 *   edit     — read + create/update records
 * From that config a dedicated per-person role is derived, which the normal permission engine enforces
 * everywhere — nothing else needs to know these users are special. A professional who needs more can
 * raise a request from their own screen; an admin approves it, the config is merged and the role rebuilt.
 */
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { RecordCtx } from './records';

export const KINDS = ['ca', 'accountant', 'auditor', 'bookkeeper', 'tax_consultant'] as const;
export const KIND_LABEL: Record<string, string> = {
  ca: 'Chartered accountant',
  accountant: 'Accountant',
  auditor: 'Auditor',
  bookkeeper: 'Bookkeeper',
  tax_consultant: 'Tax consultant',
};

export const LEVELS = ['view', 'download', 'edit'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = { view: 'Read only', download: 'Download & reports', edit: 'Can edit' };

/**
 * The modules a professional can be granted, each mapped to the work areas it opens (apps) and the
 * record objects it governs. Area and object keys are the real ones the engine knows (packages/shared
 * access.ts / objects.ts). `admin` is the privileged cap the module needs when the level allows editing.
 */
export const MODULES = [
  { key: 'billing', label: 'Invoices & payments', areas: ['billing'], objects: ['invoice', 'payment'], admin: 'billing' },
  { key: 'books', label: 'Bills, expenses & ledger', areas: ['books', 'operations'], objects: ['bill', 'vendor_payment', 'expense', 'vendor'], admin: 'books' },
  // GST returns, the GST portal and e-invoices live under the "Billing & GST" area (apps: billing) and
  // the accountant portal (apps: gst); the returns are built from invoices and bills, and the portal
  // gates on books/billing admin. So this module opens all three areas and reads the source documents.
  { key: 'gst', label: 'GST returns & e-invoices', areas: ['gst', 'books', 'billing'], objects: ['invoice', 'bill', 'expense'], admin: 'compliance' },
  { key: 'intake', label: 'Documents read from mail', areas: ['intake'], objects: [], admin: null },
  { key: 'insights', label: 'Dashboards & reports', areas: ['insights'], objects: [], admin: null },
] as const;
const MODULE_KEYS = MODULES.map((m) => m.key);
export const MODULE_LABEL: Record<string, string> = Object.fromEntries(MODULES.map((m) => [m.key, m.label]));

/** A map of module → level, keys limited to known modules (unknown keys rejected). */
const moduleMap = z
  .record(z.string(), z.enum(LEVELS))
  .refine((m) => Object.keys(m).every((k) => (MODULE_KEYS as readonly string[]).includes(k)), { message: 'Unknown module' })
  .default({});

/** The stored access config. */
export const accessSchema = z.object({
  modules: moduleMap,
  /** may file GST returns and work the compliance calendar (needs the gst module) */
  canFile: z.boolean().default(false),
});
export type AccessConfig = z.infer<typeof accessSchema>;

export function assertManage(ctx: RecordCtx) {
  // managing who the accountants/CAs are is user management — owner or a users-admin only (NOT books
  // admin, which the GST module now grants, so a GST-scoped CA can't manage other professionals)
  const p = ctx.principal.permissions;
  if (!ctx.principal.user.isOwner && !hasAdmin(p, 'users')) {
    throw forbidden('Only an admin can manage accountants and CAs');
  }
}

/** The current user's professional row (or throws) — for self-service endpoints. */
export async function requireSelf(ctx: RecordCtx) {
  const pr = await ctx.tx.one<{ id: string }>(`select id from professionals where tenant_id = $1 and user_id = $2`, [ctx.tenantId, ctx.principal.user.id]);
  if (!pr) throw forbidden('Only accountants and CAs can do this here');
  return pr.id;
}

const edit = { read: 'all', create: true, update: 'all', delete: 'none' } as const;
const NONE = { read: 'none', create: false, update: 'none', delete: 'none' } as const;
const VIEW = { read: 'all', create: false, update: 'none', delete: 'none' } as const;

/** Derives the per-person role permissions from the stored access config. */
function buildPermissions(access: AccessConfig) {
  const mods = Object.entries(access.modules ?? {}) as [string, Level][];
  const picked = MODULES.filter((m) => mods.some(([k]) => k === m.key));
  const levelOf = (k: string): Level | undefined => (access.modules as Record<string, Level>)[k];

  const objects: Record<string, unknown> = { '*': NONE };
  const apps = new Set<string>();
  const admin = new Set<string>();
  let anyReports = false;

  for (const m of picked) {
    const lvl = levelOf(m.key)!;
    const rights = lvl === 'edit' ? edit : VIEW;
    for (const o of m.objects) objects[o] = rights;
    for (const a of m.areas) apps.add(a);
    if (lvl === 'download' || lvl === 'edit') anyReports = true;
    if (lvl === 'edit' && m.admin && m.admin !== 'compliance') admin.add(m.admin); // billing / books admin to change
  }
  // GST returns, e-invoices and the GST portal require books/billing admin to open at all — grant it
  // whenever the GST module is given, so GST details are actually visible (not just the calendar).
  if (levelOf('gst')) admin.add('books');
  // GST filing is opt-in and needs the gst module
  if (access.canFile && levelOf('gst')) admin.add('compliance');
  // reports/exports: open the Dashboards & reports area and analytics for anyone with download or edit
  if (anyReports) {
    apps.add('insights');
    admin.add('analytics');
  }
  // they can always see which customer / vendor a document belongs to
  if (picked.length) {
    objects.account = VIEW;
    objects.contact = VIEW;
  }
  return { objects, apps: [...apps], admin: [...admin] };
}

/** Normalises a stored/partial access blob to the full config shape. */
function normAccess(raw: any): AccessConfig {
  return accessSchema.parse({ modules: raw?.modules ?? {}, canFile: !!raw?.canFile });
}

async function writeRole(ctx: RecordCtx, roleId: string | null, name: string, access: AccessConfig) {
  const perms = JSON.stringify(buildPermissions(access));
  if (roleId) {
    await ctx.tx.query(`update roles set permissions = $3, name = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, roleId, perms, name]);
    return roleId;
  }
  const key = `pro_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const r = await ctx.tx.one<{ id: string }>(
    `insert into roles (tenant_id, key, name, description, is_system, permissions) values ($1,$2,$3,'Access for a finance professional', true, $4) returning id`,
    [ctx.tenantId, key, name, perms],
  );
  return r!.id;
}

export const addSchema = accessSchema.extend({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  fullName: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS).default('accountant'),
  firm: z.string().trim().max(160).nullish(),
  membershipNo: z.string().trim().max(60).nullish(),
  phone: z.string().trim().max(25).nullish(),
  engagedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  engagedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(4000).nullish(),
});

export async function addProfessional(ctx: RecordCtx, input: z.infer<typeof addSchema>) {
  assertManage(ctx);
  const access: AccessConfig = { modules: input.modules, canFile: input.canFile };
  const existing = await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and lower(email) = $2`, [ctx.tenantId, input.email]);
  let userId: string;
  let invited = false;
  if (existing) {
    userId = existing.id;
    const already = await ctx.tx.one<{ id: string }>(`select id from professionals where tenant_id = $1 and user_id = $2`, [ctx.tenantId, userId]);
    if (already) throw badRequest('That person is already an accountant / CA here');
  } else {
    const u = await ctx.tx.one<{ id: string }>(
      `insert into users (tenant_id, email, full_name, status, attributes) values ($1,$2,$3,'invited',$4) returning id`,
      [ctx.tenantId, input.email, input.fullName, JSON.stringify(input.firm ? { firm: input.firm } : {})],
    );
    userId = u!.id;
    invited = true;
  }
  const roleId = await writeRole(ctx, null, `${input.fullName} — access`, access);
  await ctx.tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, userId, roleId]);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into professionals (tenant_id, user_id, role_id, kind, firm, membership_no, phone, engaged_from, engaged_to, notes, access, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app.current_user_id()) returning id`,
    [ctx.tenantId, userId, roleId, input.kind, input.firm ?? null, input.membershipNo ?? null, input.phone ?? null, input.engagedFrom ?? null, input.engagedTo ?? null, input.notes ?? null, JSON.stringify(access)],
  );
  return { id: r!.id, userId, invited, email: input.email, fullName: input.fullName };
}

/** Prepares an invite for an invited professional (the route creates the token and sends the mail). */
export async function inviteTarget(ctx: RecordCtx, id: string) {
  assertManage(ctx);
  const pr = await rowOf(ctx, id);
  const u = await ctx.tx.one<{ email: string; full_name: string; status: string }>(`select email, full_name, status from users where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.user_id]);
  if (!u) throw notFound('Professional not found');
  if (u.status !== 'invited') throw badRequest('This person has already accepted and signed in');
  return { userId: pr.user_id, email: u.email, fullName: u.full_name };
}

export const updateSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(KINDS).optional(),
  firm: z.string().trim().max(160).nullish(),
  membershipNo: z.string().trim().max(60).nullish(),
  phone: z.string().trim().max(25).nullish(),
  engagedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  engagedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  notes: z.string().max(4000).nullish(),
});

export async function updateProfessional(ctx: RecordCtx, id: string, input: z.infer<typeof updateSchema>) {
  assertManage(ctx);
  const pr = await rowOf(ctx, id);
  await ctx.tx.query(
    `update professionals set kind = coalesce($3, kind), firm = $4, membership_no = $5, phone = $6, engaged_from = $7, engaged_to = $8, notes = $9, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, input.kind ?? null, input.firm ?? null, input.membershipNo ?? null, input.phone ?? null, input.engagedFrom ?? null, input.engagedTo ?? null, input.notes ?? null],
  );
  if (input.fullName) {
    await ctx.tx.query(`update users set full_name = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.user_id, input.fullName]);
    if (pr.role_id) await ctx.tx.query(`update roles set name = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.role_id, `${input.fullName} — access`]);
  }
  return { ok: true };
}

/** Replace what this person can see and do. */
export async function setAccess(ctx: RecordCtx, id: string, input: AccessConfig) {
  assertManage(ctx);
  await applyAccess(ctx, id, input);
  return { ok: true };
}

/**
 * Rebuilds every professional's derived role from their stored access config. Called when an admin
 * opens the Accountants & CAs screen, so changes to how modules map to permissions apply to everyone
 * already added, without anyone having to re-save each person.
 */
export async function syncRoles(ctx: RecordCtx) {
  assertManage(ctx);
  const rows = await ctx.tx.query<{ id: string; role_id: string | null; access: any; full_name: string }>(
    `select p.id, p.role_id, p.access, u.full_name from professionals p join users u on u.tenant_id = p.tenant_id and u.id = p.user_id where p.tenant_id = $1`,
    [ctx.tenantId],
  );
  let rebuilt = 0;
  for (const r of rows) {
    if (!r.role_id) continue;
    await writeRole(ctx, r.role_id, `${r.full_name} — access`, normAccess(r.access));
    rebuilt++;
  }
  return { rebuilt };
}

/** Writes the access config to the row and rebuilds the derived role (creating one if missing). */
async function applyAccess(ctx: RecordCtx, id: string, access: AccessConfig) {
  const pr = await rowOf(ctx, id);
  const name = await ctx.tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.user_id]);
  const roleId = await writeRole(ctx, pr.role_id, `${name?.full_name ?? 'Professional'} — access`, access);
  await ctx.tx.query(`update professionals set role_id = $3, access = $4, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, roleId, JSON.stringify(access)]);
  if (!pr.role_id) await ctx.tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, pr.user_id, roleId]);
}

export async function removeProfessional(ctx: RecordCtx, id: string) {
  assertManage(ctx);
  const pr = await rowOf(ctx, id);
  const u = await ctx.tx.one<{ is_owner: boolean }>(`select is_owner from users where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.user_id]);
  if (u?.is_owner) throw badRequest('The workspace owner cannot be removed');
  if (pr.role_id) {
    await ctx.tx.query(`delete from user_roles where tenant_id = $1 and user_id = $2 and role_id = $3`, [ctx.tenantId, pr.user_id, pr.role_id]);
    await ctx.tx.query(`delete from roles where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.role_id]);
  }
  await ctx.tx.query(`delete from professionals where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const left = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from user_roles where tenant_id = $1 and user_id = $2`, [ctx.tenantId, pr.user_id]);
  const disabled = !left?.n;
  if (disabled) await ctx.tx.query(`update users set status = 'disabled' where tenant_id = $1 and id = $2`, [ctx.tenantId, pr.user_id]);
  return { ok: true, disabled };
}

function metaLists() {
  return {
    modules: MODULES.map((m) => ({ key: m.key, label: m.label })),
    levels: LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l] })),
    kinds: KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })),
  };
}

function viewRow(r: Record<string, any>) {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] ?? r.kind,
    fullName: r.full_name,
    email: r.email,
    status: r.status,
    firm: r.firm,
    membershipNo: r.membership_no,
    phone: r.phone,
    engagedFrom: r.engaged_from,
    engagedTo: r.engaged_to,
    notes: r.notes,
    lastLoginAt: r.last_login_at,
    access: normAccess(r.access),
  };
}

export async function listProfessionals(ctx: RecordCtx) {
  assertManage(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select p.id, p.kind, p.firm, p.membership_no, p.phone, p.engaged_from, p.engaged_to, p.notes, p.access, p.user_id,
            u.full_name, u.email, u.status, u.last_login_at
       from professionals p
       join users u on u.tenant_id = p.tenant_id and u.id = p.user_id
      where p.tenant_id = $1 order by u.full_name`,
    [ctx.tenantId],
  );
  const pending = await ctx.tx.query<{ n: number }>(`select count(*)::int as n from professional_access_requests where tenant_id = $1 and status = 'pending'`, [ctx.tenantId]);
  return { items: rows.map(viewRow), pendingRequests: pending[0]?.n ?? 0, ...metaLists() };
}

async function rowOf(ctx: RecordCtx, id: string) {
  const pr = await ctx.tx.one<{ user_id: string; role_id: string | null; access: any }>(`select user_id, role_id, access from professionals where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!pr) throw notFound('Professional not found');
  return pr;
}

// ─── Access requests ──────────────────────────────────────────────────────────────────────────────

export const requestSchema = z.object({
  modules: moduleMap,
  canFile: z.boolean().default(false),
  note: z.string().trim().max(2000).optional(),
});

/** The current user's own professional profile + access + their pending requests. Null if not one. */
export async function meProfile(ctx: RecordCtx) {
  const meId = ctx.principal.user.id;
  const r = await ctx.tx.one<Record<string, any>>(
    `select p.id, p.kind, p.firm, p.membership_no, p.access, u.full_name, u.email
       from professionals p join users u on u.tenant_id = p.tenant_id and u.id = p.user_id
      where p.tenant_id = $1 and p.user_id = $2`,
    [ctx.tenantId, meId],
  );
  if (!r) return { professional: null, ...metaLists() };
  const requests = await ctx.tx.query<Record<string, any>>(
    `select id, requested, note, status, decision_note, decided_at, created_at from professional_access_requests
      where tenant_id = $1 and professional_id = $2 order by created_at desc limit 20`,
    [ctx.tenantId, r.id],
  );
  return {
    professional: {
      id: r.id,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind] ?? r.kind,
      firm: r.firm,
      membershipNo: r.membership_no,
      fullName: r.full_name,
      email: r.email,
      access: normAccess(r.access),
    },
    requests: requests.map((q) => ({ id: q.id, requested: normAccess(q.requested), note: q.note, status: q.status, decisionNote: q.decision_note, decidedAt: q.decided_at, createdAt: q.created_at })),
    ...metaLists(),
  };
}

/** A professional asks for more access. Raised as the signed-in user. */
export async function raiseRequest(ctx: RecordCtx, input: z.infer<typeof requestSchema>) {
  const meId = ctx.principal.user.id;
  const pr = await ctx.tx.one<{ id: string }>(`select id from professionals where tenant_id = $1 and user_id = $2`, [ctx.tenantId, meId]);
  if (!pr) throw forbidden('Only accountants and CAs can request access here');
  if (!Object.keys(input.modules).length && !input.note) throw badRequest('Say what access you need');
  const dup = await ctx.tx.one<{ id: string }>(`select id from professional_access_requests where tenant_id = $1 and professional_id = $2 and status = 'pending'`, [ctx.tenantId, pr.id]);
  if (dup) throw badRequest('You already have a pending request — it is with an admin for approval');
  const r = await ctx.tx.one<{ id: string }>(
    `insert into professional_access_requests (tenant_id, professional_id, requested, note) values ($1,$2,$3,$4) returning id`,
    [ctx.tenantId, pr.id, JSON.stringify({ modules: input.modules, canFile: input.canFile }), input.note ?? null],
  );
  return { id: r!.id, status: 'pending' };
}

/** Admin: pending (and recently decided) access requests. */
export async function listRequests(ctx: RecordCtx) {
  assertManage(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select r.id, r.requested, r.note, r.status, r.decision_note, r.decided_at, r.created_at, r.professional_id,
            u.full_name, u.email, p.kind
       from professional_access_requests r
       join professionals p on p.tenant_id = r.tenant_id and p.id = r.professional_id
       join users u on u.tenant_id = p.tenant_id and u.id = p.user_id
      where r.tenant_id = $1 and (r.status = 'pending' or r.decided_at > now() - interval '30 days')
      order by (r.status = 'pending') desc, r.created_at desc limit 100`,
    [ctx.tenantId],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      professionalId: r.professional_id,
      fullName: r.full_name,
      email: r.email,
      kindLabel: KIND_LABEL[r.kind] ?? r.kind,
      requested: normAccess(r.requested),
      note: r.note,
      status: r.status,
      decisionNote: r.decision_note,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    })),
    ...metaLists(),
  };
}

export const decideSchema = z.object({
  approve: z.boolean(),
  /** when approving, the exact access to grant (defaults to what was requested, merged onto current) */
  grant: accessSchema.optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Admin: approve (merge the granted access and rebuild the role) or deny a request. */
export async function decideRequest(ctx: RecordCtx, id: string, input: z.infer<typeof decideSchema>) {
  assertManage(ctx);
  const req = await ctx.tx.one<{ professional_id: string; requested: any; status: string }>(
    `select professional_id, requested, status from professional_access_requests where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id],
  );
  if (!req) throw notFound('Request not found');
  if (req.status !== 'pending') throw badRequest('This request has already been decided');
  if (input.approve) {
    const pr = await rowOf(ctx, req.professional_id);
    const current = normAccess(pr.access);
    const granted = input.grant ? normAccess(input.grant) : normAccess(req.requested);
    // merge: the higher of current and granted level per module, canFile if either is true
    const modules: Record<string, Level> = { ...(current.modules as Record<string, Level>) };
    for (const [k, lvl] of Object.entries(granted.modules as Record<string, Level>)) {
      modules[k] = maxLevel(modules[k], lvl);
    }
    await applyAccess(ctx, req.professional_id, { modules, canFile: current.canFile || granted.canFile });
  }
  await ctx.tx.query(
    `update professional_access_requests set status = $3, decision_note = $4, decided_by = app.current_user_id(), decided_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, input.approve ? 'approved' : 'denied', input.note ?? null],
  );
  return { ok: true, status: input.approve ? 'approved' : 'denied' };
}

function maxLevel(a: Level | undefined, b: Level): Level {
  const rank = { view: 1, download: 2, edit: 3 } as const;
  if (!a) return b;
  return rank[a] >= rank[b] ? a : b;
}
