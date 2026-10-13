import {
  CUSTOM_OBJECT_BASE_FIELDS,
  type FieldDef,
  type ObjectMeta,
  type PipelineMeta,
  type RolePermissions,
  type TenantMeta,
  isStandardObject,
  mergePermissions,
  rolePermissionsSchema,
  STANDARD_FIELDS,
} from '@synapse/shared';
import type { Env, Principal, TenantInfo } from '../env';
import { EdgeCache } from '../lib/cache';
import type { Db, Tx } from '../lib/db';

const TENANT_TTL = 60;

type TenantRow = { tenant_id: string; slug: string; name: string; status: string; meta_version: number };
const toInfo = (r: TenantRow): TenantInfo => ({ id: r.tenant_id, slug: r.slug, name: r.name, status: r.status, metaVersion: r.meta_version });

/** True when the workspace may be chosen by the X-Tenant header on this host. */
export function isAppHost(env: Env, host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (env.APP_HOST && h === env.APP_HOST.toLowerCase()) return true;
  return env.APP_ENV !== 'production' && env.ALLOW_TENANT_HEADER === 'true';
}

/**
 * Resolves the tenant for a request:
 *   1. hostname registry (vanity <slug>.<BASE_DOMAIN> hosts and verified custom domains) — wins always
 *   2. on the shared app host, the workspace chosen at sign-in (X-Tenant header)
 * Either way the access token's audience must match the resolved tenant, and RLS applies.
 */
export async function resolveTenant(env: Env, db: Db, host: string, headerSlug: string | null): Promise<TenantInfo | null> {
  const cache = new EdgeCache(env);
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const byHost = await cache.getOrLoad<TenantInfo | { none: true }>(`p:host:${h}`, { ttlSeconds: TENANT_TTL }, async () => {
    const rows = await db.platform<TenantRow>('select * from app.resolve_tenant_by_host($1)', [h]);
    return rows[0] ? toInfo(rows[0]) : { none: true };
  });
  if (!('none' in byHost)) return byHost;

  if (headerSlug && isAppHost(env, h)) {
    const slug = headerSlug.toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
    const bySlug = await cache.getOrLoad<TenantInfo | { none: true }>(`p:slug:${slug}`, { ttlSeconds: TENANT_TTL }, async () => {
      const rows = await db.platform<TenantRow>('select * from app.resolve_tenant_by_slug($1)', [slug]);
      return rows[0] ? toInfo(rows[0]) : { none: true };
    });
    if (!('none' in bySlug)) return bySlug;
  }
  return null;
}

export async function invalidateTenantCache(env: Env, tenant: TenantInfo, host?: string) {
  const cache = new EdgeCache(env);
  await Promise.all([cache.delete(`p:slug:${tenant.slug}`), host ? cache.delete(`p:host:${host.toLowerCase().replace(/:\d+$/, '')}`) : undefined]);
}

// ------------------------------------------------------------------------------------------------
// Metadata (objects + fields + pipelines), cached by (tenant, meta_version) → safe to cache in KV.
// ------------------------------------------------------------------------------------------------
export async function loadMeta(env: Env, tx: Tx, tenant: TenantInfo): Promise<TenantMeta> {
  const cache = new EdgeCache(env);
  return cache.getOrLoad(`t:${tenant.id}:meta:v${tenant.metaVersion}`, { ttlSeconds: 86_400, kv: true }, () => readMeta(tx, tenant));
}

export async function readMeta(tx: Tx, tenant: TenantInfo): Promise<TenantMeta> {
  // sequential on purpose: one pg client per request cannot pipeline concurrent queries
  const objects = await tx.query<{ key: string; label: string; plural_label: string; icon: string | null; is_standard: boolean; module_key: string | null }>(
      `select key, label, plural_label, icon, is_standard, module_key from custom_objects where tenant_id = $1 order by is_standard desc, label`,
      [tenant.id],
    );
  const fields = await tx.query<{ object_key: string; key: string; label: string; field_type: FieldDef['type']; is_required: boolean; is_indexed: boolean; is_pii: boolean; options: FieldDef['options']; help_text: string | null; position: number; module_key: string | null }>(
      `select object_key, key, label, field_type, is_required, is_indexed, is_pii, options, help_text, position, module_key
         from custom_fields where tenant_id = $1 order by position, label`,
      [tenant.id],
    );
  const pipes = await tx.query<{ id: string; object_key: string; name: string; is_default: boolean }>(
      `select id, object_key, name, is_default from pipelines where tenant_id = $1 order by position, name`,
      [tenant.id],
    );
  const stages = await tx.query<{ id: string; pipeline_id: string; key: string; label: string; position: number; probability: number; category: 'open' | 'won' | 'lost'; color: string | null }>(
      `select id, pipeline_id, key, label, position, probability, category, color from pipeline_stages where tenant_id = $1 order by position`,
      [tenant.id],
    );
  const modules = await tx.query<{ module_key: string; version: string; is_enabled: boolean }>(`select module_key, version, is_enabled from tenant_modules where tenant_id = $1`, [tenant.id]);
  const version = await tx.one<{ meta_version: number }>(`select meta_version from tenants where id = $1`, [tenant.id]);

  const objectMetas: ObjectMeta[] = objects.map((o) => {
    const std = isStandardObject(o.key) ? STANDARD_FIELDS[o.key] : CUSTOM_OBJECT_BASE_FIELDS;
    const custom: FieldDef[] = fields
      .filter((f) => f.object_key === o.key)
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.field_type,
        required: f.is_required,
        indexed: f.is_indexed,
        pii: f.is_pii,
        standard: false,
        options: f.options ?? {},
        helpText: f.help_text,
        position: f.position,
        moduleKey: f.module_key,
      }));
    return { key: o.key, label: o.label, plural: o.plural_label, icon: o.icon, isStandard: o.is_standard, moduleKey: o.module_key, fields: [...std, ...custom] };
  });

  const pipelines: PipelineMeta[] = pipes.map((p) => ({
    id: p.id,
    objectKey: p.object_key,
    name: p.name,
    isDefault: p.is_default,
    stages: stages.filter((s) => s.pipeline_id === p.id).map(({ pipeline_id: _p, ...s }) => s),
  }));

  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, metaVersion: version?.meta_version ?? tenant.metaVersion },
    objects: objectMetas,
    pipelines,
    modules: modules.map((m) => ({ key: m.module_key, version: m.version, enabled: m.is_enabled })),
  };
}

// ------------------------------------------------------------------------------------------------
// Principal (user + merged RBAC/ABAC permissions). Short TTL, never KV (write-quota friendly).
// ------------------------------------------------------------------------------------------------
export async function loadPrincipal(env: Env, tx: Tx, tenant: TenantInfo, meta: TenantMeta, userId: string, sessionId: string): Promise<Principal | null> {
  const cache = new EdgeCache(env);
  const key = `t:${tenant.id}:principal:${userId}:v${tenant.metaVersion}`;
  const cached = await cache.get<Omit<Principal, 'sessionId'>>(key);
  if (cached) return { ...cached, sessionId };

  const user = await tx.one<{ id: string; email: string; full_name: string; is_owner: boolean; status: string; attributes: Record<string, unknown> }>(
    `select id, email, full_name, is_owner, status, attributes from users where tenant_id = $1 and id = $2`,
    [tenant.id, userId],
  );
  if (!user) return null;
  const roles = await tx.query<{ key: string; permissions: unknown }>(
    `select r.key, r.permissions from user_roles ur join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where ur.tenant_id = $1 and ur.user_id = $2`,
    [tenant.id, userId],
  );
  const parsed: RolePermissions[] = roles.map((r) => {
    const p = rolePermissionsSchema.safeParse(r.permissions);
    return p.success ? p.data : {};
  });
  // the tenant owner can never be locked out of setup
  if (user.is_owner) parsed.push({ objects: { '*': { read: 'all', create: true, update: 'all', delete: 'all' } }, admin: ['*'] });

  const value: Omit<Principal, 'sessionId'> = {
    user: { id: user.id, email: user.email, fullName: user.full_name, isOwner: user.is_owner, status: user.status, attributes: user.attributes ?? {}, roles: roles.map((r) => r.key) },
    permissions: mergePermissions(parsed, meta.objects.map((o) => o.key).concat(['task', 'activity'])),
  };
  await cache.set(key, value, { ttlSeconds: 60 });
  return { ...value, sessionId };
}

export async function invalidatePrincipal(env: Env, tenant: TenantInfo, userId: string) {
  await new EdgeCache(env).delete(`t:${tenant.id}:principal:${userId}:v${tenant.metaVersion}`);
}
