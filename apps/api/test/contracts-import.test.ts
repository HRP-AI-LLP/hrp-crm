/**
 * Existing contracts uploaded and read: an NDA (Word) and a SoW (PDF) with a client already on file;
 * the SoW becomes a fixed-bid contract under the MSA-less client with its project and milestones, and
 * billing starts after what was already invoiced elsewhere.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { readContract } from '../src/services/it/contract-read';
import { fakeR2, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A minimal .docx (stored zip) with one paragraph per line. */
function docx(lines: string[]): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  const enc = new TextEncoder();
  const name = enc.encode('word/document.xml');
  const data = enc.encode(xml);
  const crc = (() => {
    let c = ~0;
    for (const x of data) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  })();
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, local.length + data.length);
  out.set(end, local.length + data.length + central.length);
  return out;
}

async function pdf(lines: string[]) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => p.drawText(l, { x: 40, y: 800 - i * 16, size: 9, font: f }));
  return d.save();
}

const NDA = [
  'MUTUAL NON-DISCLOSURE AGREEMENT',
  'This Agreement is entered into on 5th January, 2026 by and between HRP AI LLP, a limited liability partnership having its office at Noida (the "Company") and MisticusMind, Inc., a Delaware corporation (the "Client").',
  'The obligations of confidentiality shall survive for a period of 3 years.',
  'Either party may terminate this Agreement with 30 days written notice.',
  'This Agreement shall be governed by the laws of India.',
];
const SOW = [
  'STATEMENT OF WORK',
  'SOW No: MM-SOW-001',
  'This Statement of Work is entered into on 1st October, 2026 between HRP AI LLP (the "Service Provider") and MisticusMind, Inc. (the "Client").',
  'Project: AI support assistant',
  'Scope of Work: Design, build and deploy an AI support assistant on the Client website.',
  'The term of this SOW shall be for a period of 6 months.',
  'Total contract value: USD 30,000 payable against milestones.',
  'Milestone 1: Design - USD 6,000 - 31 Oct 2026',
  'Milestone 2: Build - USD 18,000 - 31 Jan 2027',
  'Milestone 3: Go-live - USD 6,000 - 31 Mar 2027',
  'Invoices are payable within 30 days of receipt.',
  'This SOW shall be governed by the laws of India.',
];

beforeAll(async () => {
  h = await makeHarness('synapse_test_contracts_import');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh' } } });
  ids.client = (await api('POST', '/api/v1/records/account', { name: 'MisticusMind, Inc.' })).json.id;
}, 120_000);

describe('reading contracts', () => {
  it('reads an NDA and a SoW by rules', () => {
    const n = readContract(NDA.join('\n'), ['HRP AI LLP']);
    expect(n).toMatchObject({ docType: 'nda', kind: 'nda', client: 'MisticusMind, Inc.', effectiveDate: '2026-01-05', billingFrequency: 'none', noticeDays: 30, governingLaw: 'India' });
    const s = readContract(SOW.join('\n'), ['HRP AI LLP']);
    expect(s).toMatchObject({
      docType: 'sow', kind: 'fixed_bid', client: 'MisticusMind, Inc.', clientRef: 'MM-SOW-001', effectiveDate: '2026-10-01', endDate: '2027-03-31', termMonths: 6,
      currency: 'USD', value: 30000, billingFrequency: 'milestone', paymentTermsDays: 30, projectName: 'AI support assistant',
    });
    expect(s.milestones).toEqual([
      { name: 'Design', amount: 6000, due: '2026-10-31' },
      { name: 'Build', amount: 18000, due: '2027-01-31' },
      { name: 'Go-live', amount: 6000, due: '2027-03-31' },
    ]);
  });
});

describe('uploading existing contracts', () => {
  it('reads the uploaded NDA (Word) and SoW (PDF), finds the client, and saves them with a project and milestones', async () => {
    const files = [
      { name: 'MisticusMind-NDA.docx', data: b64(docx(NDA)) },
      { name: 'MisticusMind-SOW-001.pdf', data: b64(await pdf(SOW)) },
    ];
    const r = await api('POST', '/api/v1/it/contracts/read', { files });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.account).toMatchObject({ id: ids.client });
    expect(r.json.docs.map((d: any) => d.read?.docType)).toEqual(['nda', 'sow']);
    // the NDA
    const nda = r.json.docs[0].read;
    const a = await api('POST', '/api/v1/it/contracts/upload', {
      files: [files[0]], accountId: ids.client, name: 'Mutual NDA', docType: 'nda', kind: 'nda', startDate: nda.effectiveDate, billingFrequency: 'none', noticeDays: nda.noticeDays, governingLaw: nda.governingLaw, extracted: nda,
    });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json).toMatchObject({ status: 'active', nextInvoiceDate: null, files: 1 });
    // the SoW: a project with its milestones
    const sow = r.json.docs[1].read;
    const s = await api('POST', '/api/v1/it/contracts/upload', {
      files: [files[1]], accountId: ids.client, name: sow.projectName, docType: 'sow', kind: sow.kind, startDate: sow.effectiveDate, endDate: sow.endDate, currency: sow.currency, value: sow.value,
      billingFrequency: sow.billingFrequency, paymentTermsDays: sow.paymentTermsDays, clientRef: sow.clientRef, summary: sow.summary, newProject: true, milestones: sow.milestones, taxRate: 0,
    });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const c = (await api('GET', `/api/v1/it/contracts/${s.json.id}`)).json;
    expect(c.contract).toMatchObject({ doc_type: 'sow', kind: 'fixed_bid', currency: 'USD', value: 30000, client_ref: 'MM-SOW-001', source: 'uploaded', status: 'active', account_id: ids.client });
    expect(c.files.map((f: any) => f.name)).toEqual(['MisticusMind-SOW-001.pdf']);
    expect(c.files[0].url).toBeTruthy();
    const proj = (await api('GET', `/api/v1/records/project/${s.json.projectId}`)).json;
    expect(proj).toMatchObject({ currency: 'USD', billing_method: 'fixed_price', customer_ref: 'MM-SOW-001' });
    const ms = (await api('GET', `/api/v1/projects/${s.json.projectId}`)).json.milestones as any[];
    expect(ms.map((m) => [m.name, Number(m.amount)])).toEqual([['Design', 6000], ['Build', 18000], ['Go-live', 6000]]);
    expect(((await api('GET', '/api/v1/it/contracts')).json as any[]).length).toBe(2);
  });

  it('a monthly retainer is billed from the next period, not for the months already invoiced elsewhere', async () => {
    const start = '2026-04-01';
    const r = await api('POST', '/api/v1/it/contracts/upload', {
      files: [{ name: 'Retainer.pdf', data: b64(await pdf(['RETAINER AGREEMENT', 'Monthly fee of Rs. 50,000 per month'])) }],
      newAccountName: 'Sindhu Manthan Foundation', name: 'Website retainer', docType: 'agreement', kind: 'retainer', startDate: start, billingFrequency: 'monthly', periodFee: 50000,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const now = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const nextMonth = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 1)).toISOString().slice(0, 10);
    expect(r.json).toMatchObject({ status: 'active', nextInvoiceDate: nextMonth });
  });
});
