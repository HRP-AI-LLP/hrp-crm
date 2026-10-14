/**
 * Telephony through Exotel (India's most used cloud telephony).
 *
 *   click-to-call  Exotel rings the salesperson's own phone first, then connects the customer from
 *                  the workspace's ExoPhone; the customer never sees the personal number
 *   status         Exotel's status callback fills in outcome, duration and the recording link
 *   inbound        a Passthru applet in the Exotel call flow reports every incoming call; it is
 *                  logged on the caller's record, unknown callers can become leads, and missed calls
 *                  create a call-back task for the owner
 *
 * Callbacks are not signed by Exotel; they are accepted only at the workspace's unguessable route
 * key, and status updates only for call ids this workspace started.
 */
import type { Env } from '../env';
import type { Tx } from '../lib/db';
import { badRequest } from '../lib/errors';
import { claimRef, form, type Integration, markOk, ProviderError, providerFetch, readSecret, refOf } from './integrations';
import { createRecord, loadRow, type RecordCtx, type RecordEvent } from './records';
import { systemPrincipal } from './system';

export interface ExotelSecret {
  apiKey: string;
  apiToken: string;
}

const host = (i: Integration) => (i.config.subdomain === 'api.in.exotel.com' ? 'api.in.exotel.com' : 'api.exotel.com');
const auth = (s: ExotelSecret) => `Basic ${btoa(`${s.apiKey}:${s.apiToken}`)}`;
export const phoneKey = (p: string | null | undefined) => (p ?? '').replace(/\D/g, '').slice(-10) || null;
const e164ish = (p: string) => {
  const d = p.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return `0${d}`; // Exotel accepts 0-prefixed Indian numbers
  return d;
};

export async function verifyExotel(sid: string, s: ExotelSecret, subdomain: string) {
  try {
    await providerFetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(sid)}.json`, { headers: { authorization: auth(s) } });
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw badRequest('Exotel rejected these credentials — check the API key, token and SID under Exotel → Settings → API');
    throw badRequest(`Could not check the account with Exotel: ${(e as Error).message}`);
  }
}

interface Party {
  object: 'lead' | 'contact' | 'account';
  id: string;
  name: string;
  owner_id: string | null;
  phone: string | null;
}

export async function findByPhone(tx: Tx, tenantId: string, phone: string): Promise<Party | null> {
  const k = phoneKey(phone);
  if (!k || k.length < 8) return null;
  return tx.one<Party>(
    `select * from (
       select 'contact' as object, id, full_name as name, owner_id, phone, 1 as pri from contacts where tenant_id = $1 and deleted_at is null and app.phone_key(phone) = $2
       union all select 'lead', id, full_name, owner_id, phone, 2 from leads where tenant_id = $1 and deleted_at is null and converted_at is null and app.phone_key(phone) = $2
       union all select 'account', id, name, owner_id, phone, 3 from accounts where tenant_id = $1 and deleted_at is null and app.phone_key(phone) = $2
     ) x order by pri limit 1`,
    [tenantId, k],
  );
}

/** Click-to-call: rings the agent, then the customer. */
export async function clickToCall(env: Env, ctx: RecordCtx, i: Integration, target: { object: string; id: string; phone?: string | null }, callbackBase: string) {
  if (!['lead', 'contact', 'account', 'deal', 'ticket'].includes(target.object)) throw badRequest('Calls can be placed from leads, contacts, accounts, deals and tickets');
  const { row } = await loadRow(ctx, target.object, target.id, 'read');
  const me = await ctx.tx.one<{ phone: string | null }>(`select phone from users where tenant_id = $1 and id = $2`, [ctx.tenantId, ctx.principal.user.id]);
  if (!me?.phone) throw badRequest('Add your phone number in My account first — Synapse rings it before connecting the customer');
  let to = target.phone ?? (row.phone as string | null) ?? (row.customer_phone as string | null) ?? null;
  if (!to && target.object === 'deal' && row.contact_id) to = (await ctx.tx.one<{ phone: string | null }>(`select phone from contacts where tenant_id = $1 and id = $2`, [ctx.tenantId, row.contact_id]))?.phone ?? null;
  if (!to || (phoneKey(to)?.length ?? 0) < 8) throw badRequest('This record has no phone number to call');
  if (!i.config.callerId) throw badRequest('Set the ExoPhone (caller ID) for Exotel in Settings → Integrations');
  const s = await readSecret<ExotelSecret>(env, i);
  const act = await ctx.tx.one<{ id: string }>(
    `insert into activities (tenant_id, kind, subject, direction, related_object, related_id, metadata) values ($1,'call',$2,'out',$3,$4,$5) returning id`,
    [ctx.tenantId, `Call to ${String(row.full_name ?? row.name ?? to)}`, target.object, target.id, JSON.stringify({ provider: 'exotel', status: 'ringing', to: phoneKey(to), from: phoneKey(me.phone) })],
  );
  let r: any;
  try {
    r = await providerFetch(`https://${host(i)}/v1/Accounts/${encodeURIComponent(i.account_ref)}/Calls/connect.json`, {
      method: 'POST',
      headers: { authorization: auth(s), 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        From: e164ish(me.phone),
        To: e164ish(to),
        CallerId: String(i.config.callerId),
        CallType: 'trans',
        Record: i.config.record === false ? 'false' : 'true',
        TimeLimit: '3600',
        CustomField: act!.id,
        StatusCallback: `${callbackBase}/status`,
        'StatusCallbackEvents[0]': 'terminal',
        StatusCallbackContentType: 'application/json',
      }),
    });
  } catch (e) {
    throw badRequest(`Exotel could not place the call: ${(e as Error).message}`);
  }
  const sid = String(r?.Call?.Sid ?? '');
  if (sid) {
    await claimRef(ctx.tx, ctx.tenantId, 'exotel_call', sid, 'activity', act!.id);
    await ctx.tx.query(`update activities set metadata = metadata || $3::jsonb where tenant_id = $1 and id = $2`, [ctx.tenantId, act!.id, JSON.stringify({ sid })]);
  }
  return { activityId: act!.id, sid };
}

const OUTCOME: Record<string, string> = { completed: 'Connected', busy: 'Busy', 'no-answer': 'No answer', failed: 'Failed', canceled: 'Cancelled', 'call-attempt': 'Missed' };

/** Exotel status callback for a call we placed. */
export async function applyExotelStatus(tx: Tx, i: Integration, b: Record<string, any>) {
  const sid = String(b.CallSid ?? '');
  if (!sid) return false;
  const ref = await refOf(tx, i.tenant_id, 'exotel_call', sid);
  if (!ref) return false;
  const status = String(b.Status ?? b.CallStatus ?? '').toLowerCase();
  const legs = Array.isArray(b.Legs) ? b.Legs : [];
  const duration = Number(b.ConversationDuration ?? b.DialCallDuration ?? b.Duration ?? 0) || 0;
  await tx.query(
    `update activities set metadata = metadata || $3::jsonb, body = $4 where tenant_id = $1 and id = $2`,
    [
      i.tenant_id,
      ref.record_id,
      JSON.stringify({ status, durationSeconds: duration, recordingUrl: typeof b.RecordingUrl === 'string' && b.RecordingUrl.startsWith('https://') ? b.RecordingUrl : null, legs: legs.map((l: any) => ({ status: l.Status ?? null })) }),
      `${OUTCOME[status] ?? status}${duration ? ` · ${Math.floor(duration / 60)}m ${duration % 60}s` : ''}`,
    ],
  );
  await markOk(tx, i, { event: true });
  return true;
}

/** Exotel Passthru for incoming calls (query string or form body). */
export async function logIncomingCall(ctx: Omit<RecordCtx, 'principal'>, i: Integration, p: Record<string, string>): Promise<RecordEvent[]> {
  const sid = p.CallSid;
  const from = p.CallFrom ?? p.From ?? '';
  if (!sid || !from) return [];
  const placeholder = crypto.randomUUID();
  if (!(await claimRef(ctx.tx, ctx.tenantId, 'exotel_call', sid, 'activity', placeholder))) return [];
  const dial = String(p.DialCallStatus ?? p.Status ?? p.CallStatus ?? '').toLowerCase();
  const missed = ['no-answer', 'busy', 'failed', 'canceled', ''].includes(dial) || p.CallType === 'call-attempt' || p.CallType === 'incomplete';
  const duration = Number(p.DialCallDuration ?? p.ConversationDuration ?? 0) || 0;
  let party = await findByPhone(ctx.tx, ctx.tenantId, from);
  let events: RecordEvent[] = [];
  if (!party && i.config.createLeads !== false) {
    const owner = (i.config.ownerId as string | undefined) ?? (await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [ctx.tenantId]))?.id ?? null;
    const principal = systemPrincipal(owner, ctx.meta.objects.map((o) => o.key));
    const r = await createRecord(
      { ...ctx, principal },
      'lead',
      { last_name: `Caller ${phoneKey(from)?.slice(-4) ?? ''}`.trim(), phone: from, source: 'phone_call', source_detail: `Called ${p.CallTo ?? p.To ?? 'your number'}`.slice(0, 250), next_follow_up_at: new Date().toISOString(), ...(i.config.ownerId ? { owner_id: i.config.ownerId } : {}) },
      { bypassPermissions: true, autoAssign: !i.config.ownerId },
    );
    events = r.events;
    party = { object: 'lead', id: r.record.id, name: String(r.record.title ?? 'Caller'), owner_id: (r.record.owner_id as string | null) ?? owner, phone: from };
  }
  const answeredBy = p.DialWhomNumber ? phoneKey(p.DialWhomNumber) : null;
  const agent = answeredBy ? await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and app.phone_key(phone) = $2 limit 1`, [ctx.tenantId, answeredBy]) : null;
  const meta = {
    provider: 'exotel',
    sid,
    status: missed ? 'missed' : 'completed',
    from: phoneKey(from),
    to: phoneKey(p.CallTo ?? p.To),
    durationSeconds: duration,
    recordingUrl: typeof p.RecordingUrl === 'string' && p.RecordingUrl.startsWith('https://') ? p.RecordingUrl : null,
    answeredBy: agent?.id ?? null,
  };
  if (party) {
    const act = await ctx.tx.one<{ id: string }>(
      `insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, actor_id, metadata) values ($1,'call',$2,$3,'in',$4,$5,$6,$7) returning id`,
      [ctx.tenantId, missed ? `Missed call from ${party.name}` : `Call from ${party.name}`, missed ? 'Missed' : `Connected${duration ? ` · ${Math.floor(duration / 60)}m ${duration % 60}s` : ''}`, party.object, party.id, agent?.id ?? null, JSON.stringify(meta)],
    );
    await ctx.tx.query(`update external_refs set record_id = $4 where tenant_id = $1 and provider = 'exotel_call' and external_id = $3 and record_id = $2`, [ctx.tenantId, placeholder, sid, act!.id]);
    if (missed && party.owner_id) {
      await ctx.tx.query(
        `insert into tasks (tenant_id, title, description, priority, due_at, assignee_id, related_object, related_id, source) values ($1,$2,$3,'high',now(),$4,$5,$6,'telephony')`,
        [ctx.tenantId, `Call back ${party.name}`, `Missed call from ${from} at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, party.owner_id, party.object, party.id],
      );
      await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'call',$3,$4,$5)`, [
        ctx.tenantId, party.owner_id, `Missed call: ${party.name}`, from, `/o/${party.object}/${party.id}`,
      ]);
    }
  }
  return events;
}
