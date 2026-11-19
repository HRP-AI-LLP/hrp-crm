/**
 * Call invites from the person's connected mailbox (Gmail / Outlook): meetings in their calendar
 * from a week back to a month ahead — invites they received or sent outside Synapse — become calls,
 * filed on the project their title or attendees point to (else "Not filed"). A Zoom / Meet / Teams
 * link in the invite ties the call to that app, so the transcript is picked up when the person has
 * that meeting account connected. Runs with the mailbox sync and on demand.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { parseJoinUrl } from './calls';
import { type Integration, mailboxToken, providerFetch } from './integrations';
import { matchProject, type OnlineMeeting } from './meetings';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

export interface Invite {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  description: string | null;
  joinUrl: string | null;
  attendees: { email: string; name: string | null }[];
  cancelled: boolean;
  declined: boolean;
}

/** The first Zoom / Meet / Teams link in an invite. */
export function meetingLink(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) for (const m of String(t ?? '').matchAll(URL_RE)) if (parseJoinUrl(m[0].replace(/[.,;]+$/, ''))) return m[0].replace(/[.,;]+$/, '');
  return null;
}

async function googleInvites(token: string, from: Date, to: Date): Promise<Invite[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '150', showDeleted: 'true' });
  const r = await providerFetch<{ items?: any[] }>(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { authorization: `Bearer ${token}` } });
  return (r.items ?? [])
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({
      id: String(e.id),
      title: String(e.summary ?? 'Meeting'),
      startsAt: new Date(e.start.dateTime).toISOString(),
      endsAt: new Date(e.end.dateTime).toISOString(),
      location: e.location ?? null,
      description: e.description ?? null,
      joinUrl: e.hangoutLink ?? (e.conferenceData?.entryPoints ?? []).find((p: any) => p.entryPointType === 'video')?.uri ?? meetingLink(e.location, e.description),
      attendees: (e.attendees ?? []).filter((a: any) => a.email && !a.self && !a.resource).map((a: any) => ({ email: String(a.email).toLowerCase(), name: a.displayName ?? null })),
      cancelled: e.status === 'cancelled',
      declined: (e.attendees ?? []).some((a: any) => a.self && a.responseStatus === 'declined'),
    }));
}

async function graphInvites(token: string, from: Date, to: Date): Promise<Invite[]> {
  const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '150', $select: 'id,subject,bodyPreview,start,end,location,attendees,isOnlineMeeting,onlineMeeting,isCancelled,isAllDay,responseStatus,organizer' });
  const r = await providerFetch<{ value?: any[] }>(`${GRAPH}/me/calendarView?${q}`, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' } });
  return (r.value ?? [])
    .filter((e) => !e.isAllDay)
    .map((e) => ({
      id: String(e.id),
      title: String(e.subject ?? 'Meeting'),
      startsAt: new Date(`${String(e.start.dateTime).replace(/Z$/, '')}Z`).toISOString(),
      endsAt: new Date(`${String(e.end.dateTime).replace(/Z$/, '')}Z`).toISOString(),
      location: e.location?.displayName ?? null,
      description: e.bodyPreview ?? null,
      joinUrl: e.onlineMeeting?.joinUrl ?? meetingLink(e.location?.displayName, e.bodyPreview),
      attendees: [...(e.attendees ?? []), ...(e.organizer ? [e.organizer] : [])]
        .map((a: any) => ({ email: String(a.emailAddress?.address ?? '').toLowerCase(), name: a.emailAddress?.name ?? null }))
        .filter((a: { email: string }) => a.email),
      cancelled: !!e.isCancelled,
      declined: e.responseStatus?.response === 'declined',
    }));
}

/**
 * Files one mailbox's calendar invites as calls. Only meetings that look like calls count: with a
 * Zoom / Meet / Teams link, or with someone from outside the workspace.
 */
export async function syncInvites(env: Env, tx: Tx, i: Integration): Promise<{ found: number; added: number; updated: number }> {
  if (!i.user_id || i.config?.invites === false) return { found: 0, added: 0, updated: 0 };
  const token = await mailboxToken(env, tx, i);
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 30 * 86_400_000);
  const list = i.provider === 'google' ? await googleInvites(token, from, to) : await graphInvites(token, from, to);
  const self = (i.account_ref ?? '').toLowerCase();
  const colleagues = new Set((await tx.query<{ email: string }>(`select lower(email) as email from users where tenant_id = $1 and email is not null`, [i.tenant_id])).map((u) => u.email));
  const myApps = await tx.query<{ id: string; provider: string; account_ref: string }>(`select id, provider, account_ref from integrations where tenant_id = $1 and user_id = $2 and provider in ('zoom_meet','google_meet','ms_teams_meet') and status = 'active'`, [i.tenant_id, i.user_id]);
  let added = 0;
  let updated = 0;
  let found = 0;
  for (const inv of list) {
    const others = inv.attendees.filter((a) => a.email !== self);
    const external = others.some((a) => !colleagues.has(a.email));
    if (!inv.joinUrl && !external) continue;
    // calls Synapse itself put in the calendar
    if (/Scheduled from HRP Synapse/.test(inv.description ?? '')) continue;
    if (await tx.one(`select 1 from events where tenant_id = $1 and calendar_ref ->> 'id' = $2`, [i.tenant_id, inv.id])) continue;
    found++;
    const ref = `cal:${i.id}:${inv.id}`.slice(0, 300);
    const existing = await tx.one<{ id: string; related_id: string | null }>(`select id, related_id from events where tenant_id = $1 and external_ref = $2`, [i.tenant_id, ref]);
    const attendees = others.slice(0, 50).map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}) }));
    if (existing) {
      await tx.query(
        `update events set title = $3, starts_at = $4, ends_at = $5, attendees = $6, status = case when $7::boolean then 'cancelled' when status = 'cancelled' then 'scheduled' else status end, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [i.tenant_id, existing.id, inv.title.slice(0, 200), inv.startsAt, inv.endsAt, JSON.stringify(attendees), inv.cancelled || inv.declined],
      );
      updated++;
      continue;
    }
    if (inv.cancelled || inv.declined) continue;
    let online: OnlineMeeting | null = null;
    if (inv.joinUrl) {
      const p = parseJoinUrl(inv.joinUrl);
      if (p) {
        // the same meeting already came in from a meeting app, or was scheduled in Synapse
        const dup = await tx.one<{ id: string }>(
          `select id from events where tenant_id = $1 and online_meeting ->> 'joinUrl' = $2 and starts_at between $3::timestamptz - interval '1 day' and $3::timestamptz + interval '1 day'`,
          [i.tenant_id, p.joinUrl, inv.startsAt],
        );
        if (dup) {
          await tx.query(`update events set external_ref = coalesce(external_ref, $3) where tenant_id = $1 and id = $2`, [i.tenant_id, dup.id, ref]);
          continue;
        }
        const app = myApps.find((a) => a.provider === p.provider);
        online = { ...p, integrationId: app?.id ?? '', account: app?.account_ref ?? null };
      }
    }
    const project = await matchProject(tx, i.tenant_id, i.user_id, inv.title, others.map((a) => a.email));
    await tx.query(
      `insert into events (tenant_id, title, kind, starts_at, ends_at, description, location, related_object, related_id, owner_id, created_by, attendees, online_meeting, transcript_status, external_ref)
       values ($1,$2,'meeting',$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13)`,
      [
        i.tenant_id, inv.title.slice(0, 200), inv.startsAt, inv.endsAt, inv.description?.slice(0, 5000) ?? null, (inv.joinUrl ?? inv.location)?.slice(0, 300) ?? null, project ? 'project' : null, project, i.user_id,
        JSON.stringify(attendees), online ? JSON.stringify(online) : null, online?.integrationId && Date.parse(inv.endsAt) > Date.now() - 7 * 86_400_000 ? 'waiting' : 'none', ref,
      ],
    );
    added++;
  }
  return { found, added, updated };
}

/** "Check my invites now" from the Calls page. */
export async function syncMyInvites(env: Env, db: Db, tenantId: string, userId: string) {
  return db.tx({ tenantId, userId }, async (tx) => {
    const mb = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and user_id = $2 and provider in ('google','microsoft') and status <> 'disabled' limit 1`, [tenantId, userId]);
    if (!mb) return { mailbox: false, found: 0, added: 0, updated: 0 };
    return { mailbox: true, ...(await syncInvites(env, tx, mb)) };
  });
}
