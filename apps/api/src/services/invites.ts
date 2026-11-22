/**
 * Call invites from the person's connected mailbox (Gmail / Outlook): meetings in their calendar
 * from a week back to a month ahead — invites they received or sent outside SanchalanOS — become calls,
 * filed on the project their title or attendees point to (else "Not filed"). A Zoom / Meet / Teams
 * link in the invite ties the call to that app, so the transcript is picked up when the person has
 * that meeting account connected. Runs with the mailbox sync and on demand.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { parseJoinUrl } from './calls';
import { type Integration, mailboxOf, mailboxToken, providerFetch } from './integrations';
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
  /** iCalendar UID: the same meeting from the calendar and from an emailed .ics */
  uid?: string | null;
  source?: 'calendar' | 'email';
  /** iCalendar: which time of a recurring series this is */
  recurrenceId?: string | null;
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
      uid: e.iCalUID ?? null,
      source: 'calendar' as const,
    }));
}

async function graphInvites(token: string, from: Date, to: Date): Promise<Invite[]> {
  const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '150', $select: 'id,iCalUId,subject,bodyPreview,start,end,location,attendees,isOnlineMeeting,onlineMeeting,isCancelled,isAllDay,responseStatus,organizer' });
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
      uid: e.iCalUId ?? null,
      source: 'calendar' as const,
    }));
}

/* ───────────────────────── invitations attached to emails (.ics) ───────────────────────── */

const unescapeIcs = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const WINDOWS_TZ: Record<string, string> = {
  'India Standard Time': 'Asia/Kolkata', 'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'Singapore Standard Time': 'Asia/Singapore', 'Arabian Standard Time': 'Asia/Dubai', 'Tokyo Standard Time': 'Asia/Tokyo', 'AUS Eastern Standard Time': 'Australia/Sydney', 'China Standard Time': 'Asia/Shanghai',
};

/** Offset (minutes east of UTC) of an IANA zone at a moment. */
function zoneOffset(zone: string, at: Date): number | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/** An iCalendar date-time (with its TZID, the file's VTIMEZONE blocks as a fallback) → ISO. */
export function icsTime(value: string, params: Record<string, string>, zones: Map<string, number>): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m;
  const naive = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se);
  if (z || !params.TZID) return new Date(naive).toISOString();
  const tzid = params.TZID.replace(/^"|"$/g, '');
  const iana = WINDOWS_TZ[tzid] ?? tzid;
  let off = zoneOffset(iana, new Date(naive));
  if (off !== null) off = zoneOffset(iana, new Date(naive - off * 60_000)) ?? off;
  if (off === null) off = zones.get(tzid) ?? 0;
  return new Date(naive - off * 60_000).toISOString();
}

function icsDuration(v: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 3_600_000;
  return (((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 24 + +(m[3] ?? 0)) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_MS = 86_400_000;

/**
 * Start times of a recurring meeting (RRULE) that fall in [from, to]: FREQ DAILY / WEEKLY (BYDAY) /
 * MONTHLY (BYMONTHDAY, or BYDAY like 2TU / -1FR) / YEARLY, with INTERVAL, COUNT and UNTIL; EXDATEs
 * left out. Times keep the first meeting's clock time in UTC (India has no daylight saving).
 */
export function expandRrule(firstStart: number, rule: string, exdates: Set<number>, from: number, to: number): number[] {
  const r = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]));
  const freq = (r.FREQ ?? '').toUpperCase();
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? Date.parse(r.UNTIL.replace(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/, (_m, y, mo, d, h = '23', mi = '59', se = '59') => `${y}-${mo}-${d}T${h}:${mi}:${se}Z`)) : Infinity;
  const byday = (r.BYDAY ?? '').split(',').filter(Boolean);
  const first = new Date(firstStart);
  const tod = firstStart - Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const out: number[] = [];
  let n = 0;
  const take = (t: number) => {
    if (t < firstStart) return true;
    if (t > until || n >= count) return false;
    n++;
    if (t >= from && t <= to && !exdates.has(t)) out.push(t);
    return t <= to;
  };
  const dayStart = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  for (let step = 0; step < 3000; step++) {
    let cands: number[] = [];
    if (freq === 'DAILY') cands = [dayStart + step * interval * DAY_MS + tod];
    else if (freq === 'WEEKLY') {
      const weekStart = dayStart - first.getUTCDay() * DAY_MS + step * interval * 7 * DAY_MS;
      const days = byday.length ? byday.map((d) => DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0) : [first.getUTCDay()];
      cands = days.sort((a, b) => a - b).map((d) => weekStart + d * DAY_MS + tod);
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const months = freq === 'MONTHLY' ? step * interval : step * interval * 12;
      const y = first.getUTCFullYear() + Math.floor((first.getUTCMonth() + months) / 12);
      const m = (first.getUTCMonth() + months) % 12;
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const nth = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(byday[0] ?? '');
      if (nth) {
        const wd = DAYS.indexOf(nth[2]!);
        const k = Number(nth[1] ?? 1);
        const matches: number[] = [];
        for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) matches.push(d);
        const d = k > 0 ? matches[k - 1] : matches[matches.length + k];
        if (d) cands = [Date.UTC(y, m, d) + tod];
      } else {
        const md = Number(r.BYMONTHDAY ?? first.getUTCDate());
        const d = md < 0 ? dim + md + 1 : md;
        if (d >= 1 && d <= dim) cands = [Date.UTC(y, m, d) + tod];
      }
    } else return firstStart >= from && firstStart <= to ? [firstStart] : [];
    for (const t of cands) if (!take(t)) return out;
  }
  return out;
}

/**
 * The meetings in an .ics file. A recurring meeting gives each of its times between a week ago and a
 * month ahead (moved or cancelled single times — RECURRENCE-ID — replace theirs).
 */
export function parseIcs(text: string, window: { from: number; to: number } = { from: Date.now() - 7 * DAY_MS, to: Date.now() + 30 * DAY_MS }): Invite[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const method = (lines.find((l) => /^METHOD:/i.test(l)) ?? '').split(':')[1]?.trim().toUpperCase() ?? '';
  // VTIMEZONE: standard offset per TZID, for zone names Intl does not know
  const zones = new Map<string, number>();
  let tz: string | null = null;
  let inStd = false;
  for (const l of lines) {
    if (/^TZID:/i.test(l)) tz = l.slice(5).trim();
    else if (/^BEGIN:STANDARD/i.test(l)) inStd = true;
    else if (/^END:STANDARD/i.test(l)) inStd = false;
    else if (inStd && tz && /^TZOFFSETTO:/i.test(l)) {
      const o = /([+-])(\d{2})(\d{2})/.exec(l);
      if (o) zones.set(tz, (o[1] === '-' ? -1 : 1) * (+o[2]! * 60 + +o[3]!));
    }
  }
  const out: Invite[] = [];
  let ev: Record<string, { v: string; p: Record<string, string> }[]> | null = null;
  for (const l of lines) {
    if (/^BEGIN:VEVENT/i.test(l)) ev = {};
    else if (/^END:VEVENT/i.test(l) && ev) {
      const one = (k: string) => ev![k]?.[0];
      const start = one('DTSTART');
      const startsAt = start ? icsTime(start.v, start.p, zones) : null;
      if (startsAt && start!.p.VALUE !== 'DATE') {
        const end = one('DTEND');
        const endsAt = (end && icsTime(end.v, end.p, zones)) ?? new Date(Date.parse(startsAt) + icsDuration(one('DURATION')?.v ?? 'PT1H')).toISOString();
        const description = one('DESCRIPTION') ? unescapeIcs(one('DESCRIPTION')!.v) : null;
        const location = one('LOCATION') ? unescapeIcs(one('LOCATION')!.v) : null;
        const mail = (x: { v: string; p: Record<string, string> }) => ({ email: x.v.replace(/^mailto:/i, '').trim().toLowerCase(), name: x.p.CN ? x.p.CN.replace(/^"|"$/g, '') : null });
        const people = [...(ev.ORGANIZER ?? []), ...(ev.ATTENDEE ?? [])].map(mail).filter((a) => /@/.test(a.email));
        const extra = ['X-GOOGLE-CONFERENCE', 'X-MICROSOFT-SKYPETEAMSMEETINGURL', 'X-MICROSOFT-ONLINEMEETINGCONFLINK', 'URL'].map((k) => one(k)?.v);
        const t0 = Date.parse(startsAt);
        const dur = Math.max(0, Date.parse(endsAt) - t0);
        const rid = one('RECURRENCE-ID');
        const rrule = one('RRULE')?.v;
        const exdates = new Set((ev.EXDATE ?? []).flatMap((x) => x.v.split(',').map((v) => Date.parse(icsTime(v, x.p, zones) ?? ''))).filter((x) => !Number.isNaN(x)));
        const times = rrule && !rid ? expandRrule(t0, rrule, exdates, window.from, window.to) : [t0];
        for (const t of times) (out as (Invite & { override?: boolean })[]).push({
          id: `ics:${one('UID')?.v ?? startsAt}`,
          uid: one('UID')?.v ?? null,
          title: unescapeIcs(one('SUMMARY')?.v ?? 'Meeting'),
          startsAt: new Date(t).toISOString(),
          endsAt: new Date(t + dur).toISOString(),
          recurrenceId: rid ? icsTime(rid.v, rid.p, zones) : rrule ? new Date(t).toISOString() : null,
          override: !!rid,
          location,
          description,
          joinUrl: meetingLink(...extra, location, description),
          attendees: [...new Map(people.map((a) => [a.email, a])).values()],
          cancelled: method === 'CANCEL' || /^CANCELLED$/i.test(one('STATUS')?.v ?? ''),
          declined: false,
          source: 'email',
        });
      }
      ev = null;
    } else if (ev) {
      const i = l.indexOf(':');
      if (i < 1) continue;
      const [name, ...ps] = l.slice(0, i).split(';');
      const p: Record<string, string> = {};
      for (const kv of ps) {
        const j = kv.indexOf('=');
        if (j > 0) p[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1);
      }
      (ev[name!.toUpperCase()] ??= []).push({ v: l.slice(i + 1), p });
    }
  }
  // a single time moved or cancelled (RECURRENCE-ID) replaces that time of the series
  const keyed = new Map<string, Invite & { override?: boolean }>();
  for (const x of out as (Invite & { override?: boolean })[]) {
    const k = `${x.uid}|${x.recurrenceId ?? x.startsAt}`;
    if (!keyed.has(k) || x.override) keyed.set(k, x);
  }
  return [...keyed.values()]
    .filter((x) => !x.override || (Date.parse(x.startsAt) >= window.from && Date.parse(x.startsAt) <= window.to) || !x.recurrenceId)
    .map(({ override: _o, ...x }) => x);
}

const b64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
const isIcs = (name: string | undefined, type: string | undefined) => /\.(ics|vcs)$/i.test(name ?? '') || /text\/calendar|application\/ics/i.test(type ?? '');

async function gmailIcs(token: string, since: Date): Promise<Invite[]> {
  const auth = { authorization: `Bearer ${token}` };
  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));
  const q = new URLSearchParams({ q: `newer_than:${days}d (filename:ics OR filename:vcs OR has:invite)`, maxResults: '40' });
  const list = await providerFetch<{ messages?: { id: string }[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, { headers: auth });
  const out: Invite[] = [];
  for (const m of list.messages ?? []) {
    const msg = await providerFetch<{ payload?: any }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth }).catch(() => null);
    const parts: any[] = [];
    const walk = (p: any) => {
      if (!p) return;
      if (isIcs(p.filename, p.mimeType)) parts.push(p);
      (p.parts ?? []).forEach(walk);
    };
    walk(msg?.payload);
    for (const p of parts.slice(0, 3)) {
      let data: string | null = p.body?.data ?? null;
      if (!data && p.body?.attachmentId) data = (await providerFetch<{ data?: string }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${p.body.attachmentId}`, { headers: auth }).catch(() => null))?.data ?? null;
      if (data) out.push(...parseIcs(b64url(data)));
    }
  }
  return out;
}

async function graphIcs(token: string, since: Date): Promise<Invite[]> {
  const auth = { authorization: `Bearer ${token}` };
  const q = new URLSearchParams({ $filter: `receivedDateTime ge ${since.toISOString()} and hasAttachments eq true`, $top: '40', $select: 'id' });
  const list = await providerFetch<{ value?: { id: string }[] }>(`${GRAPH}/me/messages?${q}`, { headers: auth });
  const out: Invite[] = [];
  for (const m of list.value ?? []) {
    const atts = await providerFetch<{ value?: { id: string; name?: string; contentType?: string; size?: number }[] }>(`${GRAPH}/me/messages/${m.id}/attachments?$select=id,name,contentType,size`, { headers: auth }).catch(() => null);
    for (const a of (atts?.value ?? []).filter((x) => isIcs(x.name, x.contentType) && (x.size ?? 0) < 500_000).slice(0, 3)) {
      const full = await providerFetch<{ contentBytes?: string }>(`${GRAPH}/me/messages/${m.id}/attachments/${a.id}`, { headers: auth }).catch(() => null);
      if (full?.contentBytes) out.push(...parseIcs(b64url(full.contentBytes)));
    }
  }
  return out;
}

/* ───────────────────────── filing ───────────────────────── */

interface FileCtx {
  tenantId: string;
  userId: string;
  integrationId: string;
  self: string;
  colleagues: Set<string>;
  myApps: { id: string; provider: string; account_ref: string }[];
}

/** One invite → a new call, an update to the one already filed, or nothing. */
async function fileInvite(tx: Tx, f: FileCtx, inv: Invite): Promise<'added' | 'updated' | 'skipped'> {
  const others = inv.attendees.filter((a) => a.email !== f.self);
  const external = others.some((a) => !f.colleagues.has(a.email));
  if (!inv.joinUrl && !external) return 'skipped';
  // calls SanchalanOS itself put in the calendar
  if (/Scheduled from SanchalanOS/.test(inv.description ?? '')) return 'skipped';
  if (inv.source !== 'email' && (await tx.one(`select 1 from events where tenant_id = $1 and calendar_ref ->> 'id' = $2`, [f.tenantId, inv.id]))) return 'skipped';
  // an emailed meeting is one call per UID (per time of a recurring series), so a moved meeting updates it
  const ref = (inv.source === 'email' ? `ics:${inv.uid ?? inv.id}${inv.recurrenceId ? `:${inv.recurrenceId}` : ''}` : `cal:${f.integrationId}:${inv.id}`).slice(0, 300);
  const existing =
    (await tx.one<{ id: string }>(`select id from events where tenant_id = $1 and external_ref = $2`, [f.tenantId, ref])) ??
    (inv.uid
      ? await tx.one<{ id: string }>(`select id from events where tenant_id = $1 and ical_uid = $2 and starts_at between $3::timestamptz - interval '12 hours' and $3::timestamptz + interval '12 hours' order by created_at limit 1`, [f.tenantId, inv.uid.slice(0, 300), inv.startsAt])
      : null);
  const attendees = others.slice(0, 50).map((a) => ({ email: a.email, ...(a.name ? { name: a.name } : {}) }));
  if (existing) {
    await tx.query(
      `update events set title = $3, starts_at = $4, ends_at = $5, attendees = $6, ical_uid = coalesce(ical_uid, $8), status = case when $7::boolean then 'cancelled' when status = 'cancelled' then 'scheduled' else status end, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [f.tenantId, existing.id, inv.title.slice(0, 200), inv.startsAt, inv.endsAt, JSON.stringify(attendees), inv.cancelled || inv.declined, inv.uid?.slice(0, 300) ?? null],
    );
    return 'updated';
  }
  if (inv.cancelled || inv.declined) return 'skipped';
  if (Date.parse(inv.endsAt) < Date.now() - 30 * 86_400_000) return 'skipped';
  let online: OnlineMeeting | null = null;
  if (inv.joinUrl) {
    const p = parseJoinUrl(inv.joinUrl);
    if (p) {
      // the same meeting already came in from a meeting app, or was scheduled in SanchalanOS
      const dup = await tx.one<{ id: string }>(
        `select id from events where tenant_id = $1 and online_meeting ->> 'joinUrl' = $2 and starts_at between $3::timestamptz - interval '1 day' and $3::timestamptz + interval '1 day'`,
        [f.tenantId, p.joinUrl, inv.startsAt],
      );
      if (dup) {
        await tx.query(`update events set external_ref = coalesce(external_ref, $3), ical_uid = coalesce(ical_uid, $4) where tenant_id = $1 and id = $2`, [f.tenantId, dup.id, ref, inv.uid?.slice(0, 300) ?? null]);
        return 'skipped';
      }
      const app = f.myApps.find((a) => a.provider === p.provider);
      online = { ...p, integrationId: app?.id ?? '', account: app?.account_ref ?? null };
    }
  }
  const project = await matchProject(tx, f.tenantId, f.userId, inv.title, others.map((a) => a.email));
  await tx.query(
    `insert into events (tenant_id, title, kind, starts_at, ends_at, description, location, related_object, related_id, owner_id, created_by, attendees, online_meeting, transcript_status, external_ref, ical_uid)
     values ($1,$2,'meeting',$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14)`,
    [
      f.tenantId, inv.title.slice(0, 200), inv.startsAt, inv.endsAt, inv.description?.slice(0, 5000) ?? null, (inv.joinUrl ?? inv.location)?.slice(0, 300) ?? null, project ? 'project' : null, project, f.userId,
      JSON.stringify(attendees), online ? JSON.stringify(online) : null, online?.integrationId && Date.parse(inv.endsAt) > Date.now() - 7 * 86_400_000 ? 'waiting' : 'none', ref, inv.uid?.slice(0, 300) ?? null,
    ],
  );
  return 'added';
}

/**
 * Files one mailbox's invites as calls: the calendar (a week back to a month ahead) and invitations
 * attached to emails (.ics — from Zoho, Webex, GoTo and other tools that do not reach the
 * calendar). Only meetings that look like calls count: with a Zoom / Meet / Teams link, or with
 * someone from outside the workspace.
 */
export async function syncInvites(env: Env, tx: Tx, i: Integration): Promise<{ found: number; added: number; updated: number; fromEmail: number }> {
  if (!i.user_id || i.config?.invites === false) return { found: 0, added: 0, updated: 0, fromEmail: 0 };
  const token = await mailboxToken(env, tx, i);
  const from = new Date(Date.now() - 7 * 86_400_000);
  const to = new Date(Date.now() + 30 * 86_400_000);
  const list = i.provider === 'google' ? await googleInvites(token, from, to) : await graphInvites(token, from, to);
  // emails since the last look (first time: two weeks back)
  const lastLook = Date.parse(String(i.config?.icsScannedAt ?? '')) || Date.now() - 14 * 86_400_000;
  const since = new Date(Math.max(lastLook - 86_400_000, Date.now() - 30 * 86_400_000));
  const fromMail = await (i.provider === 'google' ? gmailIcs(token, since) : graphIcs(token, since)).catch((e) => {
    console.error(JSON.stringify({ level: 'warn', job: 'invites-ics', msg: (e as Error).message }));
    return [] as Invite[];
  });
  const calUids = new Set(list.map((x) => x.uid).filter(Boolean));
  const f: FileCtx = {
    tenantId: i.tenant_id,
    userId: i.user_id,
    integrationId: i.id,
    self: (i.account_ref ?? '').toLowerCase(),
    colleagues: new Set((await tx.query<{ email: string }>(`select lower(email) as email from users where tenant_id = $1 and email is not null`, [i.tenant_id])).map((u) => u.email)),
    myApps: await tx.query(`select id, provider, account_ref from integrations where tenant_id = $1 and user_id = $2 and provider in ('zoom_meet','google_meet','ms_teams_meet') and status = 'active'`, [i.tenant_id, i.user_id]),
  };
  let added = 0;
  let updated = 0;
  let found = 0;
  let fromEmail = 0;
  // an emailed invite that is also in the calendar is filed once, from the calendar
  for (const inv of [...list, ...fromMail.filter((x) => !(x.uid && calUids.has(x.uid)) && Date.parse(x.endsAt) > from.getTime())]) {
    const r = await fileInvite(tx, f, inv);
    if (r === 'skipped') continue;
    found++;
    if (r === 'added') added++;
    else updated++;
    if (inv.source === 'email') fromEmail++;
  }
  await tx.query(`update integrations set config = coalesce(config, '{}'::jsonb) || jsonb_build_object('icsScannedAt', $3::text) where tenant_id = $1 and id = $2`, [i.tenant_id, i.id, new Date().toISOString()]);
  return { found, added, updated, fromEmail };
}

/** "Check my invites now" from the Calls page. */
export async function syncMyInvites(env: Env, db: Db, tenantId: string, userId: string) {
  return db.tx({ tenantId, userId }, async (tx) => {
    const mb = await mailboxOf(tx, tenantId, userId, true);
    if (!mb) return { mailbox: false, found: 0, added: 0, updated: 0, fromEmail: 0 };
    return { mailbox: true, ...(await syncInvites(env, tx, mb)) };
  });
}
