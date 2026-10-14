/**
 * Lead ads: Facebook / Instagram lead forms (Meta) and Google Ads lead form assets.
 *
 *   Meta     a workspace admin signs in with Facebook once; every page they grant is subscribed to
 *            the `leadgen` webhook. Meta posts lead ids to one platform URL (signed with the app
 *            secret); the page id routes the lead to its workspace and the lead is fetched with the
 *            page token.
 *   Google   each workspace gets a webhook URL + key to paste into the lead form in Google Ads.
 *
 * Every ad lead is created once (by the network's lead id). When the email or phone already belongs
 * to an open lead or a contact, the enquiry is added to that record instead of creating a duplicate.
 */
import type { Env } from '../env';
import type { Tx } from '../lib/db';
import { claimRef, form, type Integration, markError, markOk, META_GRAPH, ProviderError, providerFetch, readSecret, sealSecret } from './integrations';
import { createRecord, type RecordCtx, type RecordEvent } from './records';
import { systemPrincipal } from './system';

export interface AdLead {
  network: 'meta' | 'google';
  externalId: string;
  source: 'facebook' | 'instagram' | 'google_ads';
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  city: string | null;
  campaign: string | null;
  form: string | null;
  answers: [string, string][];
  isTest: boolean;
}

const pretty = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function splitName(full: string | null): [string | null, string | null] {
  const f = (full ?? '').trim();
  if (!f) return [null, null];
  const i = f.lastIndexOf(' ');
  return i > 0 ? [f.slice(0, i), f.slice(i + 1)] : [null, f];
}

// ---------------------------------------------------------------------------------- Meta
/** Meta field_data → normalised lead. Standard keys per Meta's lead form question types. */
export function fromMeta(lead: any): AdLead {
  const fields = new Map<string, string>();
  for (const f of lead.field_data ?? []) fields.set(String(f.name).toLowerCase(), String((f.values ?? [])[0] ?? '').trim());
  const take = (...keys: string[]) => {
    for (const k of keys) {
      const v = fields.get(k);
      if (v) {
        fields.delete(k);
        return v;
      }
    }
    return null;
  };
  let first = take('first_name');
  let last = take('last_name');
  const full = take('full_name', 'name');
  if (!first && !last) [first, last] = splitName(full);
  const lead_: AdLead = {
    network: 'meta',
    externalId: String(lead.id),
    source: lead.platform === 'ig' || lead.platform === 'instagram' ? 'instagram' : 'facebook',
    firstName: first,
    lastName: last,
    email: take('email', 'work_email')?.toLowerCase() ?? null,
    phone: take('phone_number', 'phone', 'work_phone_number', 'mobile_number'),
    company: take('company_name', 'company'),
    city: take('city'),
    campaign: lead.campaign_name ?? lead.ad_name ?? null,
    form: lead.form_name ?? (lead.form_id ? `Form ${lead.form_id}` : null),
    answers: [],
    isTest: !!lead.is_test || String(lead.id).startsWith('444444'),
  };
  for (const [k, v] of fields) if (v) lead_.answers.push([pretty(k), v]);
  return lead_;
}

export async function fetchMetaLead(i: Integration, env: Env, leadgenId: string): Promise<AdLead> {
  const s = await readSecret<{ pageToken: string }>(env, i);
  const lead = await providerFetch(
    `${META_GRAPH}/${encodeURIComponent(leadgenId)}?${form({ fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_name,campaign_name,platform,is_organic', access_token: s.pageToken })}`,
  );
  let formName: string | null = null;
  if (lead.form_id) {
    formName = await providerFetch(`${META_GRAPH}/${encodeURIComponent(lead.form_id)}?${form({ fields: 'name', access_token: s.pageToken })}`)
      .then((f: any) => f?.name ?? null)
      .catch(() => null);
  }
  return fromMeta({ ...lead, form_name: formName });
}

/** After Facebook sign-in: subscribe every granted page to leadgen and store its page token. */
export async function connectMetaPages(env: Env, tx: Tx, tenantId: string, userToken: string, connectedBy: string) {
  const pages = await providerFetch<{ data: { id: string; name: string; access_token: string; tasks?: string[] }[] }>(
    `${META_GRAPH}/me/accounts?${form({ fields: 'id,name,access_token,tasks', limit: '100', access_token: userToken })}`,
  );
  const connected: string[] = [];
  const failed: string[] = [];
  for (const p of pages.data ?? []) {
    // only pages this person actually runs (manage or advertise) — not ones they merely moderate
    if (p.tasks && !p.tasks.some((t) => t === 'MANAGE' || t === 'ADVERTISE')) {
      failed.push(`${p.name} (you need Manage or Advertise access to the page)`);
      continue;
    }
    try {
      await providerFetch(`${META_GRAPH}/${encodeURIComponent(p.id)}/subscribed_apps?${form({ subscribed_fields: 'leadgen', access_token: p.access_token })}`, { method: 'POST' });
      const secret = await sealSecret(env, tenantId, { pageToken: p.access_token });
      await tx.query('savepoint page_connect');
      try {
        await tx.query(
          `insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, created_by, config)
           values ($1, 'meta_leads', $2, $3, $4, $5, '{}'::jsonb)
           on conflict (tenant_id, provider, account_ref) do update set label = excluded.label, secret_ciphertext = excluded.secret_ciphertext, status = 'active', last_error = null, error_count = 0`,
          [tenantId, p.name.slice(0, 200), p.id, secret, connectedBy],
        );
        await tx.query('release savepoint page_connect');
        connected.push(p.name);
      } catch {
        // the page is already connected to another workspace (its route key is taken)
        await tx.query('rollback to savepoint page_connect');
        failed.push(`${p.name} (connected to another workspace)`);
      }
    } catch (e) {
      failed.push(`${p.name} (${(e as Error).message})`);
    }
  }
  return { connected, failed };
}

// ---------------------------------------------------------------------------------- Google
export function fromGoogle(body: any): AdLead {
  const cols = new Map<string, string>();
  const extra: [string, string][] = [];
  for (const c of body.user_column_data ?? []) {
    const id = String(c.column_id ?? '').toUpperCase();
    const v = String(c.string_value ?? '').trim();
    if (!v) continue;
    if (['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'WORK_EMAIL', 'PHONE_NUMBER', 'WORK_PHONE', 'COMPANY_NAME', 'CITY'].includes(id)) cols.set(id, v);
    else extra.push([c.column_name ? String(c.column_name) : pretty(id.toLowerCase()), v]);
  }
  let first = cols.get('FIRST_NAME') ?? null;
  let last = cols.get('LAST_NAME') ?? null;
  if (!first && !last) [first, last] = splitName(cols.get('FULL_NAME') ?? null);
  return {
    network: 'google',
    externalId: String(body.lead_id ?? ''),
    source: 'google_ads',
    firstName: first,
    lastName: last,
    email: (cols.get('EMAIL') ?? cols.get('WORK_EMAIL') ?? null)?.toLowerCase() ?? null,
    phone: cols.get('PHONE_NUMBER') ?? cols.get('WORK_PHONE') ?? null,
    company: cols.get('COMPANY_NAME') ?? null,
    city: cols.get('CITY') ?? null,
    campaign: body.campaign_id ? `Campaign ${body.campaign_id}` : null,
    form: body.form_id ? `Form ${body.form_id}` : null,
    answers: extra,
    isTest: body.is_test === true,
  };
}

// ---------------------------------------------------------------------------------- ingest
/** Creates (or attaches to) the lead. Returns events for automations. */
export async function ingestAdLead(ctx: Omit<RecordCtx, 'principal'>, i: Integration, l: AdLead): Promise<{ events: RecordEvent[]; leadId: string | null; duplicateOf: string | null }> {
  const refKey = `${l.network}_lead`;
  // claimed first: a concurrent retry of the same lead stops here
  const claimId = crypto.randomUUID();
  if (!(await claimRef(ctx.tx, ctx.tenantId, refKey, l.externalId, 'lead', claimId))) return { events: [], leadId: null, duplicateOf: null };
  const detail = [l.form, l.campaign].filter(Boolean).join(' · ') || (l.network === 'meta' ? 'Facebook lead ad' : 'Google lead form');
  const note = [
    `${l.network === 'meta' ? (l.source === 'instagram' ? 'Instagram' : 'Facebook') : 'Google'} lead ad${l.isTest ? ' (test lead)' : ''}`,
    l.form ? `Form: ${l.form}` : null,
    l.campaign ? `Campaign: ${l.campaign}` : null,
    l.city ? `City: ${l.city}` : null,
    ...l.answers.map(([q, a]) => `${q}: ${a}`),
  ]
    .filter(Boolean)
    .join('\n');

  // the same person enquiring again lands on their existing record
  const phoneKey = l.phone ? l.phone.replace(/\D/g, '').slice(-10) : null;
  const existing =
    l.email || phoneKey
      ? await ctx.tx.one<{ object: 'lead' | 'contact'; id: string; owner_id: string | null; name: string }>(
          `select * from (
             select 'lead' as object, id, owner_id, full_name as name, 1 as pri from leads where tenant_id = $1 and deleted_at is null and converted_at is null
                and (($2::text is not null and lower(email) = $2) or ($3::text is not null and app.phone_key(phone) = $3))
             union all
             select 'contact', id, owner_id, full_name, 2 from contacts where tenant_id = $1 and deleted_at is null
                and (($2::text is not null and lower(email) = $2) or ($3::text is not null and app.phone_key(phone) = $3))
           ) x order by pri limit 1`,
          [ctx.tenantId, l.email, phoneKey],
        )
      : null;
  if (existing) {
    await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata) values ($1,'note',$2,$3,'in',$4,$5,$6)`, [
      ctx.tenantId, 'New ad enquiry', note, existing.object, existing.id, JSON.stringify({ adLead: l.externalId, network: l.network }),
    ]);
    if (existing.owner_id) {
      await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'lead',$3,$4,$5)`, [
        ctx.tenantId, existing.owner_id, `${existing.name} enquired again`, detail, `/o/${existing.object}/${existing.id}`,
      ]);
    }
    await ctx.tx.query(`update external_refs set object_key = $4, record_id = $5 where tenant_id = $1 and provider = $2 and external_id = $3`, [ctx.tenantId, refKey, l.externalId, existing.object, existing.id]);
    return { events: [], leadId: null, duplicateOf: existing.id };
  }

  const owner = (i.config.ownerId as string | undefined) ?? (await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [ctx.tenantId]))?.id ?? null;
  const principal = systemPrincipal(owner, ctx.meta.objects.map((o) => o.key));
  const values: Record<string, unknown> = {
    first_name: l.firstName,
    last_name: l.lastName || l.firstName || l.email || l.phone || 'Ad lead',
    email: l.email,
    phone: l.phone,
    company: l.company,
    source: l.source,
    source_detail: `${l.isTest ? '[test] ' : ''}${detail}`.slice(0, 250),
    next_follow_up_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    owner_id: (i.config.ownerId as string | undefined) ?? null,
  };
  for (const k of Object.keys(values)) if (values[k] === null || values[k] === undefined || values[k] === '') delete values[k];
  const { record, events } = await createRecord({ ...ctx, principal }, 'lead', values, { bypassPermissions: true, autoAssign: !i.config.ownerId });
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata) values ($1,'note',$2,$3,'in','lead',$4,$5)`, [
    ctx.tenantId, 'Lead form answers', note, record.id, JSON.stringify({ adLead: l.externalId, network: l.network }),
  ]);
  await ctx.tx.query(`update external_refs set record_id = $4 where tenant_id = $1 and provider = $2 and external_id = $3`, [ctx.tenantId, refKey, l.externalId, record.id]);
  return { events, leadId: record.id, duplicateOf: null };
}

/** Worker: fetch a Meta lead by id and ingest it. */
export async function processMetaLead(env: Env, ctx: Omit<RecordCtx, 'principal'>, i: Integration, leadgenId: string) {
  try {
    const lead = await fetchMetaLead(i, env, leadgenId);
    const r = await ingestAdLead(ctx, i, lead);
    await markOk(ctx.tx, i, { event: true });
    return r;
  } catch (e) {
    await markError(ctx.tx, i, `Lead ${leadgenId}: ${(e as Error).message}`, e instanceof ProviderError && e.status === 190);
    throw e;
  }
}
