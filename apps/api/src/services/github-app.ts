/**
 * The Synapse GitHub App: an admin installs it on their GitHub organisation or account, then
 *   - repositories are picked from a list when linking them to projects,
 *   - every push and pull request gets a "Synapse work items" check run (pass / fail per the
 *     repository's code policy) — require it in branch protection and unlinked code cannot merge;
 *     Synapse can switch that protection on itself,
 *   - a branch can be created from a work item, named after its key.
 * One app for the whole platform (GITHUB_APP_* settings); its webhook goes to /api/public/github/app
 * and each installation is routed to the workspace that installed it.
 */
import forge from 'node-forge';
import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Db, Tx } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { signState, verifyState, type OAuthProvider } from './integrations';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';

const API = 'https://api.github.com';
export const CHECK_NAME = 'Synapse work items';

export function appConfigured(env: Env) {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_WEBHOOK_SECRET);
}

const b64url = (s: string) => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let jwtCache: { jwt: string; exp: number; for: string } | null = null;
const tokenCache = new Map<string, { token: string; exp: number }>();

/** The app's own JWT (RS256, 9 minutes), signed with its private key. */
export function appJwt(env: Env): string {
  // keyed by the app id and key, so new keys set in Settings → Connection keys take effect at once
  const forKey = `${env.GITHUB_APP_ID}:${String(env.GITHUB_APP_PRIVATE_KEY ?? '').length}:${String(env.GITHUB_APP_PRIVATE_KEY ?? '').slice(-24)}`;
  if (jwtCache && jwtCache.for === forKey && jwtCache.exp - Date.now() > 60_000) return jwtCache.jwt;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID }));
  const key = forge.pki.privateKeyFromPem(String(env.GITHUB_APP_PRIVATE_KEY).replace(/\\n/g, '\n')) as forge.pki.rsa.PrivateKey;
  const md = forge.md.sha256.create();
  md.update(`${head}.${body}`, 'utf8');
  const sig = b64url(key.sign(md));
  jwtCache = { jwt: `${head}.${body}.${sig}`, exp: (now + 540) * 1000, for: forKey };
  return jwtCache.jwt;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function gh<T>(token: string, path: string, init: RequestInit & { auth?: 'Bearer' | 'token' } = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hrp-synapse', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new GitHubError(json?.message ? `GitHub: ${json.message}` : `GitHub HTTP ${res.status}`, res.status);
  return json as T;
}

/** An installation access token (an hour; cached for 50 minutes). */
export async function installationToken(env: Env, installationId: number | string): Promise<string> {
  const id = String(installationId);
  // per app as well: a new GitHub App set in Settings → Connection keys gets new tokens
  const k = `${env.GITHUB_APP_ID}:${id}`;
  const c = tokenCache.get(k);
  if (c && c.exp - Date.now() > 600_000) return c.token;
  const r = await gh<{ token: string; expires_at: string }>(appJwt(env), `/app/installations/${id}/access_tokens`, { method: 'POST' });
  tokenCache.set(k, { token: r.token, exp: Date.parse(r.expires_at) });
  return r.token;
}

const routeKey = (installationId: number | string) => `ghapp-${String(installationId).padStart(12, '0')}`;

/* ───────────────────────── installing ───────────────────────── */

export async function installUrl(env: Env, ctx: RecordCtx, origin: string) {
  if (!appConfigured(env)) throw badRequest('The GitHub App is not set up on this server (GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET)');
  const state = await signState(env, { t: ctx.tenantId, u: ctx.principal.user.id, p: 'github' as OAuthProvider, o: origin, r: '/projects', h: '' });
  return { url: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}` };
}

/** GitHub's "Setup URL" after installing: ties the installation to the workspace that started it. */
export async function completeInstall(env: Env, db: Db, installationId: string, state: string | undefined) {
  const s = await verifyState(env, state);
  if (!/^\d{1,15}$/.test(installationId)) throw badRequest('Bad installation');
  const inst = await gh<{ id: number; account: { login: string; type: string } }>(appJwt(env), `/app/installations/${installationId}`);
  await db.tx({ tenantId: s.t, userId: s.u }, async (tx) => {
    const other = await tx.one(`select 1 from github_installations where installation_id = $1`, [inst.id]);
    if (!other) {
      try {
        await tx.query(`insert into github_installations (tenant_id, installation_id, account, account_type, public_token, installed_by) values ($1,$2,$3,$4,$5,$6)`, [
          s.t, inst.id, inst.account.login, inst.account.type, routeKey(inst.id), s.u,
        ]);
      } catch {
        throw badRequest('This GitHub installation is already connected to another Synapse workspace');
      }
    } else await tx.query(`update github_installations set suspended_at = null, account = $3 where tenant_id = $1 and installation_id = $2`, [s.t, inst.id, inst.account.login]);
  });
  return { origin: s.o, account: inst.account.login };
}

export async function listInstallations(ctx: RecordCtx, env: Env) {
  const rows = await ctx.tx.query<{ id: string; installation_id: string; account: string; account_type: string | null; suspended_at: string | null; created_at: string }>(
    `select id, installation_id::text, account, account_type, suspended_at, created_at from github_installations where tenant_id = $1 order by created_at`,
    [ctx.tenantId],
  );
  return { configured: appConfigured(env), slug: env.GITHUB_APP_SLUG ?? null, installations: rows };
}

export async function removeInstallation(ctx: RecordCtx, id: string) {
  const r = await ctx.tx.one<{ installation_id: string }>(`delete from github_installations where tenant_id = $1 and id = $2 returning installation_id::text`, [ctx.tenantId, id]);
  if (!r) throw notFound('Installation not found');
  await ctx.tx.query(`update project_repos set installation_id = null where tenant_id = $1 and installation_id = $2`, [ctx.tenantId, r.installation_id]);
  return { ok: true, note: 'Uninstall the app in GitHub too (Settings → Applications) to revoke its access.' };
}

/** Repositories the workspace's installations can reach, with the project each is linked to. */
export async function listAppRepos(ctx: RecordCtx, env: Env) {
  const inst = await ctx.tx.query<{ installation_id: string; account: string }>(`select installation_id::text, account from github_installations where tenant_id = $1 and suspended_at is null`, [ctx.tenantId]);
  const linked = await ctx.tx.query<{ repo: string; project_id: string; name: string }>(`select r.repo, r.project_id, p.name from project_repos r join projects p on p.tenant_id = r.tenant_id and p.id = r.project_id where r.tenant_id = $1 and r.provider = 'github'`, [ctx.tenantId]);
  const out: { fullName: string; private: boolean; defaultBranch: string; installationId: string; account: string; linkedTo: { projectId: string; name: string } | null }[] = [];
  for (const i of inst) {
    const token = await installationToken(env, i.installation_id);
    for (let page = 1; page <= 5; page++) {
      const r = await gh<{ repositories: { full_name: string; private: boolean; default_branch: string; archived: boolean }[]; total_count: number }>(token, `/installation/repositories?per_page=100&page=${page}`);
      for (const x of r.repositories.filter((y) => !y.archived)) {
        const l = linked.find((k) => k.repo === x.full_name.toLowerCase());
        out.push({ fullName: x.full_name, private: x.private, defaultBranch: x.default_branch, installationId: i.installation_id, account: i.account, linkedTo: l ? { projectId: l.project_id, name: l.name } : null });
      }
      if (r.repositories.length < 100) break;
    }
  }
  return out;
}

/* ───────────────────────── checks on code ───────────────────────── */

type CheckRef = { sha: string; title: string; summary: string; conclusion: 'success' | 'failure' | 'neutral'; detailsUrl: string | null };

export async function postCheck(env: Env, installationId: string | number, repo: string, c: CheckRef) {
  const token = await installationToken(env, installationId);
  await gh(token, `/repos/${repo}/check-runs`, {
    method: 'POST',
    body: JSON.stringify({
      name: CHECK_NAME, head_sha: c.sha, status: 'completed', conclusion: c.conclusion, completed_at: new Date().toISOString(), ...(c.detailsUrl ? { details_url: c.detailsUrl } : {}),
      output: { title: c.title.slice(0, 250), summary: c.summary.slice(0, 60000) },
    }),
  });
}

/** After a push / pull request was processed: the check run for its head commit, from the recorded results. */
export async function checksFor(tx: Tx, tenantId: string, event: string, body: any, origin: string): Promise<{ installationId: string; repo: string; check: CheckRef } | null> {
  const fullName = String(body.repository?.full_name ?? '').toLowerCase();
  const repo = await tx.one<{ id: string; project_id: string; policy: string; installation_id: string | null }>(`select id, project_id, policy, installation_id::text from project_repos where tenant_id = $1 and provider = 'github' and repo = $2`, [tenantId, fullName]);
  if (!repo || repo.policy === 'off') return null;
  const installationId = String(body.installation?.id ?? repo.installation_id ?? '');
  if (!installationId) return null;
  let sha = '';
  let ids: string[] = [];
  if (event === 'push') {
    if (body.deleted || !body.after || /^0+$/.test(body.after)) return null;
    sha = body.after;
    ids = (body.commits ?? []).map((c: any) => `gh:commit:${String(c.id).toLowerCase()}`);
  } else if (event === 'pull_request') {
    if (!['opened', 'edited', 'reopened', 'synchronize', 'ready_for_review'].includes(body.action)) return null;
    sha = body.pull_request?.head?.sha;
    ids = [`gh:pr:${fullName}#${body.pull_request?.number}`];
  } else return null;
  if (!sha || !ids.length) return null;
  const ev = await tx.query<{ external_id: string; title: string | null; status: string; item_ids: string[]; cr_ids: string[] }>(`select external_id, title, status, item_ids, cr_ids from pm_code_events where tenant_id = $1 and repo_id = $2 and external_id = any($3::text[])`, [tenantId, repo.id, ids]);
  const keys = await tx.query<{ id: string; k: string }>(
    `select t.id, p.work_key || '-' || t.task_number as k from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and t.id = any($2::uuid[])
     union all select c.id, p.work_key || '-CR-' || c.cr_number from change_requests c join projects p on p.tenant_id = c.tenant_id and p.id = c.project_id where c.tenant_id = $1 and c.id = any($2::uuid[])`,
    [tenantId, ev.flatMap((e) => [...e.item_ids, ...e.cr_ids])],
  );
  const name = new Map(keys.map((k) => [k.id, k.k]));
  const missing = ev.filter((e) => e.status === 'missing');
  const counted = ev.filter((e) => e.status !== 'skipped');
  if (!counted.length) return null;
  const lines = counted.map((e) => `- ${e.status === 'missing' ? '❌' : e.status === 'created' ? '🆕' : '✅'} ${e.title ?? e.external_id}${[...e.item_ids, ...e.cr_ids].length ? ` → ${[...e.item_ids, ...e.cr_ids].map((i) => name.get(i) ?? '').filter(Boolean).join(', ')}` : ''}`);
  const fail = repo.policy === 'enforce' && missing.length > 0;
  return {
    installationId,
    repo: fullName,
    check: {
      sha,
      conclusion: fail ? 'failure' : missing.length ? 'neutral' : 'success',
      title: fail ? `${missing.length} without a Synapse work item` : missing.length ? `${missing.length} without a work item (recorded)` : 'Linked to Synapse work items',
      summary: [
        ...lines,
        '',
        fail ? 'Name a work item in the commit message or PR title (e.g. `FLEET-12 …` or `FLEET-CR-3 …`), or use a branch like `feature/FLEET-12-…`, then push again.' : '',
      ].join('\n'),
      detailsUrl: `${origin}/projects/${repo.project_id}?s_project=worksetup`,
    },
  };
}

/* ───────────────────────── webhook ───────────────────────── */

export async function verifyAppHook(env: Env, sig: string | undefined, raw: string) {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return false;
  return !!sig && sig.startsWith('sha256=') && timingSafeEqual(sig.slice(7), await hmacSha256Hex(env.GITHUB_APP_WEBHOOK_SECRET, raw));
}
export const appRouteKey = routeKey;

/* ───────────────────────── branch protection & branches ───────────────────────── */

async function repoWithApp(ctx: RecordCtx, projectId: string, repoId: string) {
  const r = await ctx.tx.one<{ repo: string; default_branch: string; installation_id: string | null }>(`select repo, default_branch, installation_id::text from project_repos where tenant_id = $1 and id = $2 and project_id = $3 and provider = 'github'`, [ctx.tenantId, repoId, projectId]);
  if (!r) throw notFound('Repository not found');
  if (!r.installation_id) throw badRequest('Link this repository through the GitHub App first (Work setup → Code repositories → pick from GitHub)');
  return r as { repo: string; default_branch: string; installation_id: string };
}

/** Makes the "Synapse work items" check required on the main branch. */
export async function requireCheck(ctx: RecordCtx, env: Env, projectId: string, repoId: string) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await repoWithApp(ctx, projectId, repoId);
  const token = await installationToken(env, r.installation_id);
  const branch = encodeURIComponent(r.default_branch);
  const appId = Number(env.GITHUB_APP_ID);
  let cur: { required_status_checks?: { strict: boolean; checks: { context: string; app_id: number | null }[] } } | null = null;
  try {
    cur = await gh(token, `/repos/${r.repo}/branches/${branch}/protection`);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 404) throw (e as GitHubError).status === 403 ? badRequest(`${(e as Error).message} — the app needs “Administration: write” on the repository`) : e;
  }
  const add = { context: CHECK_NAME, app_id: appId };
  try {
    if (!cur) {
      // no rule yet: one with just the required check
      await gh(token, `/repos/${r.repo}/branches/${branch}/protection`, { method: 'PUT', body: JSON.stringify({ required_status_checks: { strict: false, checks: [add] }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null }) });
    } else if (cur.required_status_checks) {
      if (cur.required_status_checks.checks.some((c) => c.context === CHECK_NAME)) return { ok: true, already: true };
      await gh(token, `/repos/${r.repo}/branches/${branch}/protection/required_status_checks`, { method: 'PATCH', body: JSON.stringify({ strict: cur.required_status_checks.strict, checks: [...cur.required_status_checks.checks, add] }) });
    } else {
      // a rule with other settings and no status checks: Synapse does not rewrite it
      throw badRequest(`${r.default_branch} already has a protection rule without status checks — add “${CHECK_NAME}” as a required check in GitHub (Settings → Branches)`);
    }
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) throw badRequest(`${e.message} — the app needs “Administration: write” on the repository`);
    throw e;
  }
  return { ok: true, already: false };
}

/** Creates a branch for a work item from the main branch's latest commit. */
export async function createBranch(ctx: RecordCtx, env: Env, projectId: string, taskId: string, repoId: string, name: string) {
  await projectAccess(ctx, projectId, 'member');
  if (!/^[A-Za-z0-9._/-]{3,200}$/.test(name) || name.includes('..')) throw badRequest('Not a valid branch name');
  const t = await ctx.tx.one<{ task_number: number }>(`select task_number from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, taskId, projectId]);
  if (!t) throw notFound('Work item not found');
  const r = await repoWithApp(ctx, projectId, repoId);
  const token = await installationToken(env, r.installation_id);
  const head = await gh<{ object: { sha: string } }>(token, `/repos/${r.repo}/git/ref/heads/${encodeURIComponent(r.default_branch)}`);
  try {
    await gh(token, `/repos/${r.repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${name}`, sha: head.object.sha }) });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) throw badRequest(`A branch ${name} already exists in ${r.repo}`);
    throw e;
  }
  const url = `https://github.com/${r.repo}/tree/${name}`;
  await ctx.tx.query(
    `insert into project_task_links (tenant_id, task_id, kind, url, title, status, source, external_id, author, repo, occurred_at, created_by)
     values ($1,$2,'branch',$3,$4,'open','github',$5,$6,$7,now(),$8) on conflict (tenant_id, task_id, external_id) where external_id is not null do nothing`,
    [ctx.tenantId, taskId, url, name, `gh:branch:${r.repo}:${name}`, ctx.principal.user.fullName ?? null, r.repo, ctx.principal.user.id],
  );
  return { url, branch: name, repo: r.repo };
}
