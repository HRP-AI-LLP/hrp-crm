/**
 * HRP AI: the coding agent as an assignee. Every workspace has one (a profile without sign-in, seat
 * or mail). Work assigned to it goes to the coding agent's queue (the database trigger
 * app.queue_agent_job), and it is the default assignee of new work items unless a project says
 * otherwise (projects.default_assignee).
 */
import type { Tx } from '../lib/db';

export const AGENT_NAME = 'HRP AI';
const EMAIL = 'hrp-ai@agent.sanchalanos.invalid';

/** The workspace's HRP AI user (made the first time it is needed). */
export async function agentUserId(tx: Tx, tenantId: string): Promise<string> {
  const found = await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_agent`, [tenantId]);
  if (found) return found.id;
  const made = await tx.one<{ id: string }>(
    `insert into users (tenant_id, email, full_name, status, is_agent) values ($1, $2, $3, 'profile', true)
     on conflict do nothing returning id`,
    [tenantId, EMAIL, AGENT_NAME],
  );
  return made?.id ?? (await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_agent`, [tenantId]))!.id;
}

/** Who a new work item goes to when nobody was chosen: HRP AI, a person, or nobody. */
export async function defaultAssignee(tx: Tx, tenantId: string, project: { default_assignee?: string | null }): Promise<string | null> {
  const d = project.default_assignee ?? 'agent';
  if (d === 'none') return null;
  if (d === 'agent') return agentUserId(tx, tenantId);
  const ok = await tx.one(`select 1 from users where tenant_id = $1 and id = $2 and status <> 'disabled'`, [tenantId, d]);
  return ok ? d : null;
}
