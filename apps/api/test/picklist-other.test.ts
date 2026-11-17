import { beforeAll, describe, expect, it } from 'vitest';
import { choiceValue, findChoice } from '@synapse/shared';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const field = async (obj: string, key: string) => ((await api('GET', '/api/v1/meta')).json.objects.find((o: any) => o.key === obj).fields as any[]).find((f) => f.key === key);

beforeAll(async () => {
  h = await makeHarness('synapse_test_picklist_other');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
}, 120_000);

describe('typed choices', () => {
  it('turns a typed label into a stored value', () => {
    expect(choiceValue('  Educational Trust ')).toBe('educational_trust');
    expect(choiceValue('Café & Co.')).toBe('cafe_co');
    expect(findChoice([{ value: 'ngo', label: 'NGO / trust / society' }], 'ngo / TRUST / society')?.value).toBe('ngo');
  });
});

describe('"Other…" on picklists', () => {
  it('offers NGO as an account type', async () => {
    const f = await field('account', 'account_type');
    expect(f.options.choices.find((c: any) => c.value === 'ngo')).toMatchObject({ label: 'NGO / trust / society' });
    expect(f.options.addable).toBe(true);
    const r = await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', account_type: 'ngo' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });

  it('adds a typed account type to the list for everyone, once', async () => {
    const a = await api('POST', '/api/v1/records/account', { name: 'Kendriya Vidyalaya', account_type: 'Educational Institution' });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.account_type).toBe('educational_institution');
    const f = await field('account', 'account_type');
    expect(f.options.choices.filter((c: any) => c.value === 'educational_institution')).toEqual([{ value: 'educational_institution', label: 'Educational Institution' }]);
    // the same value typed again (any case) is the same choice
    const b = await api('POST', '/api/v1/records/account', { name: 'DPS Noida', account_type: 'educational institution' });
    expect(b.json.account_type).toBe('educational_institution');
    expect((await field('account', 'account_type')).options.choices.filter((c: any) => c.value === 'educational_institution')).toHaveLength(1);
    // and on edit
    const u = await api('PATCH', `/api/v1/records/account/${b.json.id}`, { account_type: 'Hospital' });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.account_type).toBe('hospital');
    // labels in other scripts get a stable value
    const c = await api('POST', '/api/v1/records/account', { name: 'Gram Panchayat', account_type: 'ग्राम पंचायत' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    expect(c.json.account_type).toMatch(/^opt_[a-z0-9]+$/);
    expect((await field('account', 'account_type')).options.choices.find((x: any) => x.value === c.json.account_type).label).toBe('ग्राम पंचायत');
  });

  it('keeps the lists the application acts on fixed', async () => {
    expect((await api('POST', '/api/admin/apps/purchasing/enable')).status).toBe(200);
    const bad = await api('POST', '/api/v1/records/vendor', { name: 'Sai Plywood', status: 'Escalated' });
    expect(bad.status).toBe(400);
    const ok = await api('POST', '/api/v1/records/vendor', { name: 'Sai Plywood', vendor_type: 'Printing press' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.vendor_type).toBe('printing_press');
  });

  it('extends custom picklists and multi-select picklists, unless the admin turned it off', async () => {
    expect((await api('PUT', '/api/admin/objects/account/fields/segment', { label: 'Segment', type: 'picklist', options: { choices: [{ value: 'smb', label: 'SMB' }] } })).status).toBe(200);
    expect((await api('PUT', '/api/admin/objects/account/fields/tags', { label: 'Tags', type: 'multipicklist', options: { choices: [{ value: 'vip', label: 'VIP' }] } })).status).toBe(200);
    expect((await api('PUT', '/api/admin/objects/account/fields/tier', { label: 'Tier', type: 'picklist', options: { addable: false, choices: [{ value: 'gold', label: 'Gold' }] } })).status).toBe(200);
    const r = await api('POST', '/api/v1/records/account', { name: 'Acme', segment: 'Enterprise', tags: ['vip', 'CSR partner', 'csr partner'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ segment: 'enterprise', tags: ['vip', 'csr_partner', 'csr_partner'] });
    expect((await field('account', 'segment')).options.choices.map((c: any) => c.label)).toEqual(['SMB', 'Enterprise']);
    expect((await field('account', 'tags')).options.choices.map((c: any) => c.label)).toEqual(['VIP', 'CSR partner']);
    expect((await api('POST', '/api/v1/records/account', { name: 'Beta', tier: 'Platinum' })).status).toBe(400);
  });
});
