import { mergePermissions } from '@synapse/shared';
import type { Principal } from '../env';

/** The principal background work runs as: full access inside one workspace (RLS still applies). */
export function systemPrincipal(userId: string | null, objectKeys: string[]): Principal {
  return {
    user: { id: userId ?? '00000000-0000-0000-0000-000000000000', email: 'system@synapse', fullName: 'Automation', isOwner: false, status: 'active', attributes: {}, roles: ['system'] },
    permissions: mergePermissions([{ objects: { '*': { read: 'all', create: true, update: 'all', delete: 'all' } }, admin: ['*'] }], objectKeys),
    sessionId: 'system',
  };
}
