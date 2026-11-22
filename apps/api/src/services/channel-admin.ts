/**
 * Looking after a connected channel after it is set up: edit its name and settings, replace a
 * credential (an expired WhatsApp token, a new Resend key) without re-entering the others, pause and
 * resume it, check the connection against the provider, fix the usual Meta gaps (the app not
 * subscribed to the WhatsApp Business Account), connect another number of the same account, and give
 * it a new inbound address.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import type { Db, Tx } from '../lib/db';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import type { ChannelAccount } from './channels';
import { waFetch } from './whatsapp';

/** Settings each kind of channel keeps (non-secret), and the credentials it may hold. */
const CONFIG_KEYS: Record<string, string[]> = {
  email: ['from'],
  whatsapp: ['phoneNumberId', 'wabaId', 'graphVersion'],
  instagram: ['pageId', 'graphVersion'],
  webhook: ['url'],
  sms: [],
};
const SECRET_KEYS: Record<string, string[]> = {
  email: ['apiKey'],
  whatsapp: ['accessToken', 'appSecret', 'verifyToken'],
  instagram: ['accessToken', 'appSecret', 'verifyToken'],
  webhook: ['signingSecret'],
  sms: [],
};

export const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  config: z.record(z.string(), z.string().max(500).nullable()).optional(),
  /** Only the credentials given are replaced; empty ones are left as they are. */
  secrets: z.record(z.string(), z.string().max(4000)).optional(),
});

async function row(tx: Tx, tenantId: string, id: string) {
  const r = await tx.one<ChannelAccount & { name: string; status: string; inbound_key: string }>(`select * from channel_accounts where tenant_id = $1 and id = $2`, [tenantId, id]);
  if (!r) throw notFound('Channel not found');
  return r;
}

async function secretsOf(env: Env, acc: ChannelAccount): Promise<Record<string, string>> {
  if (!acc.secret_ciphertext) return {};
  if (!env.DATA_ENCRYPTION_KEY) throw new ApiError(500, 'not_configured', 'DATA_ENCRYPTION_KEY secret is not set');
  try {
    return JSON.parse(await decryptSecret(env.DATA_ENCRYPTION_KEY, acc.secret_ciphertext, acc.tenant_id)) as Record<string, string>;
  } catch {
    // the encryption key changed since it was saved: start again with what is entered now
    return {};
  }
}

/** Which credentials are stored (names only — values never leave the server). */
export async function storedSecretNames(env: Env, acc: ChannelAccount) {
  return Object.entries(await secretsOf(env, acc))
    .filter(([, v]) => !!v)
    .map(([k]) => k);
}

export async function updateChannel(env: Env, tx: Tx, tenantId: string, id: string, input: z.infer<typeof updateChannelSchema>) {
  const acc = await row(tx, tenantId, id);
  const allowedCfg = CONFIG_KEYS[acc.channel] ?? [];
  const config: Record<string, unknown> = { ...acc.config };
  for (const [k, v] of Object.entries(input.config ?? {})) {
    if (!allowedCfg.includes(k)) throw badRequest(`"${k}" is not a setting of a ${acc.channel} channel`);
    if (v === null || v.trim() === '') {
      if (k === 'phoneNumberId' || k === 'pageId' || k === 'url' || k === 'from') throw badRequest(`${k} can't be empty`);
      delete config[k];
    } else config[k] = v.trim();
  }
  if (input.config && (input.config.phoneNumberId || input.config.wabaId)) delete config.check; // details of the old number
  if (config.phoneNumberId && acc.channel === 'whatsapp') {
    const dup = await tx.one(`select 1 from channel_accounts where tenant_id = $1 and id <> $2 and channel = 'whatsapp' and config ->> 'phoneNumberId' = $3`, [tenantId, id, String(config.phoneNumberId)]);
    if (dup) throw conflict('Another WhatsApp channel already uses this phone number ID');
  }
  let cipher = acc.secret_ciphertext;
  const given = Object.entries(input.secrets ?? {}).filter(([, v]) => v.trim() !== '');
  if (given.length) {
    const allowed = SECRET_KEYS[acc.channel] ?? [];
    for (const [k] of given) if (!allowed.includes(k)) throw badRequest(`"${k}" is not a credential of a ${acc.channel} channel`);
    if (!env.DATA_ENCRYPTION_KEY) throw new ApiError(500, 'not_configured', 'DATA_ENCRYPTION_KEY secret is not set');
    const merged = { ...(await secretsOf(env, acc)), ...Object.fromEntries(given.map(([k, v]) => [k, v.trim()])) };
    cipher = await encryptSecret(env.DATA_ENCRYPTION_KEY, JSON.stringify(merged), tenantId);
    delete config.check; // a new token: check again
  }
  await tx.query(`update channel_accounts set name = $3, status = $4, config = $5, secret_ciphertext = $6, updated_at = now() where tenant_id = $1 and id = $2`, [
    tenantId, id, input.name ?? (acc as { name: string }).name, input.status ?? acc.status, JSON.stringify(config), cipher,
  ]);
  return { ok: true };
}

export async function newInboundAddress(tx: Tx, tenantId: string, id: string) {
  await row(tx, tenantId, id);
  const r = await tx.one<{ inbound_key: string }>(`update channel_accounts set inbound_key = encode(gen_random_bytes(18), 'hex'), updated_at = now() where tenant_id = $1 and id = $2 returning inbound_key`, [tenantId, id]);
  return r!;
}

type Check = { label: string; ok: boolean; detail?: string; fix?: 'subscribe' | 'token' | 'app_secret' | 'verify_token' | 'waba' };
export interface CheckResult {
  ok: boolean;
  at: string;
  checks: Check[];
  info?: Record<string, unknown>;
  numbers?: { id: string; display: string; name: string | null; quality: string | null; connectedAs: string | null }[];
}

const TOKEN_HINT = ' — make a permanent token: Meta Business settings → System users → Generate token (whatsapp_business_messaging, whatsapp_business_management), then paste it under Edit → Access token.';

function graphError(e: unknown) {
  const m = (e as Error).message ?? String(e);
  return /expired|session|OAuthException|invalid.*token|Error validating access token|190/i.test(m) ? `${m.replace(/^WhatsApp: /, '')}${TOKEN_HINT}` : m.replace(/^WhatsApp: /, '');
}

/** Checks the connection with the provider; stores a summary on the channel. Called outside any transaction. */
export async function checkChannel(env: Env, db: Db, tenantId: string, userId: string | null, id: string): Promise<CheckResult> {
  const sc = { tenantId, userId };
  const acc = await db.tx({ ...sc, readOnly: true }, (tx) => row(tx, tenantId, id));
  const others = await db.tx({ ...sc, readOnly: true }, (tx) =>
    tx.query<{ id: string; name: string; pid: string }>(`select id, name, config ->> 'phoneNumberId' as pid from channel_accounts where tenant_id = $1 and channel = 'whatsapp'`, [tenantId]),
  );
  const secrets = await secretsOf(env, acc);
  const checks: Check[] = [];
  const info: Record<string, unknown> = {};
  let numbers: CheckResult['numbers'];
  const cfg = acc.config as Record<string, string | undefined>;

  if (acc.channel === 'whatsapp' || acc.channel === 'instagram') {
    if (!secrets.accessToken) checks.push({ label: 'Access token', ok: false, detail: 'Not saved', fix: 'token' });
    if (!secrets.appSecret) checks.push({ label: 'App secret', ok: false, detail: 'Not saved: incoming messages can\'t be verified as coming from Meta', fix: 'app_secret' });
    if (!secrets.verifyToken) checks.push({ label: 'Webhook verify token', ok: false, detail: 'Not saved: Meta can\'t verify the callback URL', fix: 'verify_token' });
  }

  if (acc.channel === 'whatsapp' && secrets.accessToken) {
    try {
      const n = await waFetch<Record<string, string>>(env, acc, `/${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,code_verification_status,platform_type,throughput,status`);
      Object.assign(info, { displayPhone: n.display_phone_number, verifiedName: n.verified_name, quality: n.quality_rating, nameStatus: n.name_status, platform: n.platform_type, numberStatus: n.status });
      const live = n.platform_type ? n.platform_type === 'CLOUD_API' : true;
      checks.push({ label: 'Phone number', ok: live, detail: `${n.display_phone_number ?? cfg.phoneNumberId}${n.verified_name ? ` · ${n.verified_name}` : ''}${n.quality_rating ? ` · quality ${n.quality_rating}` : ''}${live ? '' : ' · not registered for the Cloud API'}` });
      if (n.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(n.name_status)) checks.push({ label: 'Display name', ok: false, detail: `Meta review: ${n.name_status.toLowerCase().replace(/_/g, ' ')}` });
    } catch (e) {
      checks.push({ label: 'Phone number', ok: false, detail: graphError(e), fix: /token/i.test(graphError(e)) ? 'token' : undefined });
    }
    if (!cfg.wabaId) checks.push({ label: 'WhatsApp Business Account ID', ok: false, detail: 'Not set: needed for templates, other numbers and the webhook subscription', fix: 'waba' });
    else {
      try {
        const list = await waFetch<{ data?: Record<string, string>[] }>(env, acc, `/${cfg.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&limit=50`);
        numbers = (list.data ?? []).map((x) => {
          const used = others.find((o) => o.pid === x.id);
          return { id: x.id!, display: x.display_phone_number ?? x.id!, name: x.verified_name ?? null, quality: x.quality_rating ?? null, connectedAs: used ? used.name : null };
        });
        checks.push({ label: 'Business account', ok: true, detail: `${numbers.length} number${numbers.length === 1 ? '' : 's'}` });
        if (numbers.length && !numbers.some((x) => x.id === cfg.phoneNumberId)) checks.push({ label: 'Phone number ID', ok: false, detail: 'This number is not in the business account set here' });
      } catch (e) {
        checks.push({ label: 'Business account', ok: false, detail: graphError(e) });
      }
      try {
        const subs = await waFetch<{ data?: unknown[] }>(env, acc, `/${cfg.wabaId}/subscribed_apps`);
        const on = (subs.data ?? []).length > 0;
        checks.push({ label: 'Incoming messages (app subscribed to the account)', ok: on, detail: on ? 'Subscribed' : 'Not subscribed: Meta sends no messages until the app is subscribed', fix: on ? undefined : 'subscribe' });
      } catch (e) {
        checks.push({ label: 'Incoming messages (app subscribed to the account)', ok: false, detail: graphError(e) });
      }
    }
  }

  if (acc.channel === 'instagram' && secrets.accessToken) {
    try {
      const p = await waFetch<{ name?: string; instagram_business_account?: { id: string } }>(env, acc, `/${cfg.pageId}?fields=name,instagram_business_account`);
      checks.push({ label: 'Facebook page', ok: true, detail: p.name ?? cfg.pageId });
      checks.push({ label: 'Linked Instagram account', ok: !!p.instagram_business_account, detail: p.instagram_business_account ? p.instagram_business_account.id : 'No Instagram professional account is linked to this page' });
      Object.assign(info, { pageName: p.name });
    } catch (e) {
      checks.push({ label: 'Facebook page', ok: false, detail: graphError(e), fix: 'token' });
    }
  }

  if (acc.channel === 'email') {
    if (!secrets.apiKey) checks.push({ label: 'Resend API key', ok: false, detail: 'Not saved', fix: 'token' });
    else {
      try {
        const res = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${secrets.apiKey}` } });
        const j = (await res.json().catch(() => ({}))) as { data?: { name: string; status: string }[]; message?: string };
        if (!res.ok) {
          // a "sending access" key can't list domains: it still sends
          if (res.status === 401 && /restricted/i.test(j.message ?? '')) checks.push({ label: 'Resend API key', ok: true, detail: 'Valid (sending only)' });
          else checks.push({ label: 'Resend API key', ok: false, detail: j.message ?? `HTTP ${res.status}`, fix: 'token' });
        } else {
          checks.push({ label: 'Resend API key', ok: true, detail: 'Valid' });
          const domain = /@([^>\s]+)>?\s*$/.exec(String(cfg.from ?? ''))?.[1]?.toLowerCase();
          const d = (j.data ?? []).find((x) => x.name.toLowerCase() === domain);
          checks.push({ label: 'Sending domain', ok: d?.status === 'verified', detail: !domain ? 'Set a From address' : d ? `${domain}: ${d.status}` : `${domain} is not added in Resend → Domains` });
        }
      } catch (e) {
        checks.push({ label: 'Resend', ok: false, detail: (e as Error).message });
      }
    }
  }

  if (acc.channel === 'webhook') checks.push({ label: 'Endpoint', ok: /^https:\/\//.test(String(cfg.url ?? '')), detail: String(cfg.url ?? 'Not set') });
  if (acc.status === 'disabled') checks.push({ label: 'Status', ok: false, detail: 'Paused: nothing is sent or received' });

  const result: CheckResult = { ok: checks.every((c) => c.ok), at: new Date().toISOString(), checks, info, numbers };
  await db.tx(sc, (tx) =>
    tx.query(`update channel_accounts set config = config || jsonb_build_object('check', $3::jsonb) where tenant_id = $1 and id = $2`, [tenantId, id, JSON.stringify({ ok: result.ok, at: result.at, info, problems: checks.filter((c) => !c.ok).map((c) => c.label) })]),
  );
  return result;
}

/** Subscribes the Meta app to the WhatsApp Business Account, so incoming messages are delivered. */
export async function subscribeApp(env: Env, db: Db, tenantId: string, userId: string | null, id: string) {
  const acc = await db.tx({ tenantId, userId, readOnly: true }, (tx) => row(tx, tenantId, id));
  if (acc.channel !== 'whatsapp') throw badRequest('Only for WhatsApp');
  const waba = String(acc.config.wabaId ?? '');
  if (!waba) throw badRequest('Set the WhatsApp Business Account ID first (Edit)');
  await waFetch(env, acc, `/${waba}/subscribed_apps`, { method: 'POST', body: {} });
  return { ok: true };
}

export const addNumberSchema = z.object({ phoneNumberId: z.string().trim().regex(/^\d{3,30}$/, 'A phone number ID is digits'), name: z.string().trim().min(1).max(80) });

/** Another number of the same business account: a new channel with the same credentials. */
export async function addNumber(tx: Tx, tenantId: string, id: string, input: z.infer<typeof addNumberSchema>) {
  const acc = await row(tx, tenantId, id);
  if (acc.channel !== 'whatsapp') throw badRequest('Only for WhatsApp');
  const dup = await tx.one(`select 1 from channel_accounts where tenant_id = $1 and channel = 'whatsapp' and config ->> 'phoneNumberId' = $2`, [tenantId, input.phoneNumberId]);
  if (dup) throw conflict('This number is already connected');
  const config = { ...acc.config, phoneNumberId: input.phoneNumberId };
  delete (config as Record<string, unknown>).check;
  return tx.one<{ id: string }>(`insert into channel_accounts (tenant_id, channel, name, provider, config, secret_ciphertext) values ($1,'whatsapp',$2,$3,$4,$5) returning id`, [
    tenantId, input.name, acc.provider, JSON.stringify(config), acc.secret_ciphertext,
  ]);
}
