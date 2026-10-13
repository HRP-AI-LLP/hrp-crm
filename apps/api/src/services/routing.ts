/**
 * Lead routing and scoring.
 *  - Assignment rules (first matching rule wins): round robin, load balanced (fewest open
 *    records) or a fixed user, over named users and/or a team. Disabled users are skipped.
 *  - Scoring rules: points per matching rule, clamped 0–100, banded hot / warm / cold.
 */
import { type AssignmentRuleMeta, matchCriteria, scoreRecord, storageFor } from '@synapse/shared';
import type { RecordCtx } from './records';

async function candidates(ctx: RecordCtx, rule: AssignmentRuleMeta): Promise<string[]> {
  const rows = await ctx.tx.query<{ id: string }>(
    `select u.id from users u
      where u.tenant_id = $1 and u.status = 'active'
        and (u.id = any($2::uuid[]) or ($3::uuid is not null and u.id in (select tm.user_id from team_members tm where tm.tenant_id = $1 and tm.team_id = $3::uuid)))
      order by u.id`,
    [ctx.tenantId, rule.userIds, rule.teamId],
  );
  return rows.map((r) => r.id);
}

async function openLoad(ctx: RecordCtx, objectKey: string, users: string[]): Promise<Map<string, number>> {
  const s = storageFor(objectKey);
  const open =
    objectKey === 'lead'
      ? `r.converted_at is null and coalesce((select st.category from pipeline_stages st where st.tenant_id = r.tenant_id and st.id = r.stage_id), 'open') = 'open'`
      : s.hasPipeline
        ? `coalesce((select st.category from pipeline_stages st where st.tenant_id = r.tenant_id and st.id = r.stage_id), 'open') = 'open'`
        : `r.created_at > now() - interval '30 days'`;
  const rows = await ctx.tx.query<{ owner_id: string; n: number }>(
    `select r.owner_id, count(*)::int n from ${s.table} r
      where r.tenant_id = $1 and r.deleted_at is null and r.owner_id = any($2::uuid[])${s.discriminated ? ' and r.object_key = $3' : ''} and ${open}
      group by r.owner_id`,
    s.discriminated ? [ctx.tenantId, users, objectKey] : [ctx.tenantId, users],
  );
  return new Map(rows.map((r) => [r.owner_id, r.n]));
}

/** Owner chosen by the first matching assignment rule, or null when no rule applies. */
export async function pickAssignee(ctx: RecordCtx, objectKey: string, values: Record<string, unknown>): Promise<{ userId: string; rule: string } | null> {
  const rules = (ctx.meta.automation?.assignment ?? []).filter((r) => r.objectKey === objectKey);
  for (const rule of rules) {
    if (!matchCriteria(rule.criteria, values)) continue;
    const users = await candidates(ctx, rule);
    if (!users.length) continue;
    if (rule.strategy === 'fixed') return { userId: users.includes(rule.userIds[0]!) ? rule.userIds[0]! : users[0]!, rule: rule.name };
    if (rule.strategy === 'load_balanced') {
      const load = await openLoad(ctx, objectKey, users);
      const best = [...users].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0]!;
      return { userId: best, rule: rule.name };
    }
    // round robin: an atomic counter per rule keeps concurrent assignments fair
    const r = await ctx.tx.one<{ position: number }>(
      `insert into assignment_cursors (tenant_id, rule_id, position) values ($1, $2, 1)
       on conflict (tenant_id, rule_id) do update set position = assignment_cursors.position + 1
       returning position`,
      [ctx.tenantId, rule.id],
    );
    return { userId: users[(r!.position - 1) % users.length]!, rule: rule.name };
  }
  return null;
}

export function hasAssignmentRules(ctx: RecordCtx, objectKey: string): boolean {
  return (ctx.meta.automation?.assignment ?? []).some((r) => r.objectKey === objectKey);
}

/** Score + rating for objects that carry them (leads), or null when no rules are defined. */
export function computeScore(ctx: RecordCtx, objectKey: string, values: Record<string, unknown>) {
  const sc = ctx.meta.automation?.scoring;
  if (!sc) return null;
  const rules = sc.rules.filter((r) => r.objectKey === objectKey);
  if (!rules.length) return null;
  return scoreRecord(rules, values, { hot: sc.hot, warm: sc.warm });
}

/** In-app notification for the new owner of a record (skipped when they assigned it themselves). */
export async function notifyOwner(ctx: RecordCtx, objectKey: string, recordId: string, ownerId: unknown, title: string, why?: string) {
  if (!ownerId || ownerId === ctx.principal.user.id) return;
  const label = ctx.meta.objects.find((o) => o.key === objectKey)?.label ?? objectKey;
  await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1, $2, 'assignment', $3, $4, $5)`, [
    ctx.tenantId,
    ownerId,
    `${label} assigned to you: ${title}`,
    why ?? (ctx.principal.sessionId === 'system' ? null : `By ${ctx.principal.user.fullName}`),
    `/o/${objectKey}/${recordId}`,
  ]);
}

/**
 * Routing for records created outside createRecord (inbound WhatsApp / Instagram messages):
 * applies assignment rules when the record has no fixed owner, and scoring rules.
 */
export async function routeInserted(ctx: RecordCtx, objectKey: string, id: string, assign: boolean) {
  const s = storageFor(objectKey);
  const row = await ctx.tx.one<Record<string, unknown>>(`select * from ${s.table} where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!row) return;
  const flat = { ...row, ...((row.custom as Record<string, unknown>) ?? {}) };
  const sets: string[] = [];
  const vals: unknown[] = [ctx.tenantId, id];
  let owner: string | null = null;
  let rule: string | null = null;
  if (assign) {
    const pick = await pickAssignee(ctx, objectKey, flat);
    if (pick && pick.userId !== row.owner_id) {
      vals.push(pick.userId);
      sets.push(`owner_id = $${vals.length}`);
      if (objectKey === 'lead') sets.push('assigned_at = now()');
      owner = pick.userId;
      rule = pick.rule;
    }
  }
  const sc = s.table === 'leads' ? computeScore(ctx, objectKey, flat) : null;
  if (sc) {
    vals.push(sc.score, sc.rating);
    sets.push(`score = $${vals.length - 1}`, `rating = $${vals.length}`);
  }
  if (sets.length) await ctx.tx.query(`update ${s.table} set ${sets.join(', ')} where tenant_id = $1 and id = $2`, vals);
  if (owner) await notifyOwner(ctx, objectKey, id, owner, String(row[s.titleColumn] ?? ''), `Assignment rule: ${rule}`);
}
