/**
 * Connectors to the tools teams already use:
 *  - Chat alerts: Microsoft Teams (Workflows / incoming webhook), Slack and Google Chat webhooks get a
 *    short card when a deal is won or lost, a big deal opens, an urgent ticket arrives, an order is
 *    confirmed or a payment comes in.
 *  - Work trackers: a project is linked to a Jira project, an Azure DevOps project or an Asana
 *    project; tasks are pushed there as issues and their status pulled back.
 *  - SharePoint: a file on any record is copied into a SharePoint document library folder (app-only
 *    Microsoft Graph credentials).
 *  - ERPs: Microsoft Dynamics 365 Business Central, SAP Business One (Service Layer) and Oracle
 *    NetSuite (token-based auth): products and customers are pulled in, confirmed orders pushed out.
 * Credentials are sealed with the workspace key; only the label and settings are ever shown.
 */
import { hasAdmin } from '@synapse/shared';
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { openFile } from '../files';
import { claimRef, type Integration, markError, markOk, providerFetch, readSecret, refOf, sealSecret } from '../integrations';
import type { RecordCtx, RecordEvent } from '../records';

export const CHAT = ['teams', 'slack', 'gchat'] as const;
export const TRACKERS = ['jira', 'azure_devops', 'asana'] as const;
export const ERPS = ['dynamics_bc', 'sap_b1', 'netsuite'] as const;
export const CONNECTORS = [...CHAT, ...TRACKERS, ...ERPS, 'sharepoint'] as const;
export type Connector = (typeof CONNECTORS)[number];
export const ALERTS = ['deal_won', 'deal_lost', 'big_deal', 'urgent_ticket', 'order_confirmed', 'payment_received'] as const;

export function assertConnectorAdmin(ctx: RecordCtx) {
  if (!hasAdmin(ctx.principal.permissions, 'developers')) throw forbidden('Connectors need the "Developers & connectors" permission');
}

/** What each connector needs (shown as a form; secret fields are never sent back). */
export const FIELDS: Record<Connector, { key: string; label: string; secret?: boolean; placeholder?: string }[]> = {
  teams: [{ key: 'url', label: 'Webhook URL (Teams Workflows: "Post to a channel when a webhook request is received")', secret: true }],
  slack: [{ key: 'url', label: 'Incoming webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/…' }],
  gchat: [{ key: 'url', label: 'Space webhook URL', secret: true, placeholder: 'https://chat.googleapis.com/v1/spaces/…' }],
  jira: [
    { key: 'site', label: 'Jira site', placeholder: 'yourcompany.atlassian.net' },
    { key: 'email', label: 'Atlassian account email' },
    { key: 'token', label: 'API token', secret: true },
  ],
  azure_devops: [
    { key: 'org', label: 'Organisation', placeholder: 'dev.azure.com/<organisation>' },
    { key: 'token', label: 'Personal access token (Work items: read & write)', secret: true },
  ],
  asana: [{ key: 'token', label: 'Personal access token', secret: true }],
  sharepoint: [
    { key: 'tenant', label: 'Microsoft Entra tenant ID' },
    { key: 'clientId', label: 'App (client) ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'site', label: 'Site', placeholder: 'yourcompany.sharepoint.com:/sites/Clients' },
    { key: 'folder', label: 'Folder in the document library', placeholder: 'CRM' },
  ],
  dynamics_bc: [
    { key: 'tenant', label: 'Microsoft Entra tenant ID' },
    { key: 'clientId', label: 'App (client) ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'environment', label: 'Environment', placeholder: 'production' },
    { key: 'company', label: 'Company ID (GUID)' },
  ],
  sap_b1: [
    { key: 'baseUrl', label: 'Service Layer URL', placeholder: 'https://sap.example.com:50000/b1s/v1' },
    { key: 'companyDb', label: 'Company database' },
    { key: 'user', label: 'User' },
    { key: 'password', label: 'Password', secret: true },
  ],
  netsuite: [
    { key: 'account', label: 'Account ID', placeholder: '1234567 or 1234567_SB1' },
    { key: 'consumerKey', label: 'Consumer key', secret: true },
    { key: 'consumerSecret', label: 'Consumer secret', secret: true },
    { key: 'tokenId', label: 'Token ID', secret: true },
    { key: 'tokenSecret', label: 'Token secret', secret: true },
  ],
};

const providerOf = (k: Connector) => (k === 'sharepoint' ? 'microsoft' : k);

export async function listConnectors(ctx: RecordCtx) {
  assertConnectorAdmin(ctx);
  const rows = await ctx.tx.query<Integration>(`select * from integrations where tenant_id = $1 and (provider = any($2::text[]) or (provider = 'microsoft' and account_ref like 'sharepoint:%')) order by created_at`, [
    ctx.tenantId,
    [...CHAT, ...TRACKERS, ...ERPS],
  ]);
  return {
    fields: FIELDS,
    alerts: ALERTS,
    items: rows.map((i) => ({ id: i.id, kind: i.account_ref.startsWith('sharepoint:') ? 'sharepoint' : i.provider, label: i.label, status: i.status, config: i.config, lastSyncAt: i.last_sync_at, lastError: i.last_error, lastEventAt: i.last_event_at })),
  };
}

export async function saveConnector(ctx: RecordCtx, env: Env, id: string | null, kind: Connector, input: { label?: string | null; values: Record<string, string>; alerts?: string[]; minDeal?: number | null }) {
  assertConnectorAdmin(ctx);
  const fields = FIELDS[kind];
  const secrets: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  let existing: Record<string, string> = {};
  if (id) {
    const i = await ctx.tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (!i) throw notFound('Connector not found');
    existing = i.secret_ciphertext ? await readSecret<Record<string, string>>(env, i) : {};
    Object.assign(config, i.config);
  }
  for (const f of fields) {
    const v = (input.values[f.key] ?? '').trim();
    if (f.secret) {
      if (v) secrets[f.key] = v;
      else if (existing[f.key]) secrets[f.key] = existing[f.key]!;
      else throw badRequest(`${f.label} is needed`);
    } else {
      if (!v && !config[f.key]) throw badRequest(`${f.label} is needed`);
      if (v) config[f.key] = v;
    }
  }
  if ((CHAT as readonly string[]).includes(kind)) {
    const url = secrets.url!;
    const host = new URL(url).hostname;
    const okHost = kind === 'slack' ? host === 'hooks.slack.com' : kind === 'gchat' ? host === 'chat.googleapis.com' : /(\.logic\.azure\.com|\.webhook\.office\.com|\.powerplatform\.com|\.environment\.api\.powerplatform\.com)$/.test(host);
    if (!url.startsWith('https://') || !okHost) throw badRequest(`That does not look like a ${kind === 'gchat' ? 'Google Chat' : kind === 'slack' ? 'Slack' : 'Teams'} webhook address`);
    config.alerts = (input.alerts ?? ['deal_won', 'urgent_ticket']).filter((a) => (ALERTS as readonly string[]).includes(a));
    config.minDeal = input.minDeal ?? 500000;
  }
  const sealed = await sealSecret(env, ctx.tenantId, secrets);
  const label = input.label?.trim() || ({ teams: 'Microsoft Teams', slack: 'Slack', gchat: 'Google Chat', jira: 'Jira', azure_devops: 'Azure DevOps', asana: 'Asana', sharepoint: 'SharePoint', dynamics_bc: 'Business Central', sap_b1: 'SAP Business One', netsuite: 'NetSuite' } as const)[kind];
  if (id) {
    await ctx.tx.query(`update integrations set label = $3, config = $4, secret_ciphertext = $5, status = 'active', last_error = null, error_count = 0, updated_at = now() where tenant_id = $1 and id = $2`, [
      ctx.tenantId, id, label, JSON.stringify(config), sealed,
    ]);
    return { id };
  }
  const ref = kind === 'sharepoint' ? `sharepoint:${crypto.randomUUID()}` : `${kind}:${crypto.randomUUID()}`;
  const r = await ctx.tx.one<{ id: string }>(
    `insert into integrations (tenant_id, provider, label, account_ref, config, secret_ciphertext, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, providerOf(kind), label, ref, JSON.stringify(config), sealed, ctx.principal.user.id],
  );
  return { id: r!.id };
}

export async function deleteConnector(ctx: RecordCtx, id: string) {
  assertConnectorAdmin(ctx);
  await ctx.tx.query(`delete from integrations where tenant_id = $1 and id = $2 and (provider = any($3::text[]) or account_ref like 'sharepoint:%')`, [ctx.tenantId, id, [...CHAT, ...TRACKERS, ...ERPS]]);
  return { ok: true };
}

async function load(tx: Tx, tenantId: string, id: string) {
  const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [tenantId, id]);
  if (!i) throw notFound('Connector not found');
  return i;
}

/* ───────────── chat alerts ───────────── */

export async function postChat(env: Env, i: Integration, msg: { title: string; text: string; link?: string | null }) {
  const { url } = await readSecret<{ url: string }>(env, i);
  const body =
    i.provider === 'teams'
      ? {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true },
                  { type: 'TextBlock', text: msg.text, wrap: true },
                ],
                actions: msg.link ? [{ type: 'Action.OpenUrl', title: 'Open in HRP Synapse', url: msg.link }] : [],
              },
            },
          ],
        }
      : i.provider === 'slack'
        ? { text: `*${msg.title}*\n${msg.text}${msg.link ? `\n<${msg.link}|Open in HRP Synapse>` : ''}` }
        : { text: `*${msg.title}*\n${msg.text}${msg.link ? `\n${msg.link}` : ''}` };
  await providerFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function testConnector(ctx: RecordCtx, env: Env, id: string) {
  assertConnectorAdmin(ctx);
  const i = await load(ctx.tx, ctx.tenantId, id);
  try {
    if ((CHAT as readonly string[]).includes(i.provider)) await postChat(env, i, { title: 'HRP Synapse is connected', text: 'Alerts from your CRM will appear here.' });
    else if (i.provider === 'jira') await jira(env, i, '/rest/api/3/myself');
    else if (i.provider === 'azure_devops') await ado(env, i, '/_apis/projects?api-version=7.1');
    else if (i.provider === 'asana') await asana(env, i, '/users/me');
    else if (i.account_ref.startsWith('sharepoint:')) await graph(env, i, `/sites/${i.config.site}`);
    else await erp(env, i).test();
    await markOk(ctx.tx, i, { event: true });
    return { ok: true };
  } catch (e) {
    await markError(ctx.tx, i, (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Called for every record event: posts to the chat connectors that want it. */
export async function chatAlerts(env: Env, db: Db, tenantId: string, origin: string | null, event: RecordEvent) {
  const interesting =
    (event.objectKey === 'deal' && (event.kind === 'created' || event.kind === 'stage_changed' || (event.kind === 'updated' && event.changes?.stage_id))) ||
    (event.objectKey === 'ticket' && event.kind === 'created') ||
    (event.objectKey === 'sales_order' && (event.changes as any)?.status?.[1] === 'confirmed') ||
    (event.objectKey === 'payment' && event.kind === 'created');
  if (!interesting) return 0;
  return db.tx({ tenantId }, async (tx) => {
    const hooks = await tx.query<Integration>(`select * from integrations where tenant_id = $1 and provider = any($2::text[]) and status = 'active'`, [tenantId, [...CHAT]]);
    if (!hooks.length) return 0;
    const link = origin ? `${origin}/o/${event.objectKey}/${event.recordId}` : null;
    let msg: { alert: string; title: string; text: string; amount?: number } | null = null;
    if (event.objectKey === 'deal') {
      const d = await tx.one<{ name: string; amount: string | null; cat: string; account: string | null; owner: string | null; loss_reason: string | null; lost_to: string | null }>(
        `select d.name, d.amount, s.category as cat, a.name as account, u.full_name as owner, d.loss_reason, d.lost_to from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
          left join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id left join users u on u.tenant_id = d.tenant_id and u.id = d.owner_id where d.tenant_id = $1 and d.id = $2`,
        [tenantId, event.recordId],
      );
      if (!d) return 0;
      const amt = Number(d.amount ?? 0);
      const money = `₹${amt.toLocaleString('en-IN')}`;
      if (event.kind === 'created') msg = { alert: 'big_deal', title: `New deal: ${d.name}`, text: `${d.account ?? ''} · ${money} · ${d.owner ?? ''}`, amount: amt };
      else if (d.cat === 'won') msg = { alert: 'deal_won', title: `🎉 Won: ${d.name}`, text: `${d.account ?? ''} · ${money} · ${d.owner ?? ''}` };
      else if (d.cat === 'lost') msg = { alert: 'deal_lost', title: `Lost: ${d.name}`, text: `${d.account ?? ''} · ${money}${d.loss_reason ? ` · ${d.loss_reason.replace(/_/g, ' ')}` : ''}${d.lost_to ? ` (to ${d.lost_to})` : ''}` };
    } else if (event.objectKey === 'ticket') {
      const t = await tx.one<{ ticket_number: string; name: string; priority: string; account: string | null }>(
        `select t.ticket_number, t.name, t.priority, a.name as account from tickets t left join accounts a on a.tenant_id = t.tenant_id and a.id = t.account_id where t.tenant_id = $1 and t.id = $2`,
        [tenantId, event.recordId],
      );
      if (t && ['urgent', 'high', 'critical'].includes(t.priority)) msg = { alert: 'urgent_ticket', title: `${t.priority === 'urgent' || t.priority === 'critical' ? '🚨' : '⚠️'} ${t.ticket_number}: ${t.name}`, text: `${t.account ?? ''} · ${t.priority}` };
    } else if (event.objectKey === 'sales_order') {
      const o = await tx.one<{ order_number: string; grand_total: string; account: string | null }>(
        `select o.order_number, o.grand_total, a.name as account from sales_orders o left join accounts a on a.tenant_id = o.tenant_id and a.id = o.account_id where o.tenant_id = $1 and o.id = $2`,
        [tenantId, event.recordId],
      );
      if (o) msg = { alert: 'order_confirmed', title: `Order confirmed: ${o.order_number}`, text: `${o.account ?? ''} · ₹${Number(o.grand_total).toLocaleString('en-IN')}` };
    } else if (event.objectKey === 'payment') {
      const p = await tx.one<{ payment_number: string; amount: string; account: string | null }>(
        `select p.payment_number, p.amount, a.name as account from payments p left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id where p.tenant_id = $1 and p.id = $2`,
        [tenantId, event.recordId],
      );
      if (p) msg = { alert: 'payment_received', title: `Payment received: ₹${Number(p.amount).toLocaleString('en-IN')}`, text: `${p.account ?? ''} · ${p.payment_number}` };
    }
    if (!msg) return 0;
    let sent = 0;
    for (const h of hooks) {
      const alerts = (h.config.alerts as string[] | undefined) ?? [];
      if (!alerts.includes(msg.alert)) continue;
      if (msg.alert === 'big_deal' && (msg.amount ?? 0) < Number(h.config.minDeal ?? 0)) continue;
      try {
        await postChat(env, h, { title: msg.title, text: msg.text, link });
        await markOk(tx, h, { event: true });
        sent++;
      } catch (e) {
        await markError(tx, h, (e as Error).message);
      }
    }
    return sent;
  });
}

/* ───────────── Jira / Azure DevOps / Asana ───────────── */

async function jira(env: Env, i: Integration, path: string, init: RequestInit = {}) {
  const s = await readSecret<{ token: string }>(env, i);
  const site = String(i.config.site).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/\.atlassian\.net$/.test(site) && !/^[a-z0-9.-]+$/i.test(site)) throw badRequest('Jira site looks wrong');
  return providerFetch(`https://${site}${path}`, { ...init, headers: { authorization: `Basic ${btoa(`${i.config.email}:${s.token}`)}`, accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) } });
}
async function ado(env: Env, i: Integration, path: string, init: RequestInit & { patch?: boolean } = {}) {
  const s = await readSecret<{ token: string }>(env, i);
  const org = String(i.config.org).replace(/^https?:\/\/dev\.azure\.com\//, '').replace(/\/.*$/, '');
  return providerFetch(`https://dev.azure.com/${encodeURIComponent(org)}${path}`, {
    ...init,
    headers: { authorization: `Basic ${btoa(`:${s.token}`)}`, accept: 'application/json', 'content-type': init.patch ? 'application/json-patch+json' : 'application/json' },
  });
}
async function asana(env: Env, i: Integration, path: string, init: RequestInit = {}) {
  const s = await readSecret<{ token: string }>(env, i);
  return providerFetch(`https://app.asana.com/api/1.0${path}`, { ...init, headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', 'content-type': 'application/json' } });
}

/** Links a project to a project in the tracker (Jira key, Azure DevOps project name, Asana project gid). */
export async function linkProject(ctx: RecordCtx, projectId: string, input: { integrationId: string; key: string } | null) {
  if (!hasAdmin(ctx.principal.permissions, 'projects') && !hasAdmin(ctx.principal.permissions, 'developers')) throw forbidden('Linking a tracker needs the projects permission');
  if (input) {
    const i = await load(ctx.tx, ctx.tenantId, input.integrationId);
    if (!(TRACKERS as readonly string[]).includes(i.provider)) throw badRequest('Pick a Jira, Azure DevOps or Asana connection');
    await ctx.tx.query(`update projects set external = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId, JSON.stringify({ provider: i.provider, integrationId: i.id, key: input.key.trim() })]);
  } else await ctx.tx.query(`update projects set external = null where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]);
  return { ok: true };
}

const isDone = (s: string) => /^(done|closed|resolved|completed|complete)$/i.test(s.trim());

/** Pushes tasks that are not in the tracker yet, then pulls the status of the linked ones. */
export async function syncProject(ctx: RecordCtx, env: Env, projectId: string) {
  const p = await ctx.tx.one<{ name: string; external: { provider: string; integrationId: string; key: string } | null }>(`select name, external from projects where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, projectId]);
  if (!p) throw notFound('Project not found');
  if (!p.external) throw badRequest('Link the project to Jira, Azure DevOps or Asana first');
  const i = await load(ctx.tx, ctx.tenantId, p.external.integrationId);
  const key = p.external.key;
  const tasks = await ctx.tx.query<{ id: string; name: string; description: string | null; status: string; due_date: string | null; external_key: string | null; work_type: string | null }>(
    `select id, name, description, status, due_date::text, external_key, work_type from project_tasks where tenant_id = $1 and project_id = $2 order by position limit 500`,
    [ctx.tenantId, projectId],
  );
  let pushed = 0;
  let pulled = 0;
  try {
    for (const t of tasks.filter((x) => !x.external_key && x.status !== 'done')) {
      let ref: { key: string; url: string };
      if (i.provider === 'jira') {
        const site = String(i.config.site).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const r = await jira(env, i, '/rest/api/3/issue', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              project: { key },
              summary: t.name.slice(0, 250),
              issuetype: { name: t.work_type === 'bug' ? 'Bug' : t.work_type === 'story' ? 'Story' : 'Task' },
              ...(t.description ? { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t.description.slice(0, 30000) }] }] } } : {}),
              ...(t.due_date ? { duedate: t.due_date } : {}),
            },
          }),
        });
        ref = { key: r.key, url: `https://${site}/browse/${r.key}` };
      } else if (i.provider === 'azure_devops') {
        const type = t.work_type === 'bug' ? 'Bug' : t.work_type === 'story' ? 'User%20Story' : 'Task';
        const ops = [{ op: 'add', path: '/fields/System.Title', value: t.name.slice(0, 250) }, ...(t.description ? [{ op: 'add', path: '/fields/System.Description', value: t.description.slice(0, 30000) }] : [])];
        const r = await ado(env, i, `/${encodeURIComponent(key)}/_apis/wit/workitems/$${type}?api-version=7.1`, { method: 'POST', body: JSON.stringify(ops), patch: true });
        ref = { key: String(r.id), url: r._links?.html?.href ?? '' };
      } else {
        const r = await asana(env, i, '/tasks', { method: 'POST', body: JSON.stringify({ data: { name: t.name.slice(0, 250), notes: t.description ?? '', projects: [key], ...(t.due_date ? { due_on: t.due_date } : {}) } }) });
        ref = { key: r.data.gid, url: r.data.permalink_url ?? '' };
      }
      await ctx.tx.query(`update project_tasks set external_key = $3, external_url = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, t.id, ref.key, ref.url || null]);
      t.external_key = ref.key;
      pushed++;
    }
    for (const t of tasks.filter((x) => x.external_key && x.status !== 'done')) {
      let done = false;
      if (i.provider === 'jira') {
        const r = await jira(env, i, `/rest/api/3/issue/${encodeURIComponent(t.external_key!)}?fields=status`);
        done = r.fields?.status?.statusCategory?.key === 'done' || isDone(r.fields?.status?.name ?? '');
      } else if (i.provider === 'azure_devops') {
        const r = await ado(env, i, `/_apis/wit/workitems/${encodeURIComponent(t.external_key!)}?fields=System.State&api-version=7.1`);
        done = isDone(r.fields?.['System.State'] ?? '');
      } else {
        const r = await asana(env, i, `/tasks/${encodeURIComponent(t.external_key!)}?opt_fields=completed`);
        done = !!r.data?.completed;
      }
      if (done) {
        await ctx.tx.query(`update project_tasks set status = 'done', progress = 100, completed_at = coalesce(completed_at, now()) where tenant_id = $1 and id = $2`, [ctx.tenantId, t.id]);
        pulled++;
      }
    }
    await markOk(ctx.tx, i, { sync: true });
  } catch (e) {
    await markError(ctx.tx, i, (e as Error).message);
    throw badRequest(`${i.label ?? i.provider}: ${(e as Error).message}`);
  }
  return { pushed, completed: pulled };
}

/* ───────────── SharePoint ───────────── */

async function graphToken(env: Env, i: Integration) {
  const s = await readSecret<{ clientSecret: string }>(env, i);
  const r = await providerFetch<{ access_token: string }>(`https://login.microsoftonline.com/${encodeURIComponent(String(i.config.tenant))}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: String(i.config.clientId), client_secret: s.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
  });
  return r.access_token;
}
async function graph(env: Env, i: Integration, path: string, init: RequestInit = {}) {
  const token = await graphToken(env, i);
  return providerFetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

/** Copies one record file into SharePoint (folder / record type / file name). */
export async function fileToSharePoint(ctx: RecordCtx, env: Env, fileId: string) {
  const i = await ctx.tx.one<Integration>(`select * from integrations where tenant_id = $1 and provider = 'microsoft' and account_ref like 'sharepoint:%' and status = 'active' order by created_at limit 1`, [ctx.tenantId]);
  if (!i) throw badRequest('Connect SharePoint first (Settings → Connectors)');
  const f = await openFile(ctx, env, fileId);
  const bytes = await new Response(f.body).arrayBuffer();
  if (bytes.byteLength > 4 * 1024 * 1024) throw badRequest('Files over 4 MB are not copied to SharePoint yet');
  const site = await graph(env, i, `/sites/${i.config.site}`);
  const folder = [String(i.config.folder ?? 'CRM').replace(/^\/+|\/+$/g, ''), f.file.object_key].filter(Boolean).map(encodeURIComponent).join('/');
  const up = await graph(env, i, `/sites/${site.id}/drive/root:/${folder}/${encodeURIComponent(f.file.name)}:/content`, {
    method: 'PUT',
    headers: { 'content-type': f.file.content_type || 'application/octet-stream' },
    body: bytes,
  });
  await markOk(ctx.tx, i, { event: true });
  return { url: up.webUrl as string };
}

/* ───────────── ERPs ───────────── */

interface ErpAdapter {
  test(): Promise<unknown>;
  customers(): Promise<{ id: string; name: string; gstin?: string | null; email?: string | null; phone?: string | null; city?: string | null }[]>;
  items(): Promise<{ id: string; sku: string; name: string; price: number | null; unit?: string | null }[]>;
  pushOrder(o: { number: string; date: string; customerRef: string; lines: { sku: string; qty: number; price: number }[] }): Promise<string>;
}

async function hmacB64(key: string, data: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** OAuth 1.0a (HMAC-SHA256) header for NetSuite token-based authentication. */
export async function netsuiteAuth(s: { account: string; consumerKey: string; consumerSecret: string; tokenId: string; tokenSecret: string }, method: string, url: string, nonce = crypto.randomUUID().replace(/-/g, ''), ts = Math.floor(Date.now() / 1000).toString()) {
  const u = new URL(url);
  const oauth: Record<string, string> = { oauth_consumer_key: s.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: ts, oauth_token: s.tokenId, oauth_version: '1.0' };
  const params = [...Object.entries(oauth), ...[...u.searchParams.entries()]].map(([k, v]) => [pct(k), pct(v)] as const).sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const sig = await hmacB64(`${pct(s.consumerSecret)}&${pct(s.tokenSecret)}`, base);
  const realm = s.account.toUpperCase().replace('-', '_');
  return `OAuth realm="${realm}", ${Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${k}="${pct(v)}"`).join(', ')}`;
}

export function erp(env: Env, i: Integration): ErpAdapter {
  const c = i.config as Record<string, string>;
  if (i.provider === 'dynamics_bc') {
    const base = `https://api.businesscentral.dynamics.com/v2.0/${encodeURIComponent(c.tenant!)}/${encodeURIComponent(c.environment || 'production')}/api/v2.0/companies(${c.company})`;
    const call = async (path: string, init: RequestInit = {}) => {
      const s = await readSecret<{ clientSecret: string }>(env, i);
      const t = await providerFetch<{ access_token: string }>(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant!)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.clientId!, client_secret: s.clientSecret, scope: 'https://api.businesscentral.dynamics.com/.default', grant_type: 'client_credentials' }).toString(),
      });
      return providerFetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json' } });
    };
    return {
      test: () => call('/customers?$top=1'),
      customers: async () => ((await call('/customers?$top=1000')).value as any[]).map((x) => ({ id: x.id, name: x.displayName, email: x.email || null, phone: x.phoneNumber || null, city: x.city || null, gstin: x.taxRegistrationNumber || null })),
      items: async () => ((await call('/items?$top=2000')).value as any[]).map((x) => ({ id: x.id, sku: x.number, name: x.displayName, price: Number(x.unitPrice ?? 0) || null, unit: x.baseUnitOfMeasureCode || null })),
      pushOrder: async (o) => {
        const r = await call('/salesOrders', { method: 'POST', body: JSON.stringify({ externalDocumentNumber: o.number, orderDate: o.date, customerId: o.customerRef, salesOrderLines: o.lines.map((l) => ({ lineType: 'Item', lineObjectNumber: l.sku, quantity: l.qty, unitPrice: l.price })) }) });
        return String(r.number ?? r.id);
      },
    };
  }
  if (i.provider === 'sap_b1') {
    const base = String(c.baseUrl).replace(/\/+$/, '');
    if (!base.startsWith('https://')) throw badRequest('The Service Layer URL must use https');
    let cookie: string | null = null;
    const call = async (path: string, init: RequestInit = {}) => {
      if (!cookie) {
        const s = await readSecret<{ password: string }>(env, i);
        const res = await fetch(`${base}/Login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ CompanyDB: c.companyDb, UserName: c.user, Password: s.password }), signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`SAP login failed (HTTP ${res.status})`);
        const sid = ((await res.json()) as { SessionId: string }).SessionId;
        cookie = `B1SESSION=${sid}`;
      }
      return providerFetch(`${base}${path}`, { ...init, headers: { cookie, 'content-type': 'application/json', prefer: 'odata.maxpagesize=1000' } });
    };
    return {
      test: () => call('/CompanyService_GetCompanyInfo', { method: 'POST', body: '{}' }),
      customers: async () => ((await call(`/BusinessPartners?$select=CardCode,CardName,EmailAddress,Phone1,City&$filter=CardType eq 'cCustomer'`)).value as any[]).map((x) => ({ id: x.CardCode, name: x.CardName, email: x.EmailAddress || null, phone: x.Phone1 || null, city: x.City || null })),
      items: async () => ((await call('/Items?$select=ItemCode,ItemName,SalesUnit,ItemPrices')).value as any[]).map((x) => ({ id: x.ItemCode, sku: x.ItemCode, name: x.ItemName, price: Number(x.ItemPrices?.[0]?.Price ?? 0) || null, unit: x.SalesUnit || null })),
      pushOrder: async (o) => {
        const r = await call('/Orders', { method: 'POST', body: JSON.stringify({ CardCode: o.customerRef, DocDate: o.date, DocDueDate: o.date, NumAtCard: o.number, DocumentLines: o.lines.map((l) => ({ ItemCode: l.sku, Quantity: l.qty, UnitPrice: l.price })) }) });
        return String(r.DocNum ?? r.DocEntry);
      },
    };
  }
  if (i.provider === 'netsuite') {
    const host = `https://${String(c.account).toLowerCase().replace('_', '-')}.suitetalk.api.netsuite.com/services/rest`;
    const call = async (path: string, init: RequestInit & { method?: string } = {}) => {
      const s = await readSecret<{ consumerKey: string; consumerSecret: string; tokenId: string; tokenSecret: string }>(env, i);
      const url = `${host}${path}`;
      const auth = await netsuiteAuth({ account: c.account!, ...s }, init.method ?? 'GET', url);
      return providerFetch(url, { ...init, headers: { authorization: auth, 'content-type': 'application/json', prefer: 'transient' } });
    };
    const query = async (q: string) => ((await call('/query/v1/suiteql?limit=1000', { method: 'POST', body: JSON.stringify({ q }) })).items ?? []) as any[];
    return {
      test: () => query('select id from customer where rownum <= 1'),
      customers: async () => (await query('select id, companyname, email, phone from customer where isinactive = \'F\'')).map((x) => ({ id: String(x.id), name: x.companyname, email: x.email || null, phone: x.phone || null })),
      items: async () => (await query('select id, itemid, displayname from item where isinactive = \'F\'')).map((x) => ({ id: String(x.id), sku: x.itemid, name: x.displayname || x.itemid, price: null })),
      pushOrder: async (o) => {
        await call('/record/v1/salesOrder', { method: 'POST', body: JSON.stringify({ entity: { id: o.customerRef }, tranDate: o.date, otherRefNum: o.number, item: { items: o.lines.map((l) => ({ item: { externalId: l.sku }, quantity: l.qty, rate: l.price })) } }) });
        return o.number;
      },
    };
  }
  throw badRequest('Not an ERP connection');
}

/** Pulls customers and products from the ERP: matched by the ERP id, then by SKU / name; new ones created. */
export async function erpPull(ctx: RecordCtx, env: Env, id: string, what: { customers: boolean; items: boolean }) {
  assertConnectorAdmin(ctx);
  const i = await load(ctx.tx, ctx.tenantId, id);
  const a = erp(env, i);
  const out = { customers: { created: 0, linked: 0 }, items: { created: 0, linked: 0, priced: 0 } };
  try {
    if (what.customers) {
      for (const c of (await a.customers()).slice(0, 2000)) {
        if (!c.name) continue;
        if (await refOf(ctx.tx, ctx.tenantId, i.provider, `cust:${c.id}`)) continue;
        const m = await ctx.tx.one<{ id: string }>(`select id from accounts where tenant_id = $1 and deleted_at is null and (lower(name) = lower($2) or ($3::text is not null and gstin = $3)) limit 1`, [ctx.tenantId, c.name, c.gstin ?? null]);
        const accId =
          m?.id ??
          (await ctx.tx.one<{ id: string }>(`insert into accounts (tenant_id, name, phone, city, gstin, account_type, owner_id) values ($1,$2,$3,$4,$5,'customer',$6) returning id`, [
            ctx.tenantId, c.name.slice(0, 200), c.phone?.slice(0, 20) ?? null, c.city ?? null, c.gstin && /^[0-9A-Z]{15}$/.test(c.gstin) ? c.gstin : null, ctx.principal.user.id,
          ]))!.id;
        if (m) out.customers.linked++;
        else out.customers.created++;
        await claimRef(ctx.tx, ctx.tenantId, i.provider, `cust:${c.id}`, 'account', accId);
      }
    }
    if (what.items) {
      for (const it of (await a.items()).slice(0, 5000)) {
        if (!it.sku) continue;
        const ref = await refOf(ctx.tx, ctx.tenantId, i.provider, `item:${it.id}`);
        let pid = ref?.record_id ?? null;
        if (!pid) {
          const m = await ctx.tx.one<{ id: string }>(`select id from products where tenant_id = $1 and deleted_at is null and lower(sku) = lower($2) limit 1`, [ctx.tenantId, it.sku]);
          pid =
            m?.id ??
            (await ctx.tx.one<{ id: string }>(`insert into products (tenant_id, name, sku, unit, list_price, owner_id) values ($1,$2,$3,$4,$5,$6) returning id`, [
              ctx.tenantId, it.name.slice(0, 200), it.sku.slice(0, 100), it.unit ?? null, it.price, ctx.principal.user.id,
            ]))!.id;
          if (m) out.items.linked++;
          else out.items.created++;
          await claimRef(ctx.tx, ctx.tenantId, i.provider, `item:${it.id}`, 'product', pid);
        } else if (it.price != null) {
          await ctx.tx.query(`update products set list_price = $3 where tenant_id = $1 and id = $2 and list_price is distinct from $3`, [ctx.tenantId, pid, it.price]);
          out.items.priced++;
        }
      }
    }
    await markOk(ctx.tx, i, { sync: true });
  } catch (e) {
    await markError(ctx.tx, i, (e as Error).message);
    throw badRequest(`${i.label ?? i.provider}: ${(e as Error).message}`);
  }
  return out;
}

/** Sends a confirmed order to the ERP (customer and items must have come from it, or match by SKU). */
export async function erpPushOrder(ctx: RecordCtx, env: Env, id: string, orderId: string) {
  const i = await load(ctx.tx, ctx.tenantId, id);
  if (!(ERPS as readonly string[]).includes(i.provider)) throw badRequest('Not an ERP connection');
  const o = await ctx.tx.one<{ order_number: string; order_date: string; account_id: string | null; status: string }>(`select order_number, order_date::text, account_id, status from sales_orders where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, orderId]);
  if (!o) throw notFound('Order not found');
  if (o.status === 'draft' || o.status === 'cancelled') throw badRequest('Only confirmed orders go to the ERP');
  const cust = await ctx.tx.one<{ external_id: string }>(`select external_id from integration_refs where tenant_id = $1 and provider = $2 and object_key = 'account' and record_id = $3 and external_id like 'cust:%' limit 1`, [ctx.tenantId, i.provider, o.account_id]);
  if (!cust) throw badRequest('This customer is not linked to the ERP yet — pull customers first');
  const lines = await ctx.tx.query<{ sku: string | null; quantity: string; unit_price: string; name: string }>(
    `select p.sku, l.quantity, l.unit_price, l.name from sales_order_lines l left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.order_id = $2 order by l.position`,
    [ctx.tenantId, orderId],
  );
  const missing = lines.filter((l) => !l.sku).map((l) => l.name);
  if (missing.length) throw badRequest(`Lines without a product SKU: ${missing.slice(0, 3).join(', ')}`);
  try {
    const ref = await erp(env, i).pushOrder({ number: o.order_number, date: o.order_date, customerRef: cust.external_id.slice(5), lines: lines.map((l) => ({ sku: l.sku!, qty: Number(l.quantity), price: Number(l.unit_price) })) });
    await claimRef(ctx.tx, ctx.tenantId, i.provider, `order:${ref}`, 'sales_order', orderId);
    await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id, actor_id) values ($1,'system',$2,'sales_order',$3,$4)`, [ctx.tenantId, `Sent to ${i.label}: ${ref}`, orderId, ctx.principal.user.id]);
    await markOk(ctx.tx, i, { event: true });
    return { ref };
  } catch (e) {
    await markError(ctx.tx, i, (e as Error).message);
    throw badRequest(`${i.label ?? i.provider}: ${(e as Error).message}`);
  }
}
