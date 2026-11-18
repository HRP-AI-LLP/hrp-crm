/**
 * Mail intake: reading a mailbox over IMAP (a local test server), GeM alerts and corrigenda into GeM
 * bids, mailed invoices into draft bills, and a GeM bid checked against the organisation with its
 * documents put together in one PDF.
 */
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseMail } from '../src/lib/mime';
import { classify, parseBidDocument, parseCorrigendum, parseNewBids } from '../src/services/intake/parse';
import { nameInText, sameName } from '../src/services/books/narration';
import { fakeR2, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let token = '';
const ids: Record<string, string> = {};
const OWN_GSTIN = '09AASFH6805J1ZT';
const VENDOR_GSTIN = '09ABCDE1234F1Z5';

/* ───────────── test mail ───────────── */

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/.{76}/g, '$&\r\n');
let invoicePdf: Uint8Array = new Uint8Array();

function mail(o: { id: string; from: string; subject: string; html?: string; text?: string; pdf?: { name: string; bytes: Uint8Array }; pdfs?: { name: string; bytes: Uint8Array }[]; date?: string }) {
  const head = [`Message-ID: <${o.id}>`, `Date: ${o.date ?? 'Tue, 17 Nov 2026 15:51:20 +0530'}`, `From: ${o.from}`, 'To: harsha.rani@hrpai.in', `Subject: ${o.subject}`, 'MIME-Version: 1.0'];
  const files = o.pdfs ?? (o.pdf ? [o.pdf] : []);
  if (!files.length) return [...head, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', (o.html ?? '').replace(/=/g, '=3D'), ''].join('\r\n');
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.text ?? 'Please find the invoice attached.',
    ...files.flatMap((f) => ['--XYZ', `Content-Type: application/pdf; name="${f.name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${f.name}"`, '', b64(f.bytes)]),
    '--XYZ--',
    '',
  ].join('\r\n');
}

const NEW_BIDS_HTML = `<p>Dear Seller/Service provider,</p><p>New bid(s) matching your offered categories have been published on GeM portal.</p>
<table><tr><th>Bid Number</th><th>Items</th><th>Quantity</th><th>Bid Start Date</th><th>Bid End Date</th></tr>
<tr><td>GEM/2026/B/8301001</td><td>Custom Bid for Services - Website Development and Maintenance</td><td>1</td><td>17-11-2026 10:00:00</td><td>28-11-2026 15:00:00</td></tr>
<tr><td>GEM/2026/B/8301002</td><td>Software Development Service - AI chatbot</td><td>1</td><td>17-11-2026 11:30:00</td><td>01-12-2026 18:00:00</td></tr>
</table><p>Regards, Team GeM</p>`;
const CORR_HTML = `<p>Dear Sir/Madam,</p><p>A corrigendum dated 2026-11-17 15:51:20 has been issued for Bid number GEM/2026/B/8166366 dated 21-October-2026.</p><p>Please login to the GeM portal to view more details.</p>`;

let messages: { uid: number; raw: string }[] = [];

/* ───────────── a tiny IMAP server ───────────── */

let server: net.Server;
let port = 0;
let logins: string[] = [];

function startImap() {
  server = net.createServer((s) => {
    s.write('* OK test IMAP ready\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        const send = (x: string) => s.write(Buffer.from(x, 'latin1'));
        if (/^LOGIN/i.test(cmd)) {
          logins.push(cmd);
          if (cmd.includes('"wrong"')) send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          else send(`${tag} OK LOGIN completed\r\n`);
        } else if (/^EXAMINE/i.test(cmd)) send(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 42] UIDs valid\r\n* OK [UIDNEXT ${messages.length + 1}] next\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        else if (/^UID SEARCH/i.test(cmd)) {
          const m = /UID (\d+):\*/i.exec(cmd);
          const from = m ? Number(m[1]) : 1;
          const hits = messages.filter((x) => x.uid >= from).map((x) => x.uid);
          if (m && !hits.length && messages.length) hits.push(messages[messages.length - 1]!.uid); // n:* quirk
          send(`* SEARCH ${hits.join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
        } else if (/^UID FETCH/i.test(cmd)) {
          const set = /UID FETCH (\S+)/i.exec(cmd)![1]!.split(',').map(Number);
          const full = /BODY\.PEEK\[\]/i.test(cmd);
          let n = 0;
          for (const m of messages.filter((x) => set.includes(x.uid))) {
            n++;
            const headerEnd = m.raw.indexOf('\r\n\r\n');
            const part = full ? m.raw : m.raw.slice(0, headerEnd + 4);
            send(`* ${n} FETCH (UID ${m.uid} RFC822.SIZE ${m.raw.length} ${full ? 'BODY[]' : 'BODY[HEADER.FIELDS (FROM SUBJECT)]'} {${part.length}}\r\n${part})\r\n`);
          }
          send(`${tag} OK FETCH completed\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) {
          send(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
          s.end();
        } else send(`${tag} BAD unknown\r\n`);
      }
    });
    s.on('error', () => undefined);
  });
  return new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as net.AddressInfo).port), r())));
}

async function pdfWith(lines: string[]) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => p.drawText(l, { x: 50, y: 790 - i * 18, size: 11, font: f }));
  return d.save();
}

async function upload(path: string, bytes: Uint8Array, name: string) {
  const res = await h.app.request(`http://synapse.test${path}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes,
  }, h.env);
  expect(res.status, await res.clone().text()).toBe(200);
}

beforeAll(async () => {
  invoicePdf = await pdfWith(['TAX INVOICE', 'Cloud Nine Hosting', `GSTIN: ${VENDOR_GSTIN}`]);
  await startImap();
  h = await makeHarness('synapse_test_intake');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  token = (await h.login('acme', 'owner@acme.test')).token;
  api = h.as('acme', token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', gstin: OWN_GSTIN, state: 'Uttar Pradesh' } } });
  messages = [
    { uid: 1, raw: mail({ id: 'gem-new-1@gem.gov.in', from: 'noreply <noreply@gem.gov.in>', subject: 'New bid(s) published on GeM portal.', html: NEW_BIDS_HTML }) },
    { uid: 2, raw: mail({ id: 'gem-corr-1@gem.gov.in', from: 'noreply <noreply@gem.gov.in>', subject: 'Bid # GEM/2026/B/8166366: Corrigendum issued on GeM', html: CORR_HTML }) },
    { uid: 3, raw: mail({ id: 'personal-1@example.com', from: 'Friend <friend@example.com>', subject: 'Dinner on Sunday?', html: '<p>See you!</p>' }) },
    { uid: 4, raw: mail({ id: 'inv-1@cloudnine.in', from: 'Cloud Nine Billing <billing@cloudnine.in>', subject: 'Tax Invoice CN/26-27/0457 for November', pdf: { name: 'CN-26-27-0457.pdf', bytes: invoicePdf } }) },
  ];
}, 120_000);

afterAll(() => server?.close());

describe('reading mail', () => {
  it('parses MIME: encoded subject, quoted-printable HTML, base64 attachment', () => {
    const m = parseMail(messages[3]!.raw);
    expect(m).toMatchObject({ messageId: 'inv-1@cloudnine.in', from: { name: 'Cloud Nine Billing', address: 'billing@cloudnine.in' }, subject: 'Tax Invoice CN/26-27/0457 for November' });
    expect(m.attachments[0]).toMatchObject({ filename: 'CN-26-27-0457.pdf', contentType: 'application/pdf' });
    expect(m.attachments[0]!.bytes.length).toBe(invoicePdf.length);
    const e = parseMail('Subject: =?UTF-8?B?4oK5IDUwLDAwMCBpbnZvaWNl?=\r\nFrom: =?utf-8?Q?R=C3=A9mi?= <a@b.in>\r\n\r\nhi');
    expect(e.subject).toBe('₹ 50,000 invoice');
    expect(e.from).toEqual({ name: 'Rémi', address: 'a@b.in' });
  });

  it('knows which mail matters from the headers', () => {
    const r = { gem: true, bills: true };
    expect(classify({ from: 'noreply@gem.gov.in', subject: 'New bid(s) published on GeM portal.', contentType: 'text/html' }, r)).toBe('gem_new_bids');
    expect(classify({ from: 'noreply@gem.gov.in', subject: 'Bid # GEM/2026/B/8166366: Corrigendum issued on GeM', contentType: 'text/html' }, r)).toBe('gem_corrigendum');
    expect(classify({ from: 'billing@aws.com', subject: 'Your invoice is available', contentType: 'multipart/mixed' }, r)).toBe('bill');
    expect(classify({ from: 'billing@aws.com', subject: 'Your invoice is available', contentType: 'text/html' }, r)).toBeNull();
    expect(classify({ from: 'a@bank.in', subject: 'OTP for your invoice payment', contentType: 'multipart/mixed' }, r)).toBeNull();
    expect(classify({ from: 'friend@example.com', subject: 'Dinner', contentType: 'multipart/mixed' }, r)).toBeNull();
    expect(classify({ from: 'noreply@gem.gov.in', subject: 'New bid(s) published on GeM portal.', contentType: 'text/html' }, { gem: false, bills: true })).toBeNull();
  });

  it('reads the bids, corrigenda and bid documents of GeM', () => {
    const text = parseMail(messages[0]!.raw).text;
    const bids = parseNewBids(text);
    expect(bids.map((b) => b.bidNumber)).toEqual(['GEM/2026/B/8301001', 'GEM/2026/B/8301002']);
    expect(bids[0]).toMatchObject({ title: 'Custom Bid for Services - Website Development and Maintenance', endAt: '2026-11-28T09:30:00.000Z' });
    expect(parseCorrigendum('Bid # GEM/2026/B/8166366: Corrigendum issued on GeM', 'A corrigendum dated 2026-11-17 15:51:20 has been issued for Bid number GEM/2026/B/8166366 dated 21-October-2026.')).toEqual({
      bidNumber: 'GEM/2026/B/8166366', corrigendumAt: '2026-11-17T10:21:20.000Z', bidDate: '2026-10-21',
    });
  });
});

describe('a mailbox over IMAP', () => {
  it('refuses plain IMAP to another host, and reports a wrong password', async () => {
    expect((await api('POST', '/api/v1/intake/mailboxes', { label: 'x', email: 'a@hrpai.in', host: 'imap.example.com', port: 143, tls: false, password: 'x' })).status).toBe(400);
    const bad = await api('POST', '/api/v1/intake/mailboxes', { label: 'Bad', email: 'bad@hrpai.in', host: '127.0.0.1', port, tls: false, password: 'wrong' });
    const s = await api('POST', `/api/v1/intake/mailboxes/${bad.json.id}/sync`);
    expect(s.status).toBe(400);
    expect(s.json.error.message).toMatch(/Sign-in failed/);
    expect((await api('GET', '/api/v1/intake/mailboxes')).json.mailboxes.find((m: any) => m.id === bad.json.id)).toMatchObject({ status: 'error', has_password: true });
    await api('DELETE', `/api/v1/intake/mailboxes/${bad.json.id}`);
  });

  it('takes in the GeM alerts and the invoice, and nothing else; reads only what is new next time', async () => {
    const mb = await api('POST', '/api/v1/intake/mailboxes', { label: "Harsha's mail", email: 'harsha.rani@hrpai.in', host: '127.0.0.1', port, tls: false, password: 's3cret', firstDays: 30 });
    expect(mb.status, JSON.stringify(mb.json)).toBe(201);
    ids.mb = mb.json.id;
    const s = await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`);
    expect(s.json, JSON.stringify(s.json)).toEqual({ seen: 4, taken: 3, newBids: 2 });
    expect(logins.at(-1)).toBe('LOGIN "harsha.rani@hrpai.in" "s3cret"');
    const items = (await api('GET', '/api/v1/intake/items')).json as any[];
    expect(items.map((i) => i.kind).sort()).toEqual(['bill', 'gem_corrigendum', 'gem_new_bids']);
    expect(items.some((i) => /Dinner/.test(i.subject))).toBe(false);
    const bids = (await api('GET', '/api/v1/intake/gem')).json as any[];
    expect(bids.map((b) => b.bid_number).sort()).toEqual(['GEM/2026/B/8166366', 'GEM/2026/B/8301001', 'GEM/2026/B/8301002']);
    expect(bids.find((b) => b.bid_number === 'GEM/2026/B/8166366')).toMatchObject({ corrigenda: 1, bid_date: '2026-10-21' });
    // nothing new: nothing taken
    expect((await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`)).json).toMatchObject({ taken: 0 });
    // a second corrigendum arrives
    messages.push({ uid: 5, raw: mail({ id: 'gem-corr-2@gem.gov.in', from: 'noreply@gem.gov.in', subject: 'Bid # GEM/2026/B/8166366: Corrigendum issued on GeM', html: CORR_HTML.replace('15:51:20', '18:02:00') }) });
    expect((await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`)).json).toMatchObject({ seen: 1, taken: 1, newBids: 0 });
    expect(((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.bid_number === 'GEM/2026/B/8166366').corrigenda).toBe(2);
  });

  it('a mailed invoice becomes a draft bill with the vendor found or added and the PDF attached', async () => {
    const item = ((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[])[0];
    expect(item.attachments[0]).toMatchObject({ name: 'CN-26-27-0457.pdf', contentType: 'application/pdf' });
    const text = [
      'TAX INVOICE', 'Cloud Nine Hosting Pvt Ltd', `GSTIN: ${VENDOR_GSTIN}`, 'Invoice No: CN/26-27/0457', 'Invoice Date: 05-11-2026',
      'Bill To: HRP AI LLP', `GSTIN: ${OWN_GSTIN}`, 'Description HSN Qty Rate Amount', 'Cloud server hosting 998315 1 10000.00 10000.00',
      'Taxable Value 10000.00', 'CGST @ 9% 900.00', 'SGST @ 9% 900.00', 'Total 11800.00',
    ].join('\n');
    const r = await api('POST', `/api/v1/intake/items/${item.id}/read`, { fileId: item.attachments[0].fileId, pages: [text] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ party: { gstin: VENDOR_GSTIN }, ours: true, data: { number: 'CN/26-27/0457', date: '2026-11-05', taxable: 10000 } });
    const b = await api('POST', `/api/v1/intake/items/${item.id}/bill`, { fileId: item.attachments[0].fileId, vendorName: 'Cloud Nine Hosting Pvt Ltd' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const bill = (await api('GET', `/api/v1/records/bill/${b.json.billId}`)).json;
    expect(bill).toMatchObject({ vendor_ref: 'CN/26-27/0457', status: 'draft' });
    expect(Number(bill.grand_total)).toBe(11800);
    const v = (await api('GET', `/api/v1/records/vendor/${b.json.vendorId}`)).json;
    expect(v).toMatchObject({ name: 'Cloud Nine Hosting Pvt Ltd', gstin: VENDOR_GSTIN });
    const files = (await api('GET', `/api/v1/files?object=bill&id=${b.json.billId}`)).json;
    expect(JSON.stringify(files)).toContain('CN-26-27-0457.pdf');
    expect(((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[])[0]).toMatchObject({ status: 'done', link_object: 'bill' });
    // the same invoice again is refused
    expect((await api('POST', `/api/v1/intake/items/${item.id}/bill`, { fileId: item.attachments[0].fileId })).status).toBe(400);
  });
});

describe('a personal mailbox', () => {
  it('takes in only the bills and payments that name the business (GSTIN, name or a partner)', async () => {
    await api('POST', '/api/v1/books/desk/own/persons', { name: 'Harsha Rani', identifiers: [] });
    const airtel = await pdfWith(['Airtel Postpaid bill', 'Customer: Prashant Srivastava', 'Amount due Rs 599']);
    const amazon = await pdfWith(['Tax Invoice', 'Amazon Seller Services', `Buyer GSTIN: ${OWN_GSTIN}`, 'Logitech keyboard 2,499.00']);
    messages.push(
      { uid: 6, raw: mail({ id: 'airtel-1@airtel.in', from: 'Airtel <bills@airtel.in>', subject: 'Your Airtel bill for November', pdf: { name: 'airtel-bill.pdf', bytes: airtel } }) },
      { uid: 7, raw: mail({ id: 'amazon-1@amazon.in', from: 'Amazon <auto-confirm@amazon.in>', subject: 'Invoice for your order 404-123', pdf: { name: 'invoice.pdf', bytes: amazon } }) },
      { uid: 8, raw: mail({ id: 'upi-1@bank.in', from: 'Bank <alerts@bank.in>', subject: 'Payment received: Rs 25,000', html: '<p>Rs 25,000 received from Harsha Rani by UPI.</p>' }) },
      { uid: 9, raw: mail({ id: 'upi-2@bank.in', from: 'Bank <alerts@bank.in>', subject: 'Payment received: Rs 300', html: '<p>Rs 300 received from Ramesh by UPI.</p>' }) },
    );
    const mb = await api('POST', '/api/v1/intake/mailboxes', { label: 'Personal Gmail', email: 'prashant@gmail.com', host: '127.0.0.1', port, tls: false, password: 'p', businessOnly: true, firstDays: 30 });
    expect(mb.status, JSON.stringify(mb.json)).toBe(201);
    const s = await api('POST', `/api/v1/intake/mailboxes/${mb.json.id}/sync`);
    expect(s.json, JSON.stringify(s.json)).toMatchObject({ taken: 2 });
    const items = (await api('GET', '/api/v1/intake/items?kind=docs&status=new')).json as any[];
    const mine = items.filter((i) => i.mailbox === 'prashant@gmail.com');
    expect(mine.map((i) => [i.kind, i.matched_on]).sort()).toEqual([['bill', OWN_GSTIN], ['payment', 'harsha rani']]);
    expect(items.some((i) => /Airtel|Rs 300/.test(i.subject))).toBe(false);
  });
});

describe('a GeM bid: eligibility, documents, the bid pack', () => {
  const BID_TEXT = `Bid Details/बिड विवरण
बिड संख्या/Bid Number: GEM/2026/B/8301001
दिनांक/Dated: 17-11-2026
बिड बंद होने की तारीख/समय /Bid End Date/Time 28-11-2026 15:00:00
बिड खुलने की तारीख/समय /Bid Opening Date/Time 28-11-2026 15:30:00
मंत्रालय/राज्य का नाम/Ministry/State Name Ministry of Electronics and Information Technology
विभाग का नाम/Department Name Department of Electronics and Information Technology
संगठन का नाम/Organisation Name National Informatics Centre
कुल मात्रा/Total Quantity 1
वस्तु श्रेणी /Item Category Custom Bid for Services - Website Development and Maintenance
Minimum Average Annual Turnover of the bidder (For 3 Years) 50 Lakh (s)
Years of Past Experience Required for same/similar service 3 Year (s)
MSE Exemption for Years Of Experience and Turnover Yes
Startup Exemption for Years Of Experience and Turnover Yes
विक्रेता से मांगे गए दस्तावेज़/Document required from seller Experience Criteria,Bidder Turnover,Certificate (Requested in ATC)
*In case any bidder is seeking exemption from Experience / Turnover Criteria, the supporting documents to prove his eligibility for exemption must be uploaded for evaluation by the buyer
बिड का प्रकार/Type of Bid Two Packet Bid
EMD Detail
ePBG Percentage(%) 5.00`;

  it('reads the bid document', () => {
    const d = parseBidDocument(BID_TEXT);
    expect(d).toMatchObject({
      bidNumber: 'GEM/2026/B/8301001', bidDate: '2026-11-17', endAt: '2026-11-28T09:30:00.000Z', organisation: 'National Informatics Centre', quantity: 1,
      category: 'Custom Bid for Services - Website Development and Maintenance', minTurnover: 5000000, experienceYears: 3, mseExempt: true, startupExempt: true,
      documentsRequired: ['Experience Criteria', 'Bidder Turnover', 'Certificate (Requested in ATC)'], epbgPercent: 5, bidType: 'Two Packet Bid',
    });
  });

  it('checks the fit and makes the bid pack from the documents on file', async () => {
    const bid = ((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.bid_number === 'GEM/2026/B/8301001');
    ids.bid = bid.id;
    const pdf = await pdfWith(['GEM/2026/B/8301001']);
    const up = await api('POST', `/api/v1/intake/gem/${ids.bid}/document`, { name: 'GeM-Bidding-8301001.pdf', data: btoa(String.fromCharCode(...pdf)), pages: [BID_TEXT] });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    // a document of another bid is refused
    expect((await api('POST', `/api/v1/intake/gem/${ids.bid}/document`, { pages: [BID_TEXT.replace('8301001', '9999999')] })).status).toBe(400);
    // the organisation: a startup with Udyam, PAN, GST and a turnover certificate on file
    const base = (await api('GET', '/api/v1/organisation')).json.profile;
    expect((await api('PUT', '/api/v1/organisation', { ...base, legalName: 'HRP AI LLP', udyam: 'UDYAM-UP-28-0012345', dpiitNumber: 'DIPP154321', incorporatedOn: '2024-06-01' })).status).toBe(200);
    for (const [kind, lines] of [['pan', ['PAN AASFH6805J']], ['gst', ['GST REG-06']], ['udyam', ['Udyam certificate']], ['turnover_certificate', ['CA certificate of turnover']]] as const) {
      const d = await api('POST', '/api/v1/organisation/documents', { kind, number: kind === 'pan' ? 'AASFH6805J' : null });
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      await upload(`/api/v1/organisation/documents/${d.json.id}/file`, await pdfWith([...lines]), `${kind}.pdf`);
    }
    const c = await api('GET', `/api/v1/intake/gem/${ids.bid}/check`);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.bid).toMatchObject({ status: 'reviewing', min_turnover: 5000000, organisation: 'National Informatics Centre' });
    // no turnover in the books yet, 2 years old — but MSE / Startup exempt
    expect(c.json.checks.find((x: any) => x.what === 'Average annual turnover')).toMatchObject({ ok: true });
    expect(c.json.checks.find((x: any) => x.what === 'Years of experience').detail).toMatch(/exempt by MSE/);
    const docs = Object.fromEntries(c.json.documents.map((d: any) => [d.asked, d.status]));
    expect(docs).toMatchObject({ PAN: 'ready', 'GST registration': 'ready', 'Experience Criteria': 'missing', 'Bidder Turnover': 'ready', 'Certificate (Requested in ATC)': 'manual', 'MSE exemption': 'ready', 'Startup exemption': 'missing' });
    const pack = await h.app.request(`http://synapse.test/api/v1/intake/gem/${ids.bid}/pack`, { headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}` } }, h.env);
    expect(pack.status).toBe(200);
    const out = await PDFDocument.load(new Uint8Array(await pack.arrayBuffer()));
    // contents page + PAN + GST + turnover + Udyam
    expect(out.getPageCount()).toBe(5);
    // the bid as a deal with the buyer as a government account
    const deal = await api('POST', `/api/v1/intake/gem/${ids.bid}/deal`);
    expect(deal.status, JSON.stringify(deal.json)).toBe(201);
    expect((await api('GET', `/api/v1/records/deal/${deal.json.dealId}`)).json.name).toMatch(/^GEM\/2026\/B\/8301001/);
    expect(((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.id === ids.bid).status).toBe('preparing');
  });
});

describe('a followed bid read from GeM', () => {
  const SCOPE = 'https://bidplus.gem.gov.in/resources/upload_nas/NovQ426/bidding/biddoc/bid-10118747/1793699147.pdf';
  const ATC = 'https://fulfilment.gem.gov.in/contract/slafds?fileDownloadPath=SLA_UPLOAD_PATH/2026/Nov/GEM_2026_B_8301002/CLM0010/ATC_abc_GEM905445.docx';
  const GTC = 'https://admin.gem.gov.in/apis/v1/gtc/pdfByDate/?date=20261103';

  async function bidPdf() {
    const d = await PDFDocument.create();
    const p = d.addPage([595, 842]);
    const f = await d.embedFont(StandardFonts.Helvetica);
    const rows: [string, string][] = [
      ['Bid Number: GEM/2026/B/8301002', ''],
      ['Dated: 17-11-2026', ''],
      ['Bid End Date/Time', '01-12-2026 18:00:00'],
      ['Ministry/State Name', 'Ministry Of Finance'],
      ['Department Name', 'Department Of Financial Services'],
      ['Organisation Name', 'Canara Bank'],
      ['Office Name', 'Department Of Information Technology'],
      ['Item Category', 'Software Development Service - AI chatbot'],
      ['Contract Period', '3 Month(s)'],
      ['MSE Relaxation for Years Of Experience', 'Yes | Complete'],
      ['', 'Experience Criteria,Bidder Turnover'],
      ['Document required from seller', '*In case any bidder is seeking exemption'],
      ['Type of Bid', 'Two Packet Bid'],
      ['EMD Amount', '160000'],
      ['ePBG Percentage(%)', '5.00'],
      ['Buyer Email id: buyer@canarabank.com', ''],
      ['Scope of Work:1793699147.pdf', ''],
    ];
    rows.forEach(([a, b], i) => {
      if (a) p.drawText(a, { x: 40, y: 800 - i * 20, size: 10, font: f });
      if (b) p.drawText(b, { x: 300, y: 800 - i * 20, size: 10, font: f });
    });
    const links = [SCOPE, ATC, GTC].map((u, i) =>
      d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 400 - i * 20, 200, 415 - i * 20], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(u) } })),
    );
    p.node.set(PDFName.of('Annots'), d.context.obj(links));
    return d.save();
  }

  it('finds the bid, keeps its document and the buyer files, and fills in the details', async () => {
    const doc = await bidPdf();
    const scope = await pdfWith(['Scope of work']);
    const calls: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!/gem\.gov\.in/.test(url)) return real(input, init);
      calls.push(url);
      if (url.endsWith('/all-bids')) return new Response(`<script>var x = {'csrf_bd_gem_nk': '4afcc6aa67bbdd8602376eef4e11b396'};</script>`, { headers: { 'set-cookie': 'ci_session=abc; path=/', 'content-type': 'text/html' } });
      if (url.endsWith('/all-bids-data')) {
        // GeM's load balancer turns a session away now and then: a new session and another try
        if (!calls.some((u, i) => u.endsWith('/all-bids-data') && i < calls.length - 1)) return new Response('Not Found', { status: 404 });
        const body = new URLSearchParams(String(init.body));
        expect(body.get('csrf_bd_gem_nk')).toBe('4afcc6aa67bbdd8602376eef4e11b396');
        expect(init.headers.cookie).toBe('ci_session=abc');
        const want = JSON.parse(body.get('payload')!).param.searchBid;
        const docs = want === 'GEM/2026/B/8301002'
          ? [{ id: '10118747', b_id: [10118747], b_bid_number: ['GEM/2026/B/8301002'], b_category_name: ['Software Development Service - AI chatbot'], b_total_quantity: [1], b_bid_type: [1], final_start_date_sort: ['2026-11-17T11:30:00Z'], final_end_date_sort: ['2026-12-01T18:00:00Z'], ba_official_details_minName: ['Ministry of Finance'], ba_official_details_deptName: ['Department of Financial Services'] }]
          : [];
        return Response.json({ status: 1, code: 200, response: { response: { numFound: docs.length, start: 0, docs } } });
      }
      if (url.endsWith('/showbidDocument/10118747')) return new Response(doc, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="GeM-Bidding-10118747.pdf"' } });
      if (url === SCOPE) return new Response(scope, { headers: { 'content-type': 'application/pdf' } });
      if (url === ATC) return new Response(new Uint8Array([0x50, 0x4b, 3, 4, ...new TextEncoder().encode('word/document.xml fake docx body')]), { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="ATC_abc_GEM905445.docx"' } });
      return new Response('nope', { status: 404 });
    });
    try {
      const bid = ((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.bid_number === 'GEM/2026/B/8301002');
      const r = await api('POST', `/api/v1/intake/gem/${bid.id}/fetch`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(calls.some((u) => u.includes('gtc'))).toBe(false); // the general terms are linked, not downloaded
      const c = (await api('GET', `/api/v1/intake/gem/${bid.id}/check`)).json;
      expect(c.bid).toMatchObject({
        gem_id: 10118747, organisation: 'Canara Bank', ministry: 'Ministry of Finance', emd_amount: 160000, epbg_percent: 5, mse_exempt: true, bid_type: 'Two Packet Bid', status: 'new',
        end_at: '2026-12-01T12:30:00.000Z', documents_required: ['Experience Criteria', 'Bidder Turnover'],
      });
      expect(c.bid.details).toMatchObject({ Office: 'Department Of Information Technology', 'Contract period': '3 Month(s)', 'Buyer email': 'buyer@canarabank.com' });
      const files = Object.fromEntries(c.files.map((f: any) => [f.label, f]));
      expect(Object.keys(files).sort()).toEqual(['Bid document', 'Buyer ATC (additional terms)', 'GeM General Terms and Conditions', 'Scope of Work']);
      expect(files['Bid document'].open).toBeTruthy();
      expect(files['Scope of Work'].open).toBeTruthy();
      expect(files['GeM General Terms and Conditions'].open).toBeNull();
      expect(c.documentUrl).toBeTruthy();
      // read again: nothing is kept twice
      expect((await api('POST', `/api/v1/intake/gem/${bid.id}/fetch`)).status).toBe(200);
      expect((await api('GET', `/api/v1/intake/gem/${bid.id}/check`)).json.files).toHaveLength(4);
      // a bid GeM does not know: the reason is kept on the bid
      const other = ((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.bid_number === 'GEM/2026/B/8301001');
      const miss = await api('POST', `/api/v1/intake/gem/${other.id}/fetch`);
      expect(miss.status).toBe(400);
      expect(((await api('GET', '/api/v1/intake/gem')).json as any[]).find((b) => b.id === other.id).fetch_error).toMatch(/Not found/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a foreign invoice and its card receipt, approved', () => {
  async function doc(rows: [string, string?][]) {
    const d = await PDFDocument.create();
    const p = d.addPage([595, 842]);
    const f = await d.embedFont(StandardFonts.Helvetica);
    rows.forEach(([a, b], i) => {
      if (a) p.drawText(a, { x: 40, y: 800 - i * 18, size: 10, font: f });
      if (b) p.drawText(b, { x: 330, y: 800 - i * 18, size: 10, font: f });
    });
    return d.save();
  }
  const head: [string, string?][] = [
    ['Anthropic, PBC', 'Bill to'],
    ['548 Market Street', 'HRP AI LLP'],
    ['San Francisco, California 94104', 'Noida, Uttar Pradesh'],
    ['United States', 'India'],
    ['support@anthropic.com', `IN GST ${OWN_GSTIN}`],
    ['India GST 9924USA29003OSI'],
  ];
  const items: [string, string?][] = [
    ['Description    Qty    Unit price    Tax    Amount'],
    ['Claude Max    1    $100.00    0%    $100.00'],
    ['Nov 11 - Dec 11, 2026'],
    ['Subtotal', '$100.00'],
    ['Total', '$100.00'],
  ];

  it('reads the dollars, the full number, the date, the card; posts the bill under reverse charge and the payment through the card', async () => {
    const invoice = await doc([['Invoice'], ['Invoice number', 'F13F9483-0019'], ['Date of issue', 'November 12, 2026'], ...head, ['$100.00 due November 12, 2026'], ...items, ['Amount due', '$100.00'], ['HSN Code: 998315']]);
    const receipt = await doc([
      ['Receipt'], ['Invoice number', 'F13F9483-0019'], ['Receipt number', '2910-9849-3879'], ['Date paid', 'November 12, 2026'], ['Payment method', 'Visa - 9814'], ...head,
      ['$96.40 paid on November 12, 2026'], ...items, ['Applied balance', '-$3.60'], ['Amount paid', '$96.40'],
    ]);
    // the books are on, and the company's Visa card ending 9814 is set up
    expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: '2026-04-01' })).status).toBe(200);
    const card = await api('POST', '/api/v1/books/bank-accounts', { name: 'HDFC Visa 9814', kind: 'credit_card', bankName: 'HDFC Bank', last4: '9814', network: 'visa', creditLimit: 500000, statementDay: 18, dueDay: 7 });
    expect(card.status, JSON.stringify(card.json)).toBe(201);
    const banks = (await api('GET', '/api/v1/books/bank-accounts')).json as any[];
    expect(banks.find((b) => b.id === card.json.id)).toMatchObject({ holder: 'company', card_network: 'visa', credit_limit: 500000, statement_day: 18, due_day: 7 });

    messages.push({ uid: Math.max(...messages.map((m) => m.uid)) + 1, raw: mail({ id: 'rcpt-1@stripe.com', from: 'Anthropic, PBC <invoice+statements@mail.anthropic.com>', subject: 'Your receipt from Anthropic, PBC #2910-9849-3879', pdfs: [{ name: 'Invoice-F13F9483-0019.pdf', bytes: invoice }, { name: 'Receipt-2910-9849-3879.pdf', bytes: receipt }] }) });
    expect((await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`)).json.taken).toBeGreaterThan(0);
    const item = ((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[]).find((i) => /Anthropic/.test(i.subject));
    expect(item.attachments).toHaveLength(2);

    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.frankfurter.dev/v1/2026-11-12?base=USD&symbols=INR')) return Response.json({ amount: 1, base: 'USD', date: '2026-11-12', rates: { INR: 94.04 } });
      return real(input, init);
    });
    let p: any;
    try {
      const r = await api('POST', `/api/v1/intake/items/${item.id}/proposal`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      p = r.json;
    } finally {
      spy.mockRestore();
    }
    expect(p).toMatchObject({
      supplier: { name: 'Anthropic, PBC', foreign: true, taxId: '9924USA29003OSI', gstin: null },
      number: 'F13F9483-0019', date: '2026-11-12', currency: 'USD', exchangeRate: 94.04, reverseCharge: true, supplyType: 'import', subtotal: 100, tax: 0,
      paid: { on: '2026-11-12', amount: 96.4, appliedBalance: 3.6, card: { last4: '9814' }, through: { glId: card.json.glAccountId }, reference: '2910-9849-3879' },
    });
    expect(p.lines).toEqual([{ description: 'Claude Max (Nov 11 - Dec 11, 2026)', hsnSac: '998315', quantity: 1, unitPrice: 100, taxRate: 18 }]);
    expect(p.files.map((f: any) => f.role).sort()).toEqual(['invoice', 'receipt']);

    const software = (p.choices.accounts as any[]).find((a) => a.type === 'expense');
    const a = await api('POST', `/api/v1/intake/items/${item.id}/approve`, {
      vendorName: p.supplier.name, number: p.number, date: p.date, currency: 'USD', exchangeRate: 94.04, reverseCharge: true, importOfServices: true, accountId: software.id,
      lines: p.lines, post: true, payment: { paidThroughId: p.paid.through.glId, date: p.paid.on, amount: 96.4, inrAmount: 9105.6, reference: p.paid.reference },
    });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.balanceLeft).toBe(3.6);
    const bill = (await api('GET', `/api/v1/records/bill/${a.json.billId}`)).json;
    expect(bill).toMatchObject({ vendor_ref: 'F13F9483-0019', currency: 'USD', reverse_charge: true, status: 'partially_paid' });
    expect(JSON.stringify((await api('GET', `/api/v1/books/bills/${a.json.billId}`)).json)).toContain('"supply_type":"import"');
    expect(Number(bill.grand_total)).toBe(100); // GST under reverse charge is not owed to the supplier
    expect(Number(bill.igst_total)).toBe(18);
    // GSTR-3B: $18 of IGST at 94.04 under reverse charge, paid in cash and taken back as credit
    const g = (await api('GET', '/api/v1/books/reports/gstr-3b?month=2026-11')).json;
    expect(g.inwardReverseCharge.igst).toBeCloseTo(1692.72, 2);
    expect(g.reverseChargeCash.igst).toBeCloseTo(1692.72, 2);
    // the card owes what was charged: ₹9,105.60 (96.40 at the card's 94.4565…)
    const after = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.id === card.json.id);
    expect(after.book_balance).toBeCloseTo(-9105.6, 2);
    const files = (await api('GET', `/api/v1/files?object=bill&id=${a.json.billId}`)).json;
    expect(JSON.stringify(files)).toContain('Receipt-2910-9849-3879.pdf');
    // approved once only
    expect((await api('POST', `/api/v1/intake/items/${item.id}/approve`, { vendorName: 'x x', date: '2026-11-12', lines: p.lines })).status).toBe(400);
  });

  it('a partner’s personal card: spend owed to the card, then settled to the partner', async () => {
    const person = await api('POST', '/api/v1/books/desk/own/persons', { name: 'Prashant Srivastava', role: 'partner' });
    expect(person.status, JSON.stringify(person.json)).toBeLessThan(300);
    const pid = person.json.id ?? person.json.person?.id;
    expect((await api('POST', '/api/v1/books/bank-accounts', { name: 'Prashant Amex', kind: 'credit_card', last4: '1005', holder: 'personal' })).status).toBe(400);
    const c = await api('POST', '/api/v1/books/bank-accounts', { name: 'Prashant Amex 1005', kind: 'credit_card', last4: '1005', network: 'amex', holder: 'personal', personId: pid });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const row = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.id === c.json.id);
    expect(row).toMatchObject({ holder: 'personal', person_name: 'Prashant Srivastava' });
    const s = await api('POST', `/api/v1/books/bank-accounts/${c.json.id}/settle`, { amount: 500, date: '2026-11-15' });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.id === c.json.id).book_balance).toBe(500);
    // a company card cannot be settled to a person
    const company = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.account_last4 === '9814');
    expect((await api('POST', `/api/v1/books/bank-accounts/${company.id}/settle`, { amount: 1, date: '2026-11-15' })).status).toBe(400);
    expect((await api('PUT', `/api/v1/books/bank-accounts/${company.id}`, { creditLimit: 600000, dueDay: 8 })).status).toBe(200);
    expect(((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.id === company.id)).toMatchObject({ credit_limit: 600000, due_day: 8, statement_day: 18 });
  });
});

describe('an Indian tax invoice laid out in columns', () => {
  it('reads the number and date under their headings, the supplier, the table, the GST and that it is paid; suggests the account', async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([595, 842]);
    const f = await d.embedFont(StandardFonts.Helvetica);
    const b = await d.embedFont(StandardFonts.HelveticaBold);
    const t = (s: string, x: number, y: number, size = 8, font = f) => p.drawText(s, { x, y: 842 - y, size, font });
    t('gstinapi.in', 70, 50, 16, b); t('TAX INVOICE', 440, 50, 14, b); t('PAID', 500, 90, 9, b);
    t('INVOICE NO.', 70, 120, 7); t('INVOICE DATE', 190, 120, 7); t('PLACE OF SUPPLY', 310, 120, 7); t('REVERSE CHARGE', 430, 120, 7);
    t('306/26-27', 70, 132, 9, b); t('17 Nov 2026', 190, 132, 9, b); t('Uttar Pradesh (09)', 310, 132, 9, b); t('No', 430, 132, 9, b);
    t('SUPPLIER', 70, 160, 7); t('BILL TO', 320, 160, 7);
    t('Tarun Soft Consultancy', 70, 172, 10, b); t('HRP AI LLP', 320, 172, 10, b);
    t('205, La Citadel Complex, Magob', 70, 186); t(`GSTIN: ${OWN_GSTIN}`, 320, 186, 8, b);
    t('GSTIN: 24APLPV0398G1ZH    PAN: APLPV0398G', 70, 210, 8, b);
    t('#', 75, 262, 7, b); t('DESCRIPTION OF SERVICE', 95, 262, 7, b); t('SAC', 350, 262, 7, b); t('QTY', 410, 262, 7, b); t('RATE', 470, 262, 7, b); t('TAXABLE VALUE', 510, 262, 7, b);
    t('1', 75, 285); t('250 GSTIN lookup credits', 95, 285); t('998315', 350, 285); t('1', 415, 285); t('Rs. 199.00', 460, 285); t('Rs. 199.00', 525, 285);
    t('AMOUNT IN WORDS', 70, 320, 7); t('Taxable Value', 380, 320); t('Rs. 199.00', 525, 320);
    t('Rupees Two Hundred Thirty Five Only', 70, 335, 8, b); t('IGST @ 18%', 380, 335); t('Rs. 36.00', 530, 335);
    t('Tax payable on reverse charge: No.  Payment received in full online.', 70, 355, 7); t('Total Invoice Value', 380, 365, 10, b); t('Rs. 235.00', 520, 365, 10, b);
    t('DECLARATION', 70, 470, 7); t('For Tarun Soft Consultancy', 440, 470, 9, b);
    const pdf = await d.save();
    messages.push({ uid: Math.max(...messages.map((m) => m.uid)) + 1, raw: mail({ id: 'inv-306@gstinapi.in', from: 'gstinapi.in <help@gstinapi.in>', subject: 'Invoice 306/26-27 — gstinapi.in', pdf: { name: '306-26-27.pdf', bytes: pdf } }) });
    expect((await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`)).json.taken).toBeGreaterThan(0);
    const item = ((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[]).find((i) => /306\/26-27/.test(i.subject));
    const r = await api('POST', `/api/v1/intake/items/${item.id}/proposal`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({
      supplier: { name: 'Tarun Soft Consultancy', gstin: '24APLPV0398G1ZH', foreign: false }, number: '306/26-27', date: '2026-11-17', currency: 'INR', reverseCharge: false,
      subtotal: 199, tax: 36, total: 235, paid: { amount: 235, through: null }, suggest: { why: 'from SAC/HSN 998315' },
    });
    expect(r.json.lines).toEqual([{ description: '250 GSTIN lookup credits', hsnSac: '998315', quantity: 1, unitPrice: 199, taxRate: 18 }]);
    expect(r.json.confidence).toBeGreaterThanOrEqual(0.8);
    const acct = (r.json.choices.accounts as any[]).find((a) => a.id === r.json.suggest.accountId);
    expect(acct.name).toMatch(/Software/);
    const bank = (r.json.choices.payFrom as any[]).find((x) => x.kind === 'bank') ?? (r.json.choices.payFrom as any[])[0];
    const a = await api('POST', `/api/v1/intake/items/${item.id}/approve`, {
      vendorName: r.json.supplier.name, gstin: r.json.supplier.gstin, number: r.json.number, date: r.json.date, accountId: r.json.suggest.accountId, lines: r.json.lines,
      post: true, payment: { paidThroughId: bank.gl_account_id, date: r.json.date, amount: 235 },
    });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const bill = (await api('GET', `/api/v1/records/bill/${a.json.billId}`)).json;
    expect(bill).toMatchObject({ vendor_ref: '306/26-27', status: 'paid' });
    expect(Number(bill.grand_total)).toBe(235);
    expect(Number(bill.igst_total)).toBeCloseTo(35.82, 2); // 18% of 199 (the invoice rounds it to 36)
  });
});

describe('a card statement that comes by mail, password-protected', () => {
  it('asks for the password, opens it with the one saved on the card, and imports the lines the card way round', async () => {
    const pdf = new Uint8Array(readFileSync(new URL('./fixtures/card-statement-protected.pdf', import.meta.url)));
    messages.push({ uid: Math.max(...messages.map((m) => m.uid)) + 1, raw: mail({ id: 'stmt-nov@hdfcbank.net', from: 'HDFC Bank <emailstatements.cards@hdfcbank.net>', subject: 'Your HDFC Bank Credit Card Statement - November 2026', pdf: { name: 'Statement_Nov2026.pdf', bytes: pdf } }) });
    expect((await api('POST', `/api/v1/intake/mailboxes/${ids.mb}/sync`)).json.taken).toBeGreaterThan(0);
    const item = ((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[]).find((i) => i.kind === 'statement');
    expect(item).toBeTruthy();
    // no password saved yet
    const first = await api('POST', `/api/v1/intake/items/${item.id}/statement`, {});
    expect(first.json).toMatchObject({ status: 'needs_password' });
    // the password saved on the card ending 9814 (never shown back)
    const card = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.account_last4 === '9814');
    expect((await api('PUT', `/api/v1/books/bank-accounts/${card.id}`, { statementPassword: 'SURE1811', statementSenders: 'hdfcbank.net' })).status).toBe(200);
    const listed = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((b) => b.id === card.id);
    expect(listed).toMatchObject({ has_statement_password: true, statement_senders: 'hdfcbank.net' });
    expect(JSON.stringify(listed)).not.toContain('SURE1811');
    const r = await api('POST', `/api/v1/intake/items/${item.id}/statement`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ status: 'imported', bankAccountId: card.id, added: 3 });
    const txns = (await api('GET', `/api/v1/books/bank-accounts/${card.id}/transactions?status=all`)).json as any[];
    const amounts = Object.fromEntries(txns.map((t: any) => [t.description, Number(t.amount)]));
    expect(amounts).toMatchObject({ 'ANTHROPIC SAN FRANCISCO US': -9105.6, 'PAYMENT RECEIVED - THANK YOU': 20000, 'IGST ON FOREIGN MARKUP': -57.36 });
    expect(((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[]).find((i) => i.id === item.id)).toMatchObject({ status: 'done', link_object: 'bank_account', link_id: card.id });
  });
});

describe('deals priced by rate, projects in any currency, partner names run together', () => {
  it('works the deal amount out from the rate', async () => {
    for (const a of ['projects']) await api('POST', `/api/admin/apps/${a}/enable`);
    const d = await api('POST', '/api/v1/records/deal', { name: 'Dev team for Acme', pricing_model: 'per_person_month', unit_rate: 150000, units: 3, duration_months: 6, currency: 'USD' });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const deal = (await api('GET', `/api/v1/records/deal/${d.json.id}`)).json;
    expect(Number(deal.amount)).toBe(2700000);
    expect((await api('PATCH', `/api/v1/records/deal/${d.json.id}`, { pricing_model: 'hourly', units: 120, unit_rate: 40 })).status).toBe(200);
    expect(Number((await api('GET', `/api/v1/records/deal/${d.json.id}`)).json.amount)).toBe(4800);
    // a fixed bid keeps the amount typed in
    expect((await api('PATCH', `/api/v1/records/deal/${d.json.id}`, { pricing_model: 'fixed', amount: 9999 })).status).toBe(200);
    expect(Number((await api('GET', `/api/v1/records/deal/${d.json.id}`)).json.amount)).toBe(9999);
    expect((await api('POST', '/api/v1/records/deal', { name: 'x', currency: 'XYZ' })).status).toBe(400);
  });

  it('a project keeps its currency', async () => {
    const p = await api('POST', '/api/v1/records/project', { name: 'Website for a London client', currency: 'GBP', billing_method: 'fixed_price', fixed_fee: 5000 });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect((await api('GET', `/api/v1/records/project/${p.json.id}`)).json.currency).toBe('GBP');
  });

  it('knows a partner when the bank runs the name together', () => {
    expect(sameName('SRIVASTAVASUNITA', 'Sunita Srivastava')).toBe(true);
    expect(nameInText('UPI/DR/412345678/SRIVASTAVASUNITA/SBIN/upi', 'Sunita Srivastava')).toBe(true);
    expect(nameInText('UPI/DR/412345678/SUNILKUMAR/SBIN/upi', 'Sunita Srivastava')).toBe(false);
  });
});

describe('text with NUL characters from a PDF', () => {
  it('is stored without them (jsonb refuses \\u0000)', async () => {
    const item = ((await api('GET', '/api/v1/intake/items?kind=docs')).json as any[]).find((i) => /306\/26-27/.test(i.subject));
    const r = await api('POST', `/api/v1/intake/items/${item.id}/read`, { fileId: item.attachments[0].fileId, pages: ['TAX INVOICE\u0000\nInvoice No: 99/26-27\u0000\nTotal Rs. 100.00\nSupplier\u0000 Name Pvt Ltd extra text here'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});
