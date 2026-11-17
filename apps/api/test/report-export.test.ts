import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let token = '';

const csvRows = (text: string) =>
  text
    .replace(/^﻿/, '')
    .split('\r\n')
    .map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.slice(0, -1).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')));

async function exportText(query: string) {
  const res = await h.app.request(`http://synapse.test/api/v1/export/deal?${query}`, { headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}` } }, h.env);
  return { status: res.status, rows: csvRows(await res.text()) };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_report_export');
  await h.signup('acme', 'owner@acme.test');
  token = (await h.login('acme', 'owner@acme.test')).token;
  api = h.as('acme', token);
  const acc = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', account_type: 'ngo' })).json.id;
  const d = await api('POST', '/api/v1/records/deal', { name: 'Website and maintenance', account_id: acc, amount: 1234567.5, close_date: '2026-03-31', probability: 90, source: 'referral' });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
}, 120_000);

describe('record export for reports', () => {
  it('reads like the screen: names, labels, rupees and dates, no IDs', async () => {
    const r = await exportText('format=display&columns=title,account_id,amount,close_date,probability,source,owner_id');
    expect(r.status).toBe(200);
    const [head, row] = r.rows;
    expect(head!.map((x) => x.replace(/\s+/g, ' '))).toEqual(['Deal name', 'Account', 'Amount', 'Close date', 'Probability %', 'Source', 'Owner', 'Created', 'Updated']);
    expect(row!.slice(0, 7)).toEqual(['Website and maintenance', 'Sindhu Manthan Foundation', '₹12,34,567.50', '31 Mar 2026', '90%', 'Referral', 'acme Owner']);
    expect(row![7]).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}$/);
  });

  it('the CSV keeps raw values for re-import, and now includes the name', async () => {
    const r = await exportText('columns=title,account_id,amount');
    const [head, row] = r.rows;
    expect(head!.slice(0, 4)).toEqual(['ID', 'Deal name', 'Account', 'Amount']);
    expect(row![1]).toBe('Website and maintenance');
    expect(row![2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(row![3]).toBe('1234567.5');
  });
});
