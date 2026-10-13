/**
 * RBAC + ABAC permission model.
 *
 * A role's `permissions` jsonb:
 * {
 *   "objects":    { "*": {read,create,update,delete}, "lead": {...} },          // RBAC, record scope
 *   "fields":     { "lead": { "annual_income": "hidden", "ai_score": "read" } }, // field-level security
 *   "conditions": { "lead": [ { "field": "region", "op": "eq", "value": "$user.region" } ] }, // ABAC
 *   "admin":      ["*"] | ["users","roles","metadata","modules","workflows","domains","audit","channels","ai"]
 * }
 *
 * Record scope: none < own (owner_id = me) < team (me or my direct reports) < all.
 * Multiple roles merge to the most permissive grant. ABAC conditions on one role restrict only that
 * role's grant: a user is unrestricted if any granting role has no conditions; otherwise the
 * condition groups are OR-ed (each group AND-ed).
 */
import { z } from 'zod';

export const ACCESS_LEVELS = ['none', 'own', 'team', 'all'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];
export type FieldAccess = 'hidden' | 'read' | 'edit';
export const ADMIN_AREAS = ['users', 'roles', 'metadata', 'modules', 'workflows', 'domains', 'audit', 'channels', 'ai'] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

export interface ObjectPerm {
  read: Access;
  create: boolean;
  update: Access;
  delete: Access;
}

export const conditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(['eq', 'neq', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});
export type Condition = z.infer<typeof conditionSchema>;

const access = z.enum(ACCESS_LEVELS);
export const rolePermissionsSchema = z.object({
  objects: z
    .record(z.string(), z.object({ read: access.optional(), create: z.boolean().optional(), update: access.optional(), delete: access.optional() }))
    .optional(),
  fields: z.record(z.string(), z.record(z.string(), z.enum(['hidden', 'read', 'edit']))).optional(),
  conditions: z.record(z.string(), z.array(conditionSchema)).optional(),
  admin: z.array(z.string()).optional(),
});
export type RolePermissions = z.infer<typeof rolePermissionsSchema>;

/** Serializable merged permissions (cached at the edge, sent to the SPA). */
export interface EffectivePermissions {
  objects: Record<string, ObjectPerm>;
  fields: Record<string, Record<string, FieldAccess>>;
  /** null = unrestricted; [] would mean "no access" */
  conditions: Record<string, Condition[][] | null>;
  admin: string[];
}

const NONE: ObjectPerm = { read: 'none', create: false, update: 'none', delete: 'none' };
const rank = (a: Access) => ACCESS_LEVELS.indexOf(a);
const maxAccess = (a: Access, b: Access): Access => (rank(a) >= rank(b) ? a : b);
const fieldRank = { hidden: 0, read: 1, edit: 2 } as const;

function objectPermFor(role: RolePermissions, objectKey: string): ObjectPerm {
  const base = role.objects?.['*'] ?? {};
  const specific = role.objects?.[objectKey] ?? {};
  return {
    read: specific.read ?? base.read ?? 'none',
    create: specific.create ?? base.create ?? false,
    update: specific.update ?? base.update ?? 'none',
    delete: specific.delete ?? base.delete ?? 'none',
  };
}

export function mergePermissions(roles: RolePermissions[], objectKeys: string[]): EffectivePermissions {
  const out: EffectivePermissions = { objects: {}, fields: {}, conditions: {}, admin: [] };
  const admin = new Set<string>();
  for (const r of roles) for (const a of r.admin ?? []) admin.add(a);
  out.admin = admin.has('*') ? ['*'] : [...admin].sort();

  for (const obj of objectKeys) {
    let merged: ObjectPerm = { ...NONE };
    const groups: Condition[][] = [];
    let unrestricted = false;
    const fieldAcc: Record<string, FieldAccess> = {};
    const granting: RolePermissions[] = [];

    for (const r of roles) {
      const p = objectPermFor(r, obj);
      merged = {
        read: maxAccess(merged.read, p.read),
        create: merged.create || p.create,
        update: maxAccess(merged.update, p.update),
        delete: maxAccess(merged.delete, p.delete),
      };
      if (p.read !== 'none') {
        granting.push(r);
        const conds = r.conditions?.[obj];
        if (!conds || conds.length === 0) unrestricted = true;
        else groups.push(conds);
      }
    }
    const grantingRoles = granting.length;
    // Field security: a field unlisted in a granting role counts as "edit" for that role;
    // the user gets the most permissive access across granting roles.
    const restricted = new Set(granting.flatMap((r) => Object.keys(r.fields?.[obj] ?? {})));
    for (const k of restricted) {
      const best = Math.max(...granting.map((r) => fieldRank[r.fields?.[obj]?.[k] ?? 'edit']));
      if (best < 2) fieldAcc[k] = best === 0 ? 'hidden' : 'read';
    }

    out.objects[obj] = merged;
    out.fields[obj] = fieldAcc;
    out.conditions[obj] = grantingRoles === 0 ? [] : unrestricted ? null : groups;
  }
  return out;
}

export function objectPerm(p: EffectivePermissions, objectKey: string): ObjectPerm {
  return p.objects[objectKey] ?? NONE;
}

export function fieldAccess(p: EffectivePermissions, objectKey: string, fieldKey: string): FieldAccess {
  const objPerm = objectPerm(p, objectKey);
  if (objPerm.read === 'none') return 'hidden';
  const f = p.fields[objectKey]?.[fieldKey];
  if (f) return f;
  return objPerm.update === 'none' && !objPerm.create ? 'read' : 'edit';
}

export function hasAdmin(p: EffectivePermissions, area: AdminArea | string): boolean {
  return p.admin.includes('*') || p.admin.includes(area);
}

/** Resolves "$user.<attr>" references against the acting user's ABAC attributes. */
export function resolveConditionValue(value: Condition['value'], user: { id: string; attributes: Record<string, unknown> }): unknown {
  if (typeof value === 'string' && value.startsWith('$user.')) {
    const attr = value.slice(6);
    if (attr === 'id') return user.id;
    return user.attributes[attr] ?? null;
  }
  return value;
}
