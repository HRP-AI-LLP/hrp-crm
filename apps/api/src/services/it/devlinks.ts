/**
 * Code links: GitHub and Azure Repos / Pipelines send webhooks; any work item key (FLEET-12) in a
 * branch name, commit message, pull request title or body links that branch / commit / PR / build to
 * the item, and the project's automation can move the item (branch created → In progress, PR merged
 * → Done, build failed → Blocked …).
 *
 * GitHub: a repository or organisation webhook (JSON) with the shared secret (X-Hub-Signature-256),
 * events push, create, pull_request, workflow_run. Azure DevOps: service hooks (Web Hooks) with basic
 * authentication (user "synapse", the secret as password), events git.push, git.pullrequest.created /
 * updated / merged, build.complete.
 */
import type { Env } from '../../env';
import { hmacSha256Hex, randomToken, timingSafeEqual } from '../../lib/crypto';
import type { Db, Tx } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { type Integration, readSecret, sealSecret } from '../integrations';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { pickWorkflow, projectWorkflows } from '../work-types';
import { normRepo, processCode, type Repo } from './codepolicy';
import { transition, type WorkSettings } from './work';

export type DevProvider = 'github' | 'azure_repos';

export async function listDevConnections(ctx: RecordCtx, base: string) {
  const rows = await ctx.tx.query<Integration>(`select * from integrations where tenant_id = $1 and provider in ('github','azure_repos') order by created_at`, [ctx.tenantId]);
  return rows.map((i) => ({
    id: i.id, provider: i.provider, label: i.label, status: i.status, lastEventAt: i.last_event_at, lastError: i.last_error,
    webhookUrl: `${base}/api/public/hooks/dev/${i.route_key}`, username: i.provider === 'azure_repos' ? 'synapse' : null,
  }));
}

export async function createDevConnection(ctx: RecordCtx, env: Env, base: string, input: { provider: DevProvider; label: string }) {
  const secret = randomToken(24);
  const i = await ctx.tx.one<Integration>(
    `insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config, created_by) values ($1,$2,$3,$4,$5,'{}',$6) returning *`,
    [ctx.tenantId, input.provider, input.label.slice(0, 120), `${input.provider}-${randomToken(6)}`, await sealSecret(env, ctx.tenantId, { secret }), ctx.principal.user.id],
  );
  return { id: i!.id, webhookUrl: `${base}/api/public/hooks/dev/${i!.route_key}`, secret, username: input.provider === 'azure_repos' ? 'synapse' : null };
}

export async function deleteDevConnection(ctx: RecordCtx, id: string) {
  const r = await ctx.tx.one(`delete from integrations where tenant_id = $1 and id = $2 and provider in ('github','azure_repos') returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound('Connection not found');
  return { ok: true };
}

/* ───────────────────────── webhooks ───────────────────────── */

export interface DevEvent {
  kind: 'branch' | 'commit' | 'pr' | 'build';
  externalId: string;
  url: string;
  title: string;
  status: 'open' | 'merged' | 'closed' | 'draft' | 'running' | 'succeeded' | 'failed' | null;
  author: string | null;
  repo: string | null;
  at: string | null;
  texts: string[];
  auto: 'branch' | 'prOpened' | 'prMerged' | 'buildFailed' | null;
  message?: string;
  authorEmail?: string | null;
  branch?: string | null;
}

export async function verifyDevHook(env: Env, i: Integration, headers: (n: string) => string | undefined, raw: string) {
  const { secret } = await readSecret<{ secret: string }>(env, i);
  if (i.provider === 'github') {
    const sig = headers('x-hub-signature-256') ?? '';
    return sig.startsWith('sha256=') && timingSafeEqual(sig.slice(7), await hmacSha256Hex(secret, raw));
  }
  const auth = headers('authorization') ?? '';
  if (!auth.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return false;
  }
  return timingSafeEqual(decoded, `synapse:${secret}`);
}

const short = (s: string | null | undefined, n = 300) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const refName = (r: string) => r.replace(/^refs\/heads\//, '');

/** GitHub payloads → events. */
export function githubEvents(event: string, b: any): DevEvent[] {
  const repo = b.repository?.full_name ?? null;
  const out: DevEvent[] = [];
  if (event === 'push') {
    const branch = refName(b.ref ?? '');
    for (const c of (b.commits ?? []).slice(0, 50))
      out.push({ kind: 'commit', externalId: `gh:commit:${String(c.id).toLowerCase()}`, url: c.url, title: short(c.message?.split('\n')[0], 300), status: null, author: c.author?.name ?? c.author?.username ?? null, repo, at: c.timestamp ?? null, texts: [c.message ?? '', branch], auto: null, message: c.message ?? '', authorEmail: c.author?.email ?? null, branch });
    if (b.created && branch) out.push({ kind: 'branch', externalId: `gh:branch:${repo}:${branch}`, url: `${b.repository?.html_url}/tree/${branch}`, title: branch, status: 'open', author: b.sender?.login ?? null, repo, at: null, texts: [branch], auto: 'branch' });
  } else if (event === 'create' && b.ref_type === 'branch') {
    out.push({ kind: 'branch', externalId: `gh:branch:${repo}:${b.ref}`, url: `${b.repository?.html_url}/tree/${b.ref}`, title: b.ref, status: 'open', author: b.sender?.login ?? null, repo, at: null, texts: [b.ref], auto: 'branch' });
  } else if (event === 'pull_request') {
    const pr = b.pull_request ?? {};
    const merged = !!pr.merged;
    const status = merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
    const auto = b.action === 'closed' && merged ? 'prMerged' : ['opened', 'reopened', 'ready_for_review'].includes(b.action) && !pr.draft ? 'prOpened' : null;
    out.push({ kind: 'pr', externalId: `gh:pr:${String(repo).toLowerCase()}#${pr.number}`, url: pr.html_url, title: short(`#${pr.number} ${pr.title}`), status, author: pr.user?.login ?? null, repo, at: pr.updated_at ?? null, texts: [pr.title ?? '', pr.body ?? '', pr.head?.ref ?? ''], auto, message: `${pr.title ?? ''}\n${pr.body ?? ''}`, branch: pr.head?.ref ?? null });
  } else if (event === 'workflow_run') {
    const r = b.workflow_run ?? {};
    const status = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'succeeded' : r.conclusion === 'failure' || r.conclusion === 'timed_out' ? 'failed' : null;
    out.push({ kind: 'build', externalId: `gh:run:${r.id}`, url: r.html_url, title: short(`${r.name ?? 'Workflow'} #${r.run_number} on ${r.head_branch}`), status, author: r.actor?.login ?? null, repo, at: r.updated_at ?? null, texts: [r.head_branch ?? '', r.head_commit?.message ?? '', r.display_title ?? ''], auto: status === 'failed' ? 'buildFailed' : null });
  }
  return out;
}

/** Azure DevOps service-hook payloads → events. */
export function azureEvents(b: any): DevEvent[] {
  const type = String(b.eventType ?? '');
  const r = b.resource ?? {};
  const repo = r.repository?.project?.name && r.repository?.name ? `${r.repository.project.name}/${r.repository.name}` : (r.repository?.name ?? r.repository?.id ?? null);
  const out: DevEvent[] = [];
  if (type === 'git.push') {
    const branch = refName(r.refUpdates?.[0]?.name ?? '');
    for (const c of (r.commits ?? []).slice(0, 50))
      out.push({ kind: 'commit', externalId: `az:commit:${String(c.commitId).toLowerCase()}`, url: c.remoteUrl ?? c.url, title: short(c.comment?.split('\n')[0]), status: null, author: c.author?.name ?? null, repo, at: c.author?.date ?? null, texts: [c.comment ?? '', branch], auto: null, message: c.comment ?? '', authorEmail: c.author?.email ?? null, branch });
    const created = r.refUpdates?.find((u: any) => /^0+$/.test(u.oldObjectId ?? ''));
    if (created) {
      const name = refName(created.name);
      out.push({ kind: 'branch', externalId: `az:branch:${repo}:${name}`, url: `${r.repository?.remoteUrl ?? ''}?version=GB${encodeURIComponent(name)}`, title: name, status: 'open', author: r.pushedBy?.displayName ?? null, repo, at: r.date ?? null, texts: [name], auto: 'branch' });
    }
  } else if (type.startsWith('git.pullrequest.')) {
    const status = r.status === 'completed' ? 'merged' : r.status === 'abandoned' ? 'closed' : r.isDraft ? 'draft' : 'open';
    const auto = status === 'merged' ? 'prMerged' : type === 'git.pullrequest.created' && status === 'open' ? 'prOpened' : null;
    const web = r._links?.web?.href ?? `${r.repository?.webUrl ?? ''}/pullrequest/${r.pullRequestId}`;
    out.push({ kind: 'pr', externalId: `az:pr:${String(repo).toLowerCase()}#${r.pullRequestId}`, url: web, title: short(`!${r.pullRequestId} ${r.title}`), status, author: r.createdBy?.displayName ?? null, repo, at: r.closedDate ?? r.creationDate ?? null, texts: [r.title ?? '', r.description ?? '', refName(r.sourceRefName ?? '')], auto, message: `${r.title ?? ''}\n${r.description ?? ''}`, authorEmail: r.createdBy?.uniqueName ?? null, branch: refName(r.sourceRefName ?? '') });
  } else if (type === 'build.complete' || type === 'ms.vss-pipelines.run-state-changed-event') {
    const result = r.result ?? r.run?.result;
    const status = result === 'succeeded' ? 'succeeded' : result === 'failed' || result === 'partiallySucceeded' ? 'failed' : result ? null : 'running';
    const branch = refName(r.sourceBranch ?? r.run?.resources?.repositories?.self?.refName ?? '');
    out.push({ kind: 'build', externalId: `az:build:${r.id ?? r.run?.id}`, url: r._links?.web?.href ?? r.url ?? '', title: short(`${r.definition?.name ?? r.pipeline?.name ?? 'Pipeline'} ${r.buildNumber ?? r.run?.name ?? ''} on ${branch}`), status, author: r.requestedFor?.displayName ?? null, repo, at: r.finishTime ?? null, texts: [branch, r.sourceVersionMessage ?? '', b.message?.text ?? ''], auto: status === 'failed' ? 'buildFailed' : null });
  }
  return out;
}

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
export function keysIn(texts: string[]): { key: string; number: number }[] {
  const out = new Map<string, { key: string; number: number }>();
  for (const t of texts) for (const m of String(t).toUpperCase().matchAll(KEY_RE)) out.set(`${m[1]}-${m[2]}`, { key: m[1]!, number: Number(m[2]) });
  return [...out.values()].slice(0, 20);
}

/** Links each event to the items it mentions and runs the project's automation. */
export async function applyDevEvents(env: Env, tx: Tx, tenantId: string, provider: DevProvider, events: DevEvent[]) {
  const ctx = await systemCtxFor(env, tx, tenantId);
  if (!ctx) return { linked: 0 };
  let linked = 0;
  for (const e of events) {
    if (!e.url || !/^https?:\/\//.test(e.url)) continue;
    // a repository linked to a project: its code policy decides (link, record, or create an item)
    let keys = keysIn(e.texts);
    const repo = (e.kind === 'commit' || e.kind === 'pr') && e.repo ? await tx.one<Repo>(`select * from project_repos where tenant_id = $1 and provider = $2 and repo = $3`, [tenantId, provider, normRepo(e.repo)]) : null;
    if (repo && repo.policy !== 'off') {
      const r = await processCode(env, tx, repo, {
        kind: e.kind as 'commit' | 'pr', externalId: e.externalId, title: e.title, message: e.message ?? e.title, texts: e.texts, author: e.author, authorEmail: e.authorEmail ?? null, url: e.url, branch: e.branch ?? null, at: e.at, status: e.status,
      }, 'webhook');
      linked += r.keys.length;
      keys = r.keys.filter((k) => !/-CR-/.test(k)).map((k) => ({ key: k.split('-')[0]!, number: Number(k.split('-')[1]) }));
      if (!e.auto) continue;
      for (const k of keys) await autoMove(ctx, tx, tenantId, k, e.auto);
      continue;
    }
    for (const k of keys) {
      const t = await tx.one<{ id: string; project_id: string; status: string; work_type: string; work_settings: WorkSettings }>(
        `select t.id, t.project_id, t.status, t.work_type, p.work_settings from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
          where t.tenant_id = $1 and p.work_key = $2 and t.task_number = $3 and p.deleted_at is null`,
        [tenantId, k.key, k.number],
      );
      if (!t) continue;
      await tx.query(
        `insert into project_task_links (tenant_id, task_id, kind, url, title, status, source, external_id, author, repo, occurred_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, now()), null)
         on conflict (tenant_id, task_id, external_id) where external_id is not null
         do update set status = coalesce(excluded.status, project_task_links.status), title = excluded.title, url = excluded.url, occurred_at = excluded.occurred_at`,
        [tenantId, t.id, e.kind, e.url.slice(0, 1000), e.title.slice(0, 300) || null, e.status, provider === 'github' ? 'github' : 'azure', e.externalId.slice(0, 300), e.author?.slice(0, 200) ?? null, e.repo?.slice(0, 200) ?? null, e.at],
      );
      linked++;
      if (e.auto) await autoMove(ctx, tx, tenantId, k, e.auto);
    }
  }
  return { linked };
}

/** The project's automation: move the item named by key when its code reaches a stage. */
async function autoMove(ctx: RecordCtx, tx: Tx, tenantId: string, k: { key: string; number: number }, stage: NonNullable<DevEvent['auto']>) {
  const t = await tx.one<{ id: string; project_id: string; status: string; work_type: string; work_settings: WorkSettings }>(
    `select t.id, t.project_id, t.status, t.work_type, p.work_settings from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
      where t.tenant_id = $1 and p.work_key = $2 and t.task_number = $3 and p.deleted_at is null`,
    [tenantId, k.key, k.number],
  );
  const to = t?.work_settings?.autoTransitions?.[stage];
  if (!t || !to || t.status === 'done' || t.status === 'cancelled') return;
  const wf = pickWorkflow(await projectWorkflows(tx, tenantId, t.project_id), t.work_type);
  if (!wf.states.some((s) => s.key === to)) return;
  await tx.query('savepoint dev_move');
  try {
    await transition(ctx, t.project_id, t.id, { to }, { system: true });
    await tx.query('release savepoint dev_move');
  } catch {
    // the workflow may not allow that move from where the item is: the link still stands
    await tx.query('rollback to savepoint dev_move');
  }
}

export async function handleDevHook(env: Env, db: Db, tenantId: string, integrationId: string, headers: (n: string) => string | undefined, raw: string) {
  const i = await db.tx({ tenantId, readOnly: true }, (tx) => tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider in ('github','azure_repos') and status <> 'disabled'`, [tenantId, integrationId]));
  if (!i) throw notFound();
  if (!(await verifyDevHook(env, i, headers, raw))) return { ok: false, status: 401 as const };
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw badRequest('Not JSON');
  }
  const provider = i.provider as DevProvider;
  if (provider === 'github' && headers('x-github-event') === 'ping') return { ok: true, status: 200 as const, linked: 0 };
  const events = provider === 'github' ? githubEvents(headers('x-github-event') ?? '', body) : azureEvents(body);
  const r = await db.tx({ tenantId }, async (tx) => {
    const out = await applyDevEvents(env, tx, tenantId, provider, events);
    await tx.query(`update integrations set last_event_at = now(), status = 'active', last_error = null, error_count = 0 where tenant_id = $1 and id = $2`, [tenantId, i.id]);
    return out;
  });
  return { ok: true, status: 200 as const, linked: r.linked };
}
