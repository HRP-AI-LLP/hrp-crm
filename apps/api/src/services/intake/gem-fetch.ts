/**
 * A followed bid read from GeM itself: the public bid search (bidplus.gem.gov.in/all-bids) gives the
 * bid's id, item, quantity, ministry, department and dates; the bid document (showbidDocument/<id>) is
 * downloaded and read (eligibility, EMD, ePBG, documents asked for, contacts…), and the buyer's files it
 * links to (scope of work, ATC, specifications, payment terms…) are downloaded and kept on the bid.
 *
 * Only public pages are read; nothing is signed in to and nothing is submitted.
 */
import type { Db } from '../../lib/db';
import type { Env } from '../../env';
import { badRequest, notFound } from '../../lib/errors';
import { pdfLines, pdfLinks } from '../../lib/pdf-lines';
import { saveFile, signedFileUrl } from '../files';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { applyBidRead } from './gem';
import { parseBidDocument } from './parse';

const BASE = 'https://bidplus.gem.gov.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_LINKED = 12;

export interface GemSession {
  cookie: string;
  token: string;
  /** the cookies by name: replies may set new ones (load-balancer and session cookies) */
  jar?: Map<string, string>;
}

export interface GemFound {
  gemId: number;
  bidNumber: string;
  category: string | null;
  quantity: number | null;
  ministry: string | null;
  department: string | null;
  startAt: string | null;
  endAt: string | null;
  bidType: number | null;
  parentId: number | null;
  parentNumber: string | null;
  cancelled: boolean;
  documentUrl: string;
}

type Fetcher = typeof fetch;

async function get(f: Fetcher, url: string, init: RequestInit = {}) {
  return f(url, { ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
}

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[]; getAll?: (n: string) => string[] };
  return h.getSetCookie?.() ?? h.getAll?.('set-cookie') ?? (h.get('set-cookie') ?? '').split(/,(?=\s*[^;,=\s]+=)/);
}

function keep(jar: Map<string, string>, res: Response) {
  for (const c of setCookies(res)) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    if (i > 0) jar.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
  }
}

const cookieOf = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** The search page sets the session cookies and carries the form token the search needs. */
export async function gemSession(f: Fetcher = fetch): Promise<GemSession> {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    const res = await get(f, `${BASE}/all-bids`, { headers: { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-IN,en;q=0.9' } });
    last = res.status;
    if (!res.ok) continue;
    const html = await res.text();
    const token = /csrf_bd_gem_nk['"]?\s*[:=]\s*['"]([0-9a-f]{16,})['"]/i.exec(html)?.[1];
    if (!token) continue;
    const jar = new Map<string, string>();
    keep(jar, res);
    return { cookie: cookieOf(jar), token, jar };
  }
  throw new Error(last ? `GeM's bid search page answered ${last} (GeM may be busy; it is tried again in a few minutes)` : 'GeM changed its bid search page (no form token found)');
}

/** GeM writes Indian times with a "Z": 15:00 IST comes as 15:00:00Z. */
export const gemTime = (s: unknown) => {
  const v = Array.isArray(s) ? s[0] : s;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v.endsWith('Z') ? v : `${v}Z`);
  return Number.isFinite(t) ? new Date(t - 5.5 * 3_600_000).toISOString() : null;
};

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) ?? null;
const text = (v: unknown) => {
  const x = first(v);
  return typeof x === 'string' && x.trim() ? x.trim() : null;
};

/** One search on GeM. GeM's load balancer sometimes answers 403/404 to a session it has not seen: a new session and another try. */
async function search(s: GemSession, payload: unknown, f: Fetcher) {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, 700 * attempt));
      Object.assign(s, await gemSession(f));
    }
    const res = await get(f, `${BASE}/all-bids-data`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-requested-with': 'XMLHttpRequest',
        origin: BASE,
        referer: `${BASE}/all-bids`,
        ...(s.cookie ? { cookie: s.cookie } : {}),
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload), csrf_bd_gem_nk: s.token }).toString(),
    });
    last = res.status;
    if (s.jar) {
      keep(s.jar, res);
      s.cookie = cookieOf(s.jar);
    }
    if (!res.ok) continue;
    const j = (await res.json().catch(() => null)) as { code?: number; response?: { response?: { docs?: Record<string, unknown>[] } } } | null;
    if (j?.response?.response) return j.response.response.docs ?? [];
  }
  throw new Error(`GeM answered ${last || 'with something unreadable'} for the bid search three times; it is tried again in a few minutes`);
}

/** Finds a bid by number among ongoing, finished and cancelled bids. */
export async function gemLookup(s: GemSession, bidNumber: string, f: Fetcher = fetch): Promise<GemFound | null> {
  for (const status of ['ongoing_bids', 'bidrastatus', 'cancelled_bids']) {
    const payload = {
      param: { searchBid: bidNumber, searchType: 'fullText' },
      filter: { bidStatusType: status, byType: 'all', highBidValue: '', byEndDate: { from: '', to: '' }, sort: 'Bid-End-Date-Oldest' },
    };
    const docs = await search(s, payload, f);
    const doc = docs.find((d) => text(d.b_bid_number) === bidNumber);
    if (!doc) continue;
    const gemId = Number(first(doc.b_id) ?? doc.id);
    const type = Number(first(doc.b_bid_type) ?? 1);
    const path = type === 5 ? 'showdirectradocumentPdf' : type === 2 ? 'showradocumentPdf' : 'showbidDocument';
    const qty = Number(first(doc.b_total_quantity));
    return {
      gemId,
      bidNumber,
      category: text(doc.b_category_name) ?? text(doc.bd_category_name),
      quantity: Number.isFinite(qty) ? qty : null,
      ministry: text(doc.ba_official_details_minName),
      department: text(doc.ba_official_details_deptName),
      startAt: gemTime(doc.final_start_date_sort),
      endAt: gemTime(doc.final_end_date_sort),
      bidType: type,
      parentId: Number(first(doc.b_id_parent)) || null,
      parentNumber: text(doc.b_bid_number_parent),
      cancelled: status === 'cancelled_bids',
      documentUrl: `${BASE}/${path}/${gemId}`,
    };
  }
  return null;
}

/** What a link in the bid document is (null: not a file worth keeping). */
export function linkLabel(url: string, fileLabels: Record<string, string>): { label: string; download: boolean } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)gem\.gov\.in$/i.test(u.hostname)) return null;
  const file = decodeURIComponent(u.pathname.split('/').pop() ?? '');
  if (fileLabels[file]) return { label: fileLabels[file]!, download: true };
  if (/\/gtc\//i.test(u.pathname)) return { label: 'GeM General Terms and Conditions', download: false };
  if (/\/bidsla\//i.test(u.pathname)) return { label: 'Service levels (on GeM)', download: false };
  if (/downloadBuyerDoc/i.test(u.pathname)) return { label: 'Buyer document (specification / evaluation)', download: true };
  const path = u.searchParams.get('fileDownloadPath') ?? '';
  if (/ATC_/i.test(path)) return { label: 'Buyer ATC (additional terms)', download: true };
  if (/\.(pdf|docx?|xlsx?|zip)$/i.test(file) || path) return { label: 'Buyer file', download: true };
  return null;
}

const fileNameOf = (res: Response, url: string) => {
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) return decodeURIComponent(m[1]!);
  const u = new URL(url);
  return decodeURIComponent((u.searchParams.get('fileDownloadPath') ?? u.pathname).split('/').pop() || 'file');
};

async function download(f: Fetcher, url: string, cookie?: string): Promise<{ bytes: Uint8Array; name: string } | null> {
  const res = await get(f, url, cookie ? { headers: { cookie } } : {});
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) return null;
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FILE) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_FILE) return null;
  return { bytes, name: fileNameOf(res, url) };
}

const sha = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');

export interface BidFile {
  label: string;
  url: string;
  name: string | null;
  fileId: string | null;
  size: number | null;
  sha: string | null;
  at: string;
}

/** Reads one bid from GeM and keeps what it finds. Network first, then one short transaction. */
export async function fetchBidFromGem(env: Env, db: Db, tenantId: string, bidId: string, opts: { session?: GemSession; fetcher?: Fetcher; review?: boolean } = {}) {
  const f = opts.fetcher ?? fetch;
  const run = <T>(fn: (ctx: RecordCtx) => Promise<T>) =>
    db.tx({ tenantId }, async (tx) => {
      const ctx = await systemCtxFor(env, tx, tenantId);
      if (!ctx) throw new Error('workspace not found');
      return fn(ctx);
    });
  const bid = await run((ctx) => ctx.tx.one<{ bid_number: string; files: BidFile[] }>(`select bid_number, files from gem_bids where tenant_id = $1 and id = $2`, [tenantId, bidId]));
  if (!bid) throw notFound('Bid not found');
  try {
    const s = opts.session ?? (await gemSession(f));
    const found = await gemLookup(s, bid.bid_number, f);
    if (!found) throw new Error('Not found in GeM’s public bid search yet (new bids can take a few minutes to appear)');
    const main = await download(f, found.documentUrl, s.cookie);
    const pages = main ? await pdfLines(main.bytes) : null;
    const read = pages ? parseBidDocument(pages.join('\n')) : null;
    const links = main ? await pdfLinks(main.bytes) : [];
    const have = new Set((bid.files ?? []).map((x) => x.sha).filter(Boolean));
    const now = new Date().toISOString();
    const got: { label: string; url: string; file: { bytes: Uint8Array; name: string } | null; sha: string | null }[] = [];
    if (main) got.push({ label: 'Bid document', url: found.documentUrl, file: main, sha: await sha(main.bytes) });
    if (found.parentId && found.parentId !== found.gemId) {
      const p = await download(f, `${BASE}/showbidDocument/${found.parentId}`, s.cookie).catch(() => null);
      if (p) got.push({ label: `Parent bid ${found.parentNumber ?? ''}`.trim(), url: `${BASE}/showbidDocument/${found.parentId}`, file: p, sha: await sha(p.bytes) });
    }
    let n = 0;
    for (const url of links) {
      const what = linkLabel(url, read?.fileLabels ?? {});
      if (!what) continue;
      if (!what.download || n >= MAX_LINKED) {
        got.push({ label: what.label, url, file: null, sha: null });
        continue;
      }
      n++;
      const file = await download(f, url, s.cookie).catch(() => null);
      got.push({ label: what.label, url, file, sha: file ? await sha(file.bytes) : null });
    }
    return await run(async (ctx) => {
      const files: BidFile[] = [...(bid.files ?? [])];
      let mainFileId: string | null = null;
      for (const g of got) {
        if (g.sha && have.has(g.sha)) continue; // the same file is kept once
        if (!g.sha && files.some((x) => x.url === g.url)) continue;
        let fileId: string | null = null;
        if (g.file && env.FILES) {
          const name = g.label === 'Bid document' ? `${bid.bid_number.replace(/\//g, '-')}${files.some((x) => x.label === 'Bid document') ? `-${now.slice(0, 10)}` : ''}.pdf` : g.file.name;
          fileId = (await saveFile(ctx, env, { objectKey: 'gem_bid', recordId: bidId, name, bytes: g.file.bytes, kind: 'document', description: g.label }, { system: true }).catch(() => null))?.id ?? null;
        }
        if (g.label === 'Bid document' && fileId) mainFileId = fileId;
        files.push({ label: g.label, url: g.url, name: g.file?.name ?? null, fileId, size: g.file?.bytes.length ?? null, sha: g.sha, at: now });
        if (g.sha) have.add(g.sha);
      }
      if (read) {
        if (read.bidNumber && read.bidNumber !== bid.bid_number) throw new Error(`GeM returned the document of ${read.bidNumber}`);
        await applyBidRead(ctx, bidId, read, mainFileId, opts.review ?? false);
      }
      await ctx.tx.query(
        `update gem_bids set gem_id = $3, category = coalesce($4, category), title = coalesce(title, $4), quantity = coalesce(quantity, $5), ministry = coalesce($6, ministry),
                department = coalesce($7, department), start_at = coalesce($8::timestamptz, start_at), end_at = coalesce($9::timestamptz, end_at), files = $10::jsonb,
                details = details || $11::jsonb, status = case when $12::boolean and status in ('new','reviewing','preparing') then 'cancelled' else status end,
                fetched_at = now(), fetch_error = null, fetch_attempts = 0, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [
          tenantId, bidId, found.gemId, found.category, found.quantity, found.ministry, found.department, found.startAt, found.endAt, JSON.stringify(files),
          JSON.stringify({ 'GeM page': found.documentUrl, ...(found.bidType && found.bidType !== 1 ? { Kind: found.bidType === 5 ? 'Direct reverse auction' : 'Reverse auction' } : {}) }),
          found.cancelled,
        ],
      );
      return { found: true, files: files.length, read: !!read };
    });
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 480) || 'GeM could not be read';
    await run((ctx) => ctx.tx.query(`update gem_bids set fetch_error = $3, fetch_attempts = fetch_attempts + 1, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, bidId, msg])).catch(() => undefined);
    throw badRequest(`GeM: ${msg}`);
  }
}

/** Every 5 minutes: bids not read from GeM yet (or changed by a corrigendum since), a few at a time. */
export async function gemDetailsSweep(env: Env, db: Db, f: Fetcher = fetch) {
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let session: GemSession | null = null;
  for (const t of tenants) {
    const due = await db
      .tx({ tenantId: t.tenant_id, readOnly: true }, (tx) =>
        tx.query<{ id: string }>(
          `select id from gem_bids where tenant_id = $1 and status not in ('skipped','cancelled','lost','won')
              and (fetched_at is null or (last_corrigendum_at is not null and last_corrigendum_at > fetched_at))
              and fetch_attempts < 6 and (fetch_error is null or updated_at < now() - (interval '20 minutes' * fetch_attempts))
              and (end_at is null or end_at > now() - interval '7 days')
            order by end_at nulls last limit 8`,
          [t.tenant_id],
        ),
      )
      .catch(() => []);
    for (const d of due) {
      try {
        session ??= await gemSession(f);
      } catch {
        return; // GeM is down: try again next time
      }
      await fetchBidFromGem(env, db, t.tenant_id, d.id, { session, fetcher: f }).catch(() => undefined);
    }
  }
}

/** The bid's files with links to open them. */
export async function bidFiles(ctx: RecordCtx, env: Env, files: BidFile[]) {
  return Promise.all((files ?? []).map(async (x) => ({ ...x, open: x.fileId ? await signedFileUrl(env, ctx.tenantId, x.fileId, true) : null })));
}
