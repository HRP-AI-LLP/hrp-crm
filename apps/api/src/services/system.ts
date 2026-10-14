import { mergePermissions } from '@synapse/shared';
import type { Principal } from '../env';
import type { Env, TenantInfo } from '../env';
import type { Tx } from '../lib/db';
import type { RecordCtx } from './records';
import { loadMeta, loadPrincipal } from './tenancy';
/** The principal background work runs as: full access inside one workspace (RLS still applies). */
export function systemPrincipal(userId: string | null, objectKeys: string[]): Principal {
  return {
    user: { id: userId ?? '00000000-0000-0000-0000-000000000000', email: 'system@synapse', fullName: 'Automation', isOwner: false, status: 'active', attributes: {}, roles: ['system'] },
    permissions: mergePermissions([{ objects: { '*': { read: 'all', create: true, update: 'all', delete: 'all' } }, admin: ['*'] }], objectKeys),
    sessionId: 'system',
  };
}


/** Acting as a real person outside a request (mailbox sync, OAuth callbacks): their own permissions. */
export async function actAs(env: Env, tx: Tx, tenantId: string, userId: string, sessionId: string): Promise<RecordCtx | null> {
  const t = await tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select id, slug, name, status, meta_version from tenants where id = $1`, [tenantId]);
  if (!t) return null;
  const tenant: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status, metaVersion: t.meta_version };
  const meta = await loadMeta(env, tx, tenant);
  const principal = await loadPrincipal(env, tx, tenant, meta, userId, sessionId);
  if (!principal || principal.user.status !== 'active') return null;
  return { tx, meta, principal, tenantId };
}
