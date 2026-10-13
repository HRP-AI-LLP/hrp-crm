/**
 * Multi-channel communication engine. Providers are adapters behind one interface:
 *   email:    resend (free tier) | webhook relay
 *   whatsapp: meta_cloud (WhatsApp Cloud API)
 *   webhook:  generic HTTPS endpoint (n8n, Zapier, Make, custom)
 * Credentials are stored AES-GCM encrypted (tenant id as AAD) in channel_accounts.secret_ciphertext.
 */
import type { Env } from '../env';
import { decryptSecret, hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Tx } from '../lib/db';

export interface ChannelAccount {
  id: string;
  tenant_id: string;
  channel: 'email' | 'whatsapp' | 'sms' | 'webhook';
  provider: string;
  config: Record<string, unknown>;
  secret_ciphertext: string | null;
}

export interface OutboundMessage {
  to: string;
  subject?: string | null;
  body: string;
}

async function secretOf(env: Env, acc: ChannelAccount): Promise<Record<string, string>> {
  if (!acc.secret_ciphertext) return {};
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is not configured');
  return JSON.parse(await decryptSecret(env.DATA_ENCRYPTION_KEY, acc.secret_ciphertext, acc.tenant_id)) as Record<string, string>;
}

export async function sendViaChannel(env: Env, acc: ChannelAccount, msg: OutboundMessage): Promise<{ externalId: string | null }> {
  const secret = await secretOf(env, acc);
  switch (`${acc.channel}:${acc.provider}`) {
    case 'email:resend': {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: acc.config.from, to: [msg.to], subject: msg.subject ?? '(no subject)', text: msg.body }),
      });
      if (!res.ok) throw new Error(`resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { id?: string };
      return { externalId: j.id ?? null };
    }
    case 'whatsapp:meta_cloud': {
      const version = String(acc.config.graphVersion ?? 'v21.0');
      const res = await fetch(`https://graph.facebook.com/${version}/${acc.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: msg.to.replace(/[^0-9]/g, ''), type: 'text', text: { body: msg.body } }),
      });
      if (!res.ok) throw new Error(`whatsapp HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { messages?: { id: string }[] };
      return { externalId: j.messages?.[0]?.id ?? null };
    }
    case 'email:webhook':
    case 'webhook:generic':
    case 'sms:webhook': {
      const body = JSON.stringify({ channel: acc.channel, ...msg });
      const sig = secret.signingSecret ? await hmacSha256Hex(secret.signingSecret, body) : undefined;
      const res = await fetch(String(acc.config.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sig ? { 'x-synapse-signature': `sha256=${sig}` } : {}) },
        body,
      });
      if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      return { externalId: null };
    }
    default:
      throw new Error(`Unsupported channel provider ${acc.channel}:${acc.provider}`);
  }
}

/** Meta webhook signature: X-Hub-Signature-256 = sha256=HMAC(appSecret, rawBody) */
export async function verifyMetaSignature(env: Env, acc: ChannelAccount, rawBody: string, header: string | null): Promise<boolean> {
  const secret = await secretOf(env, acc);
  if (!secret.appSecret) return false;
  if (!header?.startsWith('sha256=')) return false;
  return timingSafeEqual(header.slice(7), await hmacSha256Hex(secret.appSecret, rawBody));
}

export async function webhookVerifyToken(env: Env, acc: ChannelAccount): Promise<string | undefined> {
  return (await secretOf(env, acc)).verifyToken;
}

export interface InboundItem {
  from: string;
  name?: string;
  text: string;
  subject?: string;
  externalId?: string;
}

/** Normalises provider payloads into inbound items. */
export function parseInbound(acc: ChannelAccount, payload: unknown): InboundItem[] {
  const p = payload as Record<string, unknown>;
  if (acc.channel === 'whatsapp') {
    const items: InboundItem[] = [];
    const entries = (p.entry as { changes?: { value?: { contacts?: { profile?: { name?: string }; wa_id?: string }[]; messages?: { from: string; id: string; type: string; text?: { body: string } }[] } }[] }[]) ?? [];
    for (const e of entries)
      for (const ch of e.changes ?? []) {
        const names = new Map((ch.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of ch.value?.messages ?? []) {
          items.push({ from: m.from, name: names.get(m.from) ?? undefined, text: m.type === 'text' ? (m.text?.body ?? '') : `[${m.type} message]`, externalId: m.id });
        }
      }
    return items;
  }
  // email / generic: { from, name?, subject?, text }
  if (typeof p.from === 'string' && (typeof p.text === 'string' || typeof p.body === 'string')) {
    return [{ from: p.from, name: typeof p.name === 'string' ? p.name : undefined, subject: typeof p.subject === 'string' ? p.subject : undefined, text: String(p.text ?? p.body), externalId: typeof p.id === 'string' ? p.id : undefined }];
  }
  return [];
}

/** Finds the contact or lead an inbound sender belongs to, creating a lead if unknown. */
export async function matchOrCreateSender(tx: Tx, tenantId: string, channel: string, item: InboundItem, defaultOwner: string | null) {
  const isEmail = item.from.includes('@');
  const key = isEmail ? item.from.toLowerCase() : item.from.replace(/[^0-9]/g, '').slice(-10);
  const contact = isEmail
    ? await tx.one<{ id: string }>(`select id from contacts where tenant_id = $1 and lower(email) = $2 and deleted_at is null limit 1`, [tenantId, key])
    : await tx.one<{ id: string }>(`select id from contacts where tenant_id = $1 and right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2 and deleted_at is null limit 1`, [tenantId, key]);
  if (contact) return { objectKey: 'contact', id: contact.id, created: false };
  const lead = isEmail
    ? await tx.one<{ id: string }>(`select id from leads where tenant_id = $1 and lower(email) = $2 and deleted_at is null order by created_at desc limit 1`, [tenantId, key])
    : await tx.one<{ id: string }>(`select id from leads where tenant_id = $1 and right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $2 and deleted_at is null order by created_at desc limit 1`, [tenantId, key]);
  if (lead) return { objectKey: 'lead', id: lead.id, created: false };

  const [first, ...rest] = (item.name ?? '').trim().split(/\s+/).filter(Boolean);
  const stage = await tx.one<{ pipeline_id: string; id: string }>(
    `select s.pipeline_id, s.id from pipelines p join pipeline_stages s on s.tenant_id = p.tenant_id and s.pipeline_id = p.id
      where p.tenant_id = $1 and p.object_key = 'lead' and p.is_default and s.category = 'open' order by s.position limit 1`,
    [tenantId],
  );
  const created = await tx.one<{ id: string }>(
    `insert into leads (tenant_id, first_name, last_name, email, phone, source, pipeline_id, stage_id, owner_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [tenantId, rest.length ? first : null, rest.length ? rest.join(' ') : (first ?? (isEmail ? item.from : `WhatsApp ${item.from}`)), isEmail ? key : null, isEmail ? null : `+${item.from.replace(/[^0-9]/g, '')}`, channel === 'whatsapp' ? 'whatsapp' : 'other', stage?.pipeline_id ?? null, stage?.id ?? null, defaultOwner],
  );
  return { objectKey: 'lead', id: created!.id, created: true };
}
