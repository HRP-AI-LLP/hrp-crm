/**
 * Meeting apps as plugins: each person connects their own Zoom, Google Meet and Microsoft Teams
 * accounts (as many as they use). SanchalanOS can then
 *   - create the online meeting when a call is scheduled (join link on the event),
 *   - fetch the transcript once the meeting is over (Zoom cloud recording transcript, Meet
 *     transcript entries, Teams transcript) and hand it to the call analysis,
 *   - pick up recent meetings held in those apps that were not scheduled in SanchalanOS.
 * Tokens are sealed with the workspace key; refresh happens on use.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { form, type Integration, markError, markOk, MEETING_OAUTH, MSMEET_SCOPES, providerFetch, ProviderError, readSecret, sealSecret, type TokenSet } from './integrations';
import type { RecordCtx } from './records';

export type MeetProvider = 'zoom_meet' | 'google_meet' | 'ms_teams_meet';
export const MEET_PROVIDERS: MeetProvider[] = ['zoom_meet', 'google_meet', 'ms_teams_meet'];
export const MEET_LABEL: Record<MeetProvider, string> = { zoom_meet: 'Zoom', google_meet: 'Google Meet', ms_teams_meet: 'Microsoft Teams' };
const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface OnlineMeeting {
  provider: MeetProvider;
  integrationId: string;
  joinUrl: string;
  meetingId?: string | null; // Zoom meeting id, Teams onlineMeeting id
  meetingCode?: string | null; // Meet code (abc-defg-hij)
  calendarEventId?: string | null; // Google / Outlook calendar event made with it
  account?: string | null;
}

export async function markMeetingsPresent(env: Env) {
  await env.CACHE_KV?.put('meet:any', '1', { expirationTtl: 6 * 3600 }).catch(() => undefined);
}

/* ───────────────────────── accounts ───────────────────────── */

export async function connectMeetingAccount(env: Env, tx: Tx, tenantId: string, userId: string, p: 'zoom' | 'gmeet' | 'msmeet', tokens: TokenSet) {
  const provider = MEETING_OAUTH[p];
  const auth = { authorization: `Bearer ${tokens.accessToken}` };
  let email = '';
  let name = '';
  if (p === 'zoom') {
    const me = await providerFetch<{ email?: string; first_name?: string; last_name?: string; id: string }>('https://api.zoom.us/v2/users/me', { headers: auth });
    email = me.email ?? me.id;
    name = [me.first_name, me.last_name].filter(Boolean).join(' ');
  } else if (p === 'gmeet') {
    const me = await providerFetch<{ email?: string; name?: string }>('https://openidconnect.googleapis.com/v1/userinfo', { headers: auth });
    email = me.email ?? '';
    name = me.name ?? '';
  } else {
    const me = await providerFetch<{ mail?: string; userPrincipalName?: string; displayName?: string; id: string }>(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, { headers: auth });
    email = me.userPrincipalName || me.mail || me.id;
    name = me.displayName ?? '';
  }
  if (!email) throw badRequest('The account could not be identified');
  const ref = email.toLowerCase();
  const taken = await tx.one<{ user_id: string | null }>(`select user_id from integrations where tenant_id = $1 and provider = $2 and account_ref = $3`, [tenantId, provider, ref]);
  if (taken && taken.user_id !== userId) throw badRequest(`${email} is already connected by a colleague`);
  const sealed = await sealSecret(env, tenantId, tokens as unknown as Record<string, unknown>);
  if (taken) {
    await tx.query(`update integrations set secret_ciphertext = $4, status = 'active', last_error = null, error_count = 0, updated_at = now() where tenant_id = $1 and provider = $2 and account_ref = $3`, [tenantId, provider, ref, sealed]);
  } else {
    await tx.query(`insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config, created_by) values ($1,$2,$3,$4,$5,$6,$7,$3)`, [
      tenantId, provider, userId, `${MEET_LABEL[provider]}${name ? ` · ${name}` : ''}`.slice(0, 120), ref, sealed, JSON.stringify({ autoFetch: true, autoAnalyse: true, importAll: false, createTasks: true }),
    ]);
  }
  return { connected: [`${MEET_LABEL[provider]} (${email})`], failed: [] as string[] };
}

export async function myMeetingAccounts(ctx: RecordCtx, env: Env) {
  const rows = await ctx.tx.query<Integration>(`select * from integrations where tenant_id = $1 and user_id = $2 and provider = any($3::text[]) order by provider, created_at`, [ctx.tenantId, ctx.principal.user.id, MEET_PROVIDERS]);
  return {
    accounts: rows.map((i) => ({ id: i.id, provider: i.provider, label: i.label, account: i.account_ref, status: i.status, config: i.config, lastSyncAt: i.last_sync_at, lastError: i.last_error })),
    available: { zoom_meet: !!(env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET), google_meet: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), ms_teams_meet: !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) },
  };
}

async function myAccount(ctx: RecordCtx, id: string) {
  const i = await ctx.tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = any($3::text[])`, [ctx.tenantId, id, MEET_PROVIDERS]);
  if (!i) throw notFound('Meeting account not found');
  if (i.user_id !== ctx.principal.user.id) throw forbidden('That is a colleague’s meeting account');
  return i;
}

export async function updateMeetingAccount(ctx: RecordCtx, id: string, cfg: { autoFetch?: boolean; autoAnalyse?: boolean; importAll?: boolean; createTasks?: boolean }) {
  const i = await myAccount(ctx, id);
  await ctx.tx.query(`update integrations set config = config || $3::jsonb, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, i.id, JSON.stringify(cfg)]);
  return { ok: true };
}

export async function removeMeetingAccount(ctx: RecordCtx, env: Env, id: string) {
  const i = await myAccount(ctx, id);
  if (i.provider === 'google_meet') {
    const s = await readSecret<TokenSet>(env, i).catch(() => null);
    if (s?.refreshToken) await fetch(`https://oauth2.googleapis.com/revoke?${form({ token: s.refreshToken })}`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }
  await ctx.tx.query(`delete from integrations where tenant_id = $1 and id = $2`, [ctx.tenantId, i.id]);
  return { ok: true };
}

/** A fresh access token for a meeting account (refreshed and saved when close to expiry). */
export async function meetingToken(env: Env, tx: Tx, i: Integration): Promise<string> {
  const s = await readSecret<TokenSet>(env, i);
  if (s.accessToken && s.expiresAt - Date.now() > 120_000) return s.accessToken;
  if (!s.refreshToken) throw new ProviderError('No refresh token; connect the account again', 401);
  let t: any;
  try {
    if (i.provider === 'zoom_meet') {
      t = await providerFetch('https://zoom.us/oauth/token', {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`)}` },
        body: form({ grant_type: 'refresh_token', refresh_token: s.refreshToken }),
      });
    } else if (i.provider === 'google_meet') {
      t = await providerFetch('https://oauth2.googleapis.com/token', { method: 'POST', body: form({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: s.refreshToken, grant_type: 'refresh_token' }) });
    } else {
      t = await providerFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        body: form({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, refresh_token: s.refreshToken, grant_type: 'refresh_token', scope: MSMEET_SCOPES.join(' ') }),
      });
    }
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) throw new ProviderError('Access was revoked or expired — connect this meeting account again', 401);
    throw e;
  }
  const next: TokenSet = { accessToken: t.access_token, refreshToken: t.refresh_token ?? s.refreshToken, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  await tx.query(`update integrations set secret_ciphertext = $3 where tenant_id = $1 and id = $2`, [i.tenant_id, i.id, await sealSecret(env, i.tenant_id, next as unknown as Record<string, unknown>)]);
  return next.accessToken;
}

/* ───────────────────────── creating meetings ───────────────────────── */

export interface NewMeeting {
  title: string;
  startsAt: string;
  endsAt: string;
  agenda?: string | null;
  attendees: { email: string; name?: string | null }[];
}

export async function createOnlineMeeting(env: Env, tx: Tx, i: Integration, m: NewMeeting): Promise<OnlineMeeting> {
  const token = await meetingToken(env, tx, i);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const minutes = Math.max(15, Math.round((Date.parse(m.endsAt) - Date.parse(m.startsAt)) / 60000));
  const provider = i.provider as MeetProvider;
  if (provider === 'zoom_meet') {
    const r = await providerFetch<{ id: number; join_url: string }>('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        topic: m.title.slice(0, 200),
        type: 2,
        start_time: new Date(m.startsAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        duration: minutes,
        timezone: 'UTC',
        agenda: (m.agenda ?? '').slice(0, 2000),
        // a cloud recording gives the audio transcript afterwards
        settings: { auto_recording: 'cloud', join_before_host: false, meeting_invitees: m.attendees.map((a) => ({ email: a.email })) },
      }),
    });
    return { provider, integrationId: i.id, joinUrl: r.join_url, meetingId: String(r.id), account: i.account_ref };
  }
  if (provider === 'google_meet') {
    const r = await providerFetch<{ id: string; hangoutLink?: string; conferenceData?: { conferenceId?: string; entryPoints?: { entryPointType: string; uri: string }[] } }>(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          summary: m.title,
          description: [m.agenda ?? '', 'Scheduled from SanchalanOS'].filter(Boolean).join('\n\n'),
          start: { dateTime: new Date(m.startsAt).toISOString() },
          end: { dateTime: new Date(m.endsAt).toISOString() },
          attendees: m.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
          conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        }),
      },
    );
    const joinUrl = r.hangoutLink ?? r.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? '';
    if (!joinUrl) throw new ProviderError('Google did not return a Meet link (is Meet enabled for this account?)', 502);
    return { provider, integrationId: i.id, joinUrl, meetingCode: r.conferenceData?.conferenceId ?? joinUrl.split('/').pop() ?? null, calendarEventId: r.id, account: i.account_ref };
  }
  // Teams: an Outlook event with a Teams meeting invites everyone; its onlineMeeting is found later by join link
  const r = await providerFetch<{ id: string; onlineMeeting?: { joinUrl?: string } }>(`${GRAPH}/me/events`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      subject: m.title,
      body: { contentType: 'text', content: [m.agenda ?? '', 'Scheduled from SanchalanOS'].filter(Boolean).join('\n\n') },
      start: { dateTime: new Date(m.startsAt).toISOString().replace('Z', ''), timeZone: 'UTC' },
      end: { dateTime: new Date(m.endsAt).toISOString().replace('Z', ''), timeZone: 'UTC' },
      attendees: m.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name ?? a.email }, type: 'required' })),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    }),
  });
  const joinUrl = r.onlineMeeting?.joinUrl ?? '';
  if (!joinUrl) throw new ProviderError('Teams did not return a meeting link (does this account have Teams?)', 502);
  return { provider, integrationId: i.id, joinUrl, calendarEventId: r.id, account: i.account_ref };
}

/* ───────────────────────── transcripts ───────────────────────── */

/** WebVTT / SRT captions → "Speaker: words" lines (consecutive lines of one speaker merged). */
export function captionsToText(raw: string): string {
  const text = raw.replace(/\r/g, '');
  if (!/^WEBVTT|-->/m.test(text)) return text.trim();
  const out: { who: string | null; t: string }[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    let body = lines.slice(at + 1).join(' ');
    let who: string | null = null;
    const v = /^<v\s+([^>]+)>(.*?)(<\/v>)?$/.exec(body);
    if (v) {
      who = v[1]!.trim();
      body = v[2]!;
    } else {
      const m = /^([A-Z][\w .'-]{1,40}):\s+(.+)$/.exec(body);
      if (m) {
        who = m[1]!.trim();
        body = m[2]!;
      }
    }
    body = body.replace(/<[^>]+>/g, '').trim();
    if (!body) continue;
    const last = out[out.length - 1];
    if (last && last.who === who) last.t += ` ${body}`;
    else out.push({ who, t: body });
  }
  return out.map((x) => (x.who ? `${x.who}: ${x.t}` : x.t)).join('\n');
}

async function rawGet(url: string, token: string, follow = false) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: follow ? 'follow' : 'manual', signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new ProviderError(`HTTP ${res.status} fetching the transcript`, res.status);
  return res.text();
}

/** The transcript of a meeting that has ended, or null while the app has not made one (yet). */
export async function fetchTranscript(env: Env, tx: Tx, i: Integration, m: OnlineMeeting): Promise<string | null> {
  const token = await meetingToken(env, tx, i);
  const auth = { authorization: `Bearer ${token}` };
  if (m.provider === 'zoom_meet') {
    if (!m.meetingId) return null;
    const r = await providerFetch<{ recording_files?: { file_type: string; recording_type?: string; download_url: string; status?: string }[] }>(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(m.meetingId)}/recordings`,
      { headers: auth },
    ).catch((e) => {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    });
    const f = r?.recording_files?.find((x) => x.file_type === 'TRANSCRIPT' && (x.status ?? 'completed') === 'completed');
    if (!f) return null;
    const vtt = await rawGet(f.download_url, token, true);
    return vtt ? captionsToText(vtt) : null;
  }
  if (m.provider === 'google_meet') {
    if (!m.meetingCode) return null;
    const recs = await providerFetch<{ conferenceRecords?: { name: string; startTime: string }[] }>(
      `https://meet.googleapis.com/v2/conferenceRecords?${form({ filter: `space.meeting_code = "${m.meetingCode}"` })}`,
      { headers: auth },
    );
    const parts: string[] = [];
    const names = new Map<string, string>();
    for (const rec of (recs.conferenceRecords ?? []).sort((a, b) => a.startTime.localeCompare(b.startTime))) {
      const ts = await providerFetch<{ transcripts?: { name: string; state: string }[] }>(`https://meet.googleapis.com/v2/${rec.name}/transcripts`, { headers: auth });
      for (const t of (ts.transcripts ?? []).filter((x) => x.state === 'FILE_GENERATED' || x.state === 'ENDED')) {
        let page: string | undefined;
        const lines: { who: string; t: string }[] = [];
        do {
          const e = await providerFetch<{ transcriptEntries?: { participant: string; text: string }[]; nextPageToken?: string }>(
            `https://meet.googleapis.com/v2/${t.name}/entries?${form({ pageSize: '100', pageToken: page })}`,
            { headers: auth },
          );
          for (const x of e.transcriptEntries ?? []) {
            if (!names.has(x.participant)) {
              const p = await providerFetch<{ signedinUser?: { displayName?: string }; anonymousUser?: { displayName?: string }; phoneUser?: { displayName?: string } }>(`https://meet.googleapis.com/v2/${x.participant}`, { headers: auth }).catch(() => null);
              names.set(x.participant, p?.signedinUser?.displayName ?? p?.anonymousUser?.displayName ?? p?.phoneUser?.displayName ?? 'Participant');
            }
            const who = names.get(x.participant)!;
            const last = lines[lines.length - 1];
            if (last && last.who === who) last.t += ` ${x.text}`;
            else lines.push({ who, t: x.text });
          }
          page = e.nextPageToken;
        } while (page && lines.length < 20_000);
        parts.push(lines.map((l) => `${l.who}: ${l.t}`).join('\n'));
      }
    }
    const text = parts.filter(Boolean).join('\n\n');
    return text.trim() ? text : null;
  }
  // Teams
  let meetingId = m.meetingId ?? null;
  if (!meetingId) {
    const q = await providerFetch<{ value?: { id: string }[] }>(`${GRAPH}/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${m.joinUrl.replace(/'/g, "''")}'`)}`, { headers: auth });
    meetingId = q.value?.[0]?.id ?? null;
    if (!meetingId) return null;
    m.meetingId = meetingId;
  }
  const list = await providerFetch<{ value?: { id: string; createdDateTime: string }[] }>(`${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`, { headers: auth });
  const out: string[] = [];
  for (const t of (list.value ?? []).sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime))) {
    const vtt = await rawGet(`${GRAPH}/me/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(t.id)}/content?$format=text/vtt`, token, true);
    if (vtt) out.push(captionsToText(vtt));
  }
  const text = out.join('\n\n');
  return text.trim() ? text : null;
}

/* ───────────────────────── meetings held outside SanchalanOS ───────────────────────── */

export interface ExternalMeeting {
  ref: string;
  title: string;
  startsAt: string;
  endsAt: string;
  online: OnlineMeeting;
  attendees: string[];
}

/** Meetings this account held in the last days (only those that can have a transcript). */
export async function recentMeetings(env: Env, tx: Tx, i: Integration, days = 3): Promise<ExternalMeeting[]> {
  const token = await meetingToken(env, tx, i);
  const auth = { authorization: `Bearer ${token}` };
  const since = new Date(Date.now() - days * 86_400_000);
  const provider = i.provider as MeetProvider;
  if (provider === 'zoom_meet') {
    const r = await providerFetch<{ meetings?: { id: number; uuid: string; topic: string; start_time: string; duration: number; recording_files?: { file_type: string }[] }[] }>(
      `https://api.zoom.us/v2/users/me/recordings?${form({ from: since.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), page_size: '50' })}`,
      { headers: auth },
    );
    return (r.meetings ?? [])
      .filter((x) => x.recording_files?.some((f) => f.file_type === 'TRANSCRIPT'))
      .map((x) => ({
        ref: `zoom:${x.uuid}`,
        title: x.topic || 'Zoom meeting',
        startsAt: x.start_time,
        endsAt: new Date(Date.parse(x.start_time) + Math.max(1, x.duration) * 60000).toISOString(),
        online: { provider, integrationId: i.id, joinUrl: `https://zoom.us/j/${x.id}`, meetingId: String(x.id), account: i.account_ref },
        attendees: [],
      }));
  }
  if (provider === 'google_meet') {
    const r = await providerFetch<{ conferenceRecords?: { name: string; startTime: string; endTime?: string; space: string }[] }>(
      `https://meet.googleapis.com/v2/conferenceRecords?${form({ filter: `start_time >= "${since.toISOString()}"`, pageSize: '50' })}`,
      { headers: auth },
    );
    const out: ExternalMeeting[] = [];
    for (const rec of r.conferenceRecords ?? []) {
      if (!rec.endTime) continue;
      const space = await providerFetch<{ meetingCode?: string; meetingUri?: string }>(`https://meet.googleapis.com/v2/${rec.space}`, { headers: auth }).catch(() => null);
      if (!space?.meetingCode) continue;
      // the calendar title, when the meeting was booked in the calendar
      const ev = await providerFetch<{ items?: { summary?: string; attendees?: { email: string }[] }[] }>(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${form({ q: space.meetingCode, timeMin: new Date(Date.parse(rec.startTime) - 6 * 3_600_000).toISOString(), timeMax: rec.endTime, singleEvents: 'true', maxResults: '1' })}`,
        { headers: auth },
      ).catch(() => null);
      out.push({
        ref: `gmeet:${rec.name}`,
        title: ev?.items?.[0]?.summary ?? `Google Meet ${space.meetingCode}`,
        startsAt: rec.startTime,
        endsAt: rec.endTime,
        online: { provider, integrationId: i.id, joinUrl: space.meetingUri ?? `https://meet.google.com/${space.meetingCode}`, meetingCode: space.meetingCode, account: i.account_ref },
        attendees: (ev?.items?.[0]?.attendees ?? []).map((a) => a.email.toLowerCase()),
      });
    }
    return out;
  }
  const r = await providerFetch<{ value?: { id: string; subject?: string; start: { dateTime: string }; end: { dateTime: string }; isOnlineMeeting?: boolean; onlineMeeting?: { joinUrl?: string }; attendees?: { emailAddress?: { address?: string } }[] }[] }>(
    `${GRAPH}/me/calendarView?${form({ startDateTime: since.toISOString(), endDateTime: new Date().toISOString(), $top: '50', $select: 'id,subject,start,end,isOnlineMeeting,onlineMeeting,attendees' })}`,
    { headers: { ...auth, prefer: 'outlook.timezone="UTC"' } },
  );
  return (r.value ?? [])
    .filter((x) => x.isOnlineMeeting && x.onlineMeeting?.joinUrl && Date.parse(`${x.end.dateTime}Z`) < Date.now())
    .map((x) => ({
      ref: `teams:${x.id}`,
      title: x.subject || 'Teams meeting',
      startsAt: new Date(`${x.start.dateTime.replace(/Z$/, '')}Z`).toISOString(),
      endsAt: new Date(`${x.end.dateTime.replace(/Z$/, '')}Z`).toISOString(),
      online: { provider, integrationId: i.id, joinUrl: x.onlineMeeting!.joinUrl!, calendarEventId: x.id, account: i.account_ref },
      attendees: (x.attendees ?? []).map((a) => a.emailAddress?.address?.toLowerCase()).filter(Boolean) as string[],
    }));
}

/** Files the person's recent meetings as calls: on a project when the title or the attendees point to one. */
export async function importRecent(env: Env, tx: Tx, i: Integration, days = 3) {
  const list = await recentMeetings(env, tx, i, days);
  let added = 0;
  for (const m of list) {
    if (await tx.one(`select 1 from events where tenant_id = $1 and external_ref = $2`, [i.tenant_id, m.ref])) continue;
    // the same meeting scheduled from SanchalanOS already waits for its transcript
    if (await tx.one(`select 1 from events where tenant_id = $1 and online_meeting ->> 'joinUrl' = $2 and starts_at between $3::timestamptz - interval '1 day' and $3::timestamptz + interval '1 day'`, [i.tenant_id, m.online.joinUrl, m.startsAt])) continue;
    const project = await matchProject(tx, i.tenant_id, i.user_id!, m.title, m.attendees);
    await tx.query(
      `insert into events (tenant_id, title, kind, starts_at, ends_at, related_object, related_id, owner_id, created_by, attendees, location, online_meeting, transcript_status, external_ref)
       values ($1,$2,'meeting',$3,$4,$5,$6,$7,$7,$8,$9,$10,'waiting',$11)`,
      [i.tenant_id, m.title.slice(0, 200), m.startsAt, m.endsAt, project ? 'project' : null, project, i.user_id, JSON.stringify(m.attendees.slice(0, 50).map((email) => ({ email }))), m.online.joinUrl.slice(0, 300), JSON.stringify(m.online), m.ref],
    );
    added++;
  }
  return { found: list.length, added };
}

/** The project a meeting belongs to: its name or number in the title, else the customer's people on the call. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.in', 'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com', 'aol.com']);

/** A meeting title without dates, numbers and "Re:" — so a weekly call keeps one key. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(re|fwd?|updated invitation|invitation|accepted|declined)\s*:\s*/g, '')
    .replace(/@.*$/, '')
    .replace(/\b(\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?|\d+(st|nd|rd|th)?|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/g, ' ')
    .replace(/[^a-z\s&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The keys a call is filed by (outside people only — colleagues are in every project). */
export function filingKeys(title: string, outsideEmails: string[]): { kind: 'title' | 'email' | 'domain'; value: string }[] {
  const keys: { kind: 'title' | 'email' | 'domain'; value: string }[] = [];
  const tk = titleKey(title);
  if (tk.length >= 4) keys.push({ kind: 'title', value: tk });
  for (const e of outsideEmails.slice(0, 30)) {
    keys.push({ kind: 'email', value: e.toLowerCase() });
    const d = e.toLowerCase().split('@')[1];
    if (d && !FREE_MAIL.has(d)) keys.push({ kind: 'domain', value: d });
  }
  return [...new Map(keys.map((k) => [`${k.kind}:${k.value}`, k])).values()];
}

/** Moving a call to a project teaches the filing for the next ones like it. */
export async function learnFiling(tx: Tx, tenantId: string, userId: string, projectId: string, title: string, attendeeEmails: string[]) {
  const colleagues = new Set((await tx.query<{ email: string }>(`select lower(email) as email from users where tenant_id = $1 and email is not null`, [tenantId])).map((u) => u.email));
  const keys = filingKeys(title, attendeeEmails.filter((e) => !colleagues.has(e.toLowerCase())));
  if (!keys.length) return;
  await tx.query(
    `insert into call_filing_hints (tenant_id, user_id, kind, value, project_id) select $1, $2, k, v, $5 from unnest($3::text[], $4::text[]) as x(k, v)
     on conflict (tenant_id, user_id, kind, value, project_id) do update set hits = call_filing_hints.hits + 1, updated_at = now()`,
    [tenantId, userId, keys.map((k) => k.kind), keys.map((k) => k.value), projectId],
  );
  // the same key pointing at another project is weakened, so a correction wins quickly
  await tx.query(
    `update call_filing_hints set hits = greatest(0, hits - 1) where tenant_id = $1 and user_id = $2 and project_id <> $5 and (kind, value) in (select * from unnest($3::text[], $4::text[]))`,
    [tenantId, userId, keys.map((k) => k.kind), keys.map((k) => k.value), projectId],
  );
  await tx.query(`delete from call_filing_hints where tenant_id = $1 and user_id = $2 and hits <= 0`, [tenantId, userId]);
}

export async function matchProject(tx: Tx, tenantId: string, userId: string, title: string, attendees: string[]): Promise<string | null> {
  const t = title.toLowerCase();
  const mine = await tx.query<{ id: string; name: string; project_code: string | null; account_id: string | null }>(
    `select p.id, p.name, p.project_code, p.account_id from projects p where p.tenant_id = $1 and p.deleted_at is null and p.status not in ('completed','cancelled')
        and (p.owner_id = $2 or exists (select 1 from project_members m where m.tenant_id = p.tenant_id and m.project_id = p.id and m.user_id = $2)) limit 300`,
    [tenantId, userId],
  );
  const byTitle = mine.filter((p) => (p.project_code && t.includes(p.project_code.toLowerCase())) || (p.name.length >= 5 && t.includes(p.name.toLowerCase())));
  if (byTitle.length === 1) return byTitle[0]!.id;
  // what the person taught SanchalanOS by moving earlier calls: the same (recurring) title, the same
  // outside people, the same company domain
  const open = new Set(mine.map((p) => p.id));
  const keys = filingKeys(title, attendees);
  if (keys.length) {
    const hints = await tx.query<{ kind: string; project_id: string; hits: number }>(
      `select kind, project_id, hits from call_filing_hints where tenant_id = $1 and user_id = $2 and (kind, value) in (select * from unnest($3::text[], $4::text[]))`,
      [tenantId, userId, keys.map((k) => k.kind), keys.map((k) => k.value)],
    );
    const score = new Map<string, number>();
    for (const h of hints) if (open.has(h.project_id)) score.set(h.project_id, (score.get(h.project_id) ?? 0) + (h.kind === 'title' ? 5 : h.kind === 'email' ? 3 : 1) * Math.min(h.hits, 5));
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length && ranked[0]![1] >= 3 && (ranked.length === 1 || ranked[0]![1] >= ranked[1]![1] * 2)) return ranked[0]![0];
  }
  if (attendees.length) {
    const acc = await tx.query<{ account_id: string }>(`select distinct account_id from contacts where tenant_id = $1 and lower(email) = any($2::text[]) and account_id is not null and deleted_at is null`, [tenantId, attendees]);
    const ids = new Set(acc.map((a) => a.account_id));
    const hits = mine.filter((p) => p.account_id && ids.has(p.account_id));
    if (hits.length === 1) return hits[0]!.id;
  }
  return null;
}

/* ───────────────────────── the background sweep ───────────────────────── */

/**
 * Every 5 minutes (KV-gated): meetings that ended get their transcript fetched (checks spaced
 * out, giving up after 7 days); calls whose owner wants it are analysed; accounts set to pick
 * up every meeting are imported about every 30 minutes.
 */
export async function meetingSweep(env: Env, db: Db, analyse: (tenantId: string, eventId: string, ownerId: string) => Promise<unknown>) {
  if (env.CACHE_KV && (await env.CACHE_KV.get('meet:any').catch(() => null)) === '0') return;
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let accounts = 0;
  for (const t of tenants) {
    const due = await db.tx({ tenantId: t.tenant_id, readOnly: true }, async (tx) => ({
      n: (await tx.one<{ n: number }>(`select count(*)::int as n from integrations where tenant_id = $1 and provider = any($2::text[]) and status = 'active'`, [t.tenant_id, MEET_PROVIDERS]))?.n ?? 0,
      events: await tx.query<{ id: string; owner_id: string; online_meeting: OnlineMeeting; ends_at: Date; transcript_checks: number }>(
        `select id, owner_id, online_meeting, ends_at, transcript_checks from events
          where tenant_id = $1 and transcript_status = 'waiting' and online_meeting is not null and ends_at < now() - interval '5 minutes'
            and (transcript_checked_at is null or transcript_checked_at < now() - make_interval(mins => least(240, 10 * (transcript_checks + 1))))
          order by ends_at limit 20`,
        [t.tenant_id],
      ),
      importers: await tx.query<{ id: string }>(
        `select id from integrations where tenant_id = $1 and provider = any($2::text[]) and status = 'active' and (config ->> 'importAll')::boolean is true
            and (last_sync_at is null or last_sync_at < now() - interval '30 minutes') limit 10`,
        [t.tenant_id, MEET_PROVIDERS],
      ),
    }));
    accounts += due.n;
    for (const imp of due.importers) {
      await db
        .tx({ tenantId: t.tenant_id }, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [t.tenant_id, imp.id]);
          if (!i) return;
          try {
            await importRecent(env, tx, i, 2);
            await markOk(tx, i, { sync: true });
          } catch (e) {
            await markError(tx, i, `Import: ${(e as Error).message}`);
          }
        })
        .catch(() => undefined);
    }
    for (const ev of due.events) {
      const got = await db
        .tx({ tenantId: t.tenant_id }, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and status = 'active'`, [t.tenant_id, ev.online_meeting.integrationId]);
          const giveUp = Date.now() - new Date(ev.ends_at).getTime() > 7 * 86_400_000 || ev.transcript_checks >= 40;
          if (!i || i.config.autoFetch === false) {
            await tx.query(`update events set transcript_status = $3, transcript_checked_at = now() where tenant_id = $1 and id = $2`, [t.tenant_id, ev.id, i ? 'none' : 'not_available']);
            return null;
          }
          try {
            const text = await fetchTranscript(env, tx, i, ev.online_meeting);
            if (!text) {
              await tx.query(`update events set transcript_checks = transcript_checks + 1, transcript_checked_at = now(), transcript_status = $3, online_meeting = $4 where tenant_id = $1 and id = $2`, [
                t.tenant_id, ev.id, giveUp ? 'not_available' : 'waiting', JSON.stringify(ev.online_meeting),
              ]);
              return null;
            }
            const source = { zoom_meet: 'zoom', google_meet: 'google_meet', ms_teams_meet: 'ms_teams' }[ev.online_meeting.provider];
            await tx.query(
              `insert into meeting_notes (tenant_id, event_id, transcript, transcript_source) values ($1,$2,$3,$4)
               on conflict (tenant_id, event_id) do update set transcript = excluded.transcript, transcript_source = excluded.transcript_source, updated_at = now()`,
              [t.tenant_id, ev.id, text.slice(0, 200_000), source],
            );
            await tx.query(`update events set transcript_status = 'fetched', transcript_checked_at = now(), status = case when status = 'scheduled' then 'done' else status end where tenant_id = $1 and id = $2`, [t.tenant_id, ev.id]);
            await markOk(tx, i, { event: true });
            return i.config.autoAnalyse === false ? null : ev;
          } catch (e) {
            await markError(tx, i, `Transcript: ${(e as Error).message}`);
            await tx.query(`update events set transcript_checks = transcript_checks + 1, transcript_checked_at = now(), transcript_status = $3 where tenant_id = $1 and id = $2`, [t.tenant_id, ev.id, giveUp ? 'failed' : 'waiting']);
            return null;
          }
        })
        .catch(() => null);
      if (got) await analyse(t.tenant_id, got.id, got.owner_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'call-analysis', tenant: t.tenant_id, msg: (e as Error).message })));
    }
  }
  if (env.CACHE_KV && !accounts) await env.CACHE_KV.put('meet:any', '0', { expirationTtl: 6 * 3600 }).catch(() => undefined);
}
