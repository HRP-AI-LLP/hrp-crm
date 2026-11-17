/**
 * GeM bids the seller follows: the list from alert mails, the bid document (uploaded once, read for
 * eligibility and the documents it asks for), a fit check against the organisation (turnover from the
 * books, years since incorporation, MSE and Startup exemptions, the documents on file), the bid pack
 * (every matching document in one PDF, plus each on its own), and the pursuit through to the result.
 *
 * Submitting stays on GeM: the seller signs in there and uploads the pack.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { z } from 'zod';
import type { Env } from '../../env';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { saveFile, signedFileUrl } from '../files';
import { COMPANY_DOCS } from '../org-documents';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';
import { DOC_MAP, parseBidDocument } from './parse';

function assertGem(ctx: RecordCtx, write = false) {
  const p = ctx.principal.permissions;
  if (['books', 'billing', 'projects', 'metadata'].some((k) => hasAdmin(p, k))) return;
  const deal = objectPerm(p, 'deal');
  if (write ? deal.create : deal.read !== 'none') return;
  throw forbidden('GeM bids are for sales and the admins');
}

const COLS = `b.id, b.bid_number, b.title, b.category, b.quantity::float8 as quantity, b.ministry, b.department, b.organisation, b.bid_date::text, b.start_at, b.end_at, b.opening_at,
  b.emd_amount::float8 as emd_amount, b.epbg_percent::float8 as epbg_percent, b.min_turnover::float8 as min_turnover, b.experience_years::float8 as experience_years,
  b.mse_exempt, b.startup_exempt, b.documents_required, b.bid_type, b.status, b.corrigenda, b.last_corrigendum_at, b.document_file_id, b.notes, b.owner_id, u.full_name as owner_name,
  b.deal_id, b.created_at, b.updated_at`;

export async function listBids(ctx: RecordCtx, q: { status?: string | null; open?: boolean } = {}) {
  assertGem(ctx);
  return ctx.tx.query(
    `select ${COLS} from gem_bids b left join users u on u.tenant_id = b.tenant_id and u.id = b.owner_id
      where b.tenant_id = $1 and ($2::text is null or b.status = $2) and (not $3 or ((b.end_at is null or b.end_at > now()) and b.status in ('new','reviewing','preparing')))
      order by case when b.end_at > now() then 0 else 1 end, b.end_at nulls last, b.created_at desc limit 1000`,
    [ctx.tenantId, q.status ?? null, q.open ?? false],
  );
}

export const bidUpdateSchema = z.object({
  status: z.enum(['new', 'reviewing', 'preparing', 'submitted', 'technically_qualified', 'won', 'lost', 'skipped', 'cancelled']).optional(),
  notes: z.string().max(10000).nullish(),
  ownerId: z.string().uuid().nullish(),
  title: z.string().trim().max(1000).nullish(),
  endAt: z.string().datetime({ offset: true }).nullish(),
});

export async function updateBid(ctx: RecordCtx, id: string, input: z.infer<typeof bidUpdateSchema>) {
  assertGem(ctx, true);
  const r = await ctx.tx.one(
    `update gem_bids set status = coalesce($3, status), notes = case when $4::boolean then $5 else notes end, owner_id = case when $6::boolean then $7::uuid else owner_id end,
            title = coalesce($8, title), end_at = coalesce($9::timestamptz, end_at), updated_at = now() where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, id, input.status ?? null, input.notes !== undefined, input.notes ?? null, input.ownerId !== undefined, input.ownerId ?? null, input.title ?? null, input.endAt ?? null],
  );
  if (!r) throw notFound('Bid not found');
}

/** A bid typed in by hand (one seen on GeM without an alert). */
export async function addBid(ctx: RecordCtx, input: { bidNumber: string; title?: string | null; endAt?: string | null }) {
  assertGem(ctx, true);
  const n = input.bidNumber.trim().toUpperCase();
  if (!/^GEM\/\d{4}\/[A-Z]\/\d{4,}$/.test(n)) throw badRequest('A GeM bid number looks like GEM/2026/B/1234567');
  const r = await ctx.tx.one<{ id: string }>(
    `insert into gem_bids (tenant_id, bid_number, title, end_at, owner_id, status) values ($1,$2,$3,$4,$5,'reviewing') on conflict (tenant_id, bid_number) do update set updated_at = now() returning id`,
    [ctx.tenantId, n, input.title ?? null, input.endAt ?? null, ctx.principal.user.id],
  );
  return { id: r!.id };
}

/** The bid document (uploaded PDF and its text read by the browser): eligibility and documents asked for. */
export async function attachBidDocument(ctx: RecordCtx, env: Env, id: string, input: { name: string; bytes: Uint8Array | null; pages: string[] }) {
  assertGem(ctx, true);
  const b = await ctx.tx.one<{ bid_number: string }>(`select bid_number from gem_bids where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!b) throw notFound('Bid not found');
  const d = parseBidDocument(input.pages.join('\n'));
  if (d.bidNumber && d.bidNumber !== b.bid_number) throw badRequest(`This document is for ${d.bidNumber}, not ${b.bid_number}`);
  let fileId: string | null = null;
  if (input.bytes?.length) fileId = (await saveFile(ctx, env, { objectKey: 'gem_bid', recordId: id, name: input.name || `${b.bid_number.replace(/\//g, '-')}.pdf`, bytes: input.bytes, kind: 'document' }, { system: true })).id;
  await ctx.tx.query(
    `update gem_bids set category = coalesce($3, category), title = coalesce(title, $3), quantity = coalesce($4, quantity), ministry = coalesce($5, ministry), department = coalesce($6, department),
            organisation = coalesce($7, organisation), bid_date = coalesce($8::date, bid_date), end_at = coalesce($9::timestamptz, end_at), opening_at = coalesce($10::timestamptz, opening_at),
            emd_amount = coalesce($11, emd_amount), epbg_percent = coalesce($12, epbg_percent), min_turnover = coalesce($13, min_turnover), experience_years = coalesce($14, experience_years),
            mse_exempt = coalesce($15, mse_exempt), startup_exempt = coalesce($16, startup_exempt), documents_required = case when $17::jsonb = '[]'::jsonb then documents_required else $17::jsonb end,
            bid_type = coalesce($18, bid_type), document_file_id = coalesce($19, document_file_id), status = case when status = 'new' then 'reviewing' else status end, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, id, d.category, d.quantity, d.ministry, d.department, d.organisation, d.bidDate, d.endAt, d.openingAt, d.emdAmount, d.epbgPercent, d.minTurnover, d.experienceYears,
      d.mseExempt, d.startupExempt, JSON.stringify(d.documentsRequired), d.bidType, fileId,
    ],
  );
  return { read: d };
}

/* ───────────── fit check and documents ───────────── */

async function orgFacts(ctx: RecordCtx) {
  const t = await ctx.tx.one<{ company: any; org: any }>(`select settings -> 'company' as company, settings -> 'organisation' as org from tenants where id = $1`, [ctx.tenantId]);
  const company = { ...(t?.org ?? {}), ...(t?.company ?? {}) };
  // average turnover of the last three completed financial years, from the invoices issued
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  const fyNow = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const years = [fyNow - 3, fyNow - 2, fyNow - 1];
  const rows = await ctx.tx.query<{ fy: number; v: number }>(
    `select extract(year from invoice_date - interval '3 months')::int as fy, sum(case when doc_type = 'credit_note' then -taxable_total else taxable_total end)::float8 as v
       from invoices where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled') and doc_type in ('invoice','credit_note')
        and invoice_date >= $2::date and invoice_date < $3::date group by 1`,
    [ctx.tenantId, `${years[0]}-04-01`, `${fyNow}-04-01`],
  );
  const byYear = years.map((y) => ({ fy: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, turnover: rows.find((r) => r.fy === y)?.v ?? 0 }));
  const counted = byYear.filter((y) => y.turnover > 0);
  const docs = await ctx.tx.query<{ id: string; kind: string; label: string | null; number: string | null; valid_until: string | null; file_id: string | null; file_name: string | null; content_type: string | null; storage_key: string | null }>(
    `select d.id, d.kind, d.label, d.number, d.valid_until::text, d.file_id, f.name as file_name, f.content_type, f.storage_key
       from org_documents d left join files f on f.tenant_id = d.tenant_id and f.id = d.file_id and f.deleted_at is null
      where d.tenant_id = $1 and d.person_id is null and d.user_id is null order by d.kind, d.created_at desc`,
    [ctx.tenantId],
  );
  return {
    company,
    turnoverByYear: byYear,
    avgTurnover: counted.length ? Math.round(counted.reduce((a, y) => a + y.turnover, 0) / 3) : 0,
    yearsInBusiness: company.incorporatedOn ? Math.floor((Date.now() - Date.parse(`${company.incorporatedOn}T00:00:00Z`)) / (365.25 * 86_400_000)) : null,
    msme: !!company.udyam || docs.some((d) => d.kind === 'udyam'),
    startup: !!company.dpiitNumber || docs.some((d) => d.kind === 'startup_india'),
    docs,
  };
}

const kindName = (k: string) => COMPANY_DOCS.find((x) => x[0] === k)?.[1] ?? k;

/** Can the organisation bid, and which of its documents answer what the bid asks for. */
export async function bidCheck(ctx: RecordCtx, env: Env, id: string) {
  assertGem(ctx);
  const b = await ctx.tx.one<Record<string, any>>(`select ${COLS} from gem_bids b left join users u on u.tenant_id = b.tenant_id and u.id = b.owner_id where b.tenant_id = $1 and b.id = $2`, [ctx.tenantId, id]);
  if (!b) throw notFound('Bid not found');
  const f = await orgFacts(ctx);
  const today = new Date().toISOString().slice(0, 10);
  const usable = (kinds: string[]) => f.docs.filter((d) => kinds.includes(d.kind) && d.file_id && (!d.valid_until || d.valid_until >= today));
  const checks: { what: string; ok: boolean | null; detail: string }[] = [];
  const exempt = (b.mse_exempt && f.msme) || (b.startup_exempt && f.startup);
  const exemptWhy = b.mse_exempt && f.msme ? 'MSE exemption (Udyam)' : b.startup_exempt && f.startup ? 'Startup exemption (DPIIT)' : null;
  if (b.min_turnover != null)
    checks.push({
      what: 'Average annual turnover',
      ok: exempt ? true : f.avgTurnover >= b.min_turnover,
      detail: `Asked: ₹${Number(b.min_turnover).toLocaleString('en-IN')}. Yours (last 3 years, from invoices): ₹${f.avgTurnover.toLocaleString('en-IN')}${exemptWhy ? ` — exempt by ${exemptWhy}` : ''}`,
    });
  if (b.experience_years != null)
    checks.push({
      what: 'Years of experience',
      ok: exempt ? true : f.yearsInBusiness == null ? null : f.yearsInBusiness >= b.experience_years,
      detail: `Asked: ${b.experience_years} year(s). Yours: ${f.yearsInBusiness ?? 'set the incorporation date in Organisation'}${exemptWhy ? ` — exempt by ${exemptWhy}` : ''}`,
    });
  if (b.mse_exempt != null) checks.push({ what: 'MSE exemption', ok: b.mse_exempt ? f.msme : null, detail: b.mse_exempt ? (f.msme ? 'Available: Udyam on file' : 'Offered, but no Udyam certificate on file') : 'Not offered in this bid' });
  if (b.startup_exempt != null) checks.push({ what: 'Startup exemption', ok: b.startup_exempt ? f.startup : null, detail: b.startup_exempt ? (f.startup ? 'Available: DPIIT recognition on file' : 'Offered, but no DPIIT recognition on file') : 'Not offered in this bid' });
  if (b.end_at) checks.push({ what: 'Time left', ok: Date.parse(b.end_at) > Date.now(), detail: Date.parse(b.end_at) > Date.now() ? `Closes ${new Date(b.end_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}` : 'The bid has closed' });

  // the documents: always PAN and GST; then what the bid asks for; the exemption certificates
  const asked = (b.documents_required as string[]) ?? [];
  const wants: { asked: string; kinds: string[]; name: string }[] = [
    { asked: 'PAN', kinds: ['pan'], name: kindName('pan') },
    { asked: 'GST registration', kinds: ['gst'], name: kindName('gst') },
  ];
  for (const a of asked) {
    const m = DOC_MAP.find(([re]) => re.test(a));
    if (m) wants.push({ asked: a, kinds: m[1], name: m[2] });
    else wants.push({ asked: a, kinds: [], name: 'Prepare for this bid (as the ATC asks)' });
  }
  if (b.mse_exempt && f.msme) wants.push({ asked: 'MSE exemption', kinds: ['udyam'], name: kindName('udyam') });
  if (b.startup_exempt && f.startup) wants.push({ asked: 'Startup exemption', kinds: ['startup_india'], name: kindName('startup_india') });
  const seen = new Set<string>();
  const documents = [];
  for (const w of wants) {
    const key = `${w.asked}|${w.kinds.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const have = usable(w.kinds);
    const expired = f.docs.filter((d) => w.kinds.includes(d.kind) && d.file_id && d.valid_until && d.valid_until < today);
    documents.push({
      asked: w.asked,
      answer: w.name,
      kinds: w.kinds,
      status: !w.kinds.length ? 'manual' : have.length ? 'ready' : expired.length ? 'expired' : 'missing',
      files: await Promise.all(have.map(async (d) => ({ docId: d.id, kind: d.kind, name: d.label || kindName(d.kind), fileName: d.file_name, url: await signedFileUrl(env, ctx.tenantId, d.file_id!, true) }))),
    });
  }
  const docUrl = b.document_file_id ? await signedFileUrl(env, ctx.tenantId, b.document_file_id, true) : null;
  const corrigenda = await ctx.tx.query(`select received_at, subject, data from intake_items where tenant_id = $1 and link_object = 'gem_bid' and link_id = $2 order by received_at desc`, [ctx.tenantId, id]);
  return { bid: b, checks, documents, turnoverByYear: f.turnoverByYear, documentUrl: docUrl, history: corrigenda, ready: documents.filter((d) => d.status === 'ready').length, missing: documents.filter((d) => d.status === 'missing' || d.status === 'expired').length };
}

/** Every ready document in one PDF, with a contents page — to upload on GeM (or split as asked). */
export async function bidPack(ctx: RecordCtx, env: Env, id: string): Promise<{ name: string; bytes: Uint8Array }> {
  assertGem(ctx);
  if (!env.FILES) throw badRequest('File storage is not set up');
  const c = await bidCheck(ctx, env, id);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const cover = pdf.addPage([595, 842]);
  const company = (await ctx.tx.one<{ n: string }>(`select coalesce(settings -> 'company' ->> 'legalName', name) as n from tenants where id = $1`, [ctx.tenantId]))?.n ?? '';
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, (ch) => (ch === '₹' ? 'Rs ' : ch === '—' || ch === '–' ? '-' : ''));
  let y = 790;
  const line = (s: string, f = font, size = 11) => {
    for (let rest = ascii(s); rest.length; ) {
      const cut = rest.length > 90 ? rest.lastIndexOf(' ', 90) || 90 : rest.length;
      cover.drawText(rest.slice(0, cut), { x: 50, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
      rest = rest.slice(cut).trimStart();
      y -= size + 6;
    }
  };
  line(company, bold, 16);
  line(`Documents for ${c.bid.bid_number}`, bold, 13);
  if (c.bid.title) line(String(c.bid.title));
  if (c.bid.organisation || c.bid.department) line([c.bid.organisation, c.bid.department].filter(Boolean).join(' / '));
  y -= 10;
  let added = 0;
  const parts: { title: string; bytes: Uint8Array; type: string }[] = [];
  for (const d of c.documents.filter((x) => x.status === 'ready')) {
    for (const f of d.files) {
      const row = await ctx.tx.one<{ storage_key: string; content_type: string }>(`select f.storage_key, f.content_type from org_documents o join files f on f.tenant_id = o.tenant_id and f.id = o.file_id where o.tenant_id = $1 and o.id = $2`, [ctx.tenantId, f.docId]);
      const obj = row && (await env.FILES.get(row.storage_key));
      if (obj) parts.push({ title: `${d.asked}: ${f.name}`, bytes: new Uint8Array(await obj.arrayBuffer()), type: row!.content_type });
    }
  }
  const done = new Set<string>();
  for (const p of parts) {
    const key = `${p.bytes.length}:${p.title.split(': ')[1]}`;
    if (done.has(key)) continue;
    done.add(key);
    const first = pdf.getPageCount() + 1;
    try {
      if (p.type === 'application/pdf') {
        const src = await PDFDocument.load(p.bytes, { ignoreEncryption: true });
        for (const pg of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(pg);
      } else if (p.type === 'image/png' || p.type === 'image/jpeg') {
        const img = p.type === 'image/png' ? await pdf.embedPng(p.bytes) : await pdf.embedJpg(p.bytes);
        const page = pdf.addPage([595, 842]);
        const s = Math.min(515 / img.width, 762 / img.height, 1);
        page.drawImage(img, { x: (595 - img.width * s) / 2, y: (842 - img.height * s) / 2, width: img.width * s, height: img.height * s });
      } else continue;
      added++;
      line(`${added}. ${p.title} — page ${first}`);
    } catch {
      line(`(could not add ${p.title}: the file may be protected)`);
    }
  }
  const missing = c.documents.filter((d) => d.status !== 'ready');
  if (missing.length) {
    y -= 8;
    line('Still to prepare:', bold);
    for (const m of missing) line(`- ${m.asked}: ${m.answer}${m.status === 'expired' ? ' (on file but expired)' : ''}`);
  }
  if (!added) throw badRequest('No document on file matches this bid yet: upload them in Organisation → Documents');
  return { name: `${c.bid.bid_number.replace(/\//g, '-')}-documents.pdf`, bytes: await pdf.save() };
}

/** The bid as a deal (the buyer organisation as the account), to forecast and follow up. */
export async function bidToDeal(ctx: RecordCtx, id: string): Promise<{ dealId: string; events: RecordEvent[] }> {
  assertGem(ctx, true);
  const b = await ctx.tx.one<Record<string, any>>(`select * from gem_bids where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!b) throw notFound('Bid not found');
  if (b.deal_id) return { dealId: b.deal_id, events: [] };
  const events: RecordEvent[] = [];
  const buyer = [b.organisation, b.department, b.ministry].find((x) => x && String(x).trim()) as string | undefined;
  let accountId: string | null = null;
  if (buyer) {
    accountId = (await ctx.tx.one<{ id: string }>(`select id from accounts where tenant_id = $1 and lower(name) = lower($2) and deleted_at is null`, [ctx.tenantId, buyer]))?.id ?? null;
    if (!accountId) {
      const a = await createRecord(ctx, 'account', { name: buyer, account_type: 'government' }).catch(() => createRecord(ctx, 'account', { name: buyer }));
      accountId = String(a.record.id);
      events.push(...a.events);
    }
  }
  const d = await createRecord(ctx, 'deal', { name: `${b.bid_number}${b.title ? ` — ${String(b.title).slice(0, 150)}` : ''}`, account_id: accountId, close_date: b.end_at ? new Date(b.end_at).toISOString().slice(0, 10) : null });
  events.push(...d.events);
  await ctx.tx.query(`update gem_bids set deal_id = $3, status = case when status in ('new','reviewing') then 'preparing' else status end, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, d.record.id]);
  return { dealId: String(d.record.id), events };
}
