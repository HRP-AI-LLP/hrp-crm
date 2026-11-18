/** Home today, Customer 360, cash forecast, payment reminders, GeM keyword alerts and the books digest. */
import { beforeAll, describe, expect, it } from 'vitest';
import { stageFor } from '../src/services/books/dunning';
import { keywordHits } from '../src/services/intake/gem';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await makeHarness('synapse_test_upgrade');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  ids.acc = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation' })).json.id;
  await api('POST', '/api/v1/records/contact', { last_name: 'Pathak', first_name: 'Shalini', email: 'shalini@example.org', account_id: ids.acc });
  ids.inv = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: ids.acc, invoice_date: day(-40), due_date: day(-10) })).json.id;
  await api('PUT', `/api/v1/invoices/${ids.inv}/lines`, { lines: [{ name: 'Maintenance', quantity: 1, unitPrice: 1000, taxRate: 18 }] });
  expect((await api('POST', `/api/v1/invoices/${ids.inv}/issue`)).status).toBe(200);
}, 120_000);

describe('reminder stages', () => {
  const s = { enabled: true, beforeDays: 3, onDue: true, afterDays: [7, 15, 30], skipGovernment: true, cc: '', note: '' };
  it('picks the stage for the day', () => {
    expect(stageFor(-3, s)).toBe('before_3');
    expect(stageFor(0, s)).toBe('due');
    expect(stageFor(8, s)).toBe('after_7');
    expect(stageFor(16, s)).toBe('after_15');
    expect(stageFor(5, s)).toBeNull();
  });
});

describe('GeM keywords', () => {
  it('matches whole words in the title and buyer', () => {
    expect(keywordHits(['CCTV', 'data entry', 'AI'], 'Supply of CCTV cameras · Food Corporation of India')).toEqual(['CCTV']);
    expect(keywordHits(['AI'], 'Hiring of manpower for maintenance')).toEqual([]);
  });
  it('saves keywords', async () => {
    const r = await api('PUT', '/api/v1/intake/gem-settings', { defaultOwnerId: null, keywords: ['CCTV', ' data entry '] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await api('GET', '/api/v1/intake/gem-settings')).json.keywords).toEqual(['CCTV', 'data entry']);
  });
});

describe('screens', () => {
  it('today has the overdue invoice', async () => {
    const r = await api('GET', '/api/v1/home/today');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.overdue.map((x: any) => x.id)).toContain(ids.inv);
    expect(r.json).toHaveProperty('desk');
  });
  it('customer 360', async () => {
    const r = await api('GET', `/api/v1/accounts/${ids.acc}/360`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.money).toMatchObject({ outstanding: 1180, overdue: 1180, invoices: 1 });
    expect(r.json.timeline.some((x: any) => x.kind === 'invoice')).toBe(true);
    expect(r.json.contacts[0]).toMatchObject({ email: 'shalini@example.org' });
  });
  it('cash forecast keeps late invoices apart', async () => {
    const r = await api('GET', '/api/v1/books/cash-forecast?weeks=8');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.weeks).toHaveLength(8);
    expect(r.json.late).toBe(1180);
  });
  it('reminder settings, and sending needs the mail key', async () => {
    expect((await api('PUT', '/api/v1/books/reminders', { enabled: true, beforeDays: 2, onDue: true, afterDays: [5, 20], skipGovernment: true, cc: '', note: 'Bank: Yes Bank' })).status).toBe(200);
    expect((await api('GET', '/api/v1/books/reminders')).json).toMatchObject({ enabled: true, afterDays: [5, 20] });
    const r = await api('POST', `/api/v1/books/invoices/${ids.inv}/remind`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/could not be sent/);
  });
  it('books digest preview', async () => {
    const r = await api('GET', '/api/v1/digests/preview?kind=books');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.html).toContain('Profit and loss');
    const s = await api('POST', '/api/v1/digests', { name: 'Monthly books', kind: 'books', frequency: 'monthly', sendHour: 9, monthday: 1, recipients: [(await api('GET', '/api/auth/me')).json.user.id] });
    expect(s.status, JSON.stringify(s.json)).toBeLessThan(300);
  });
});
