import { beforeAll, describe, expect, it } from 'vitest';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let accountId: string;

beforeAll(async () => {
  h = await makeHarness('synapse_test_builders');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep One', password: PW, roles: ['sales_rep'] });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  accountId = (await api('POST', '/api/v1/records/account', { name: 'Skyline Developers' })).json.id;
}, 90_000);

const meta = async () => (await api('GET', '/api/v1/meta')).json;
const obj = async (key: string) => (await meta()).objects.find((o: Json) => o.key === key);

describe('formula fields', () => {
  it('are computed on create and update, stored, and filterable', async () => {
    const f = await api('PUT', '/api/admin/objects/deal/fields/weighted', { label: 'Weighted amount', type: 'formula', indexed: true, options: { expression: 'ROUND(amount * probability / 100, 0)', returnType: 'currency', precision: 0 } });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    const d = await api('POST', '/api/v1/records/deal', { name: 'Tower A', amount: 1_000_000, probability: 40, account_id: accountId });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(d.json.weighted).toBe(400_000);
    const u = await api('PATCH', `/api/v1/records/deal/${d.json.id}`, { probability: 75 });
    expect(u.json.weighted).toBe(750_000);
    // computed values cannot be written directly
    const w = await api('PATCH', `/api/v1/records/deal/${d.json.id}`, { weighted: 1 });
    expect(w.status).toBe(400);
    const filt = encodeURIComponent(JSON.stringify([{ field: 'weighted', op: 'gte', value: 700000 }]));
    const list = await api('GET', `/api/v1/records/deal?filters=${filt}`);
    expect(list.json.items.map((x: Json) => x.name)).toEqual(['Tower A']);
    const def = (await obj('deal')).fields.find((x: Json) => x.key === 'weighted');
    expect(def.readOnly).toBe(true);
  });

  it('formulas can use other formulas and stage pseudo-fields; syntax errors and cycles are rejected', async () => {
    expect((await api('PUT', '/api/admin/objects/deal/fields/size_band', { label: 'Size band', type: 'formula', options: { expression: 'IF(weighted >= 500000, "Large", "Small") & " · " & stage', returnType: 'text' } })).status).toBe(200);
    const d = await api('POST', '/api/v1/records/deal', { name: 'Villa', amount: 200_000, probability: 50 });
    expect(d.json.size_band).toMatch(/^Small · /);
    const bad = await api('PUT', '/api/admin/objects/deal/fields/broken', { label: 'Broken', type: 'formula', options: { expression: 'amount *', returnType: 'number' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/ends unexpectedly/);
    const unknown = await api('PUT', '/api/admin/objects/deal/fields/broken', { label: 'Broken', type: 'formula', options: { expression: 'nope + 1', returnType: 'number' } });
    expect(unknown.json.error.message).toBe('Unknown field: nope');
    // weighted → size_band → weighted would be a cycle
    const cyc = await api('PUT', '/api/admin/objects/deal/fields/weighted', { label: 'Weighted amount', type: 'formula', options: { expression: 'LEN(size_band)', returnType: 'number' } });
    expect(cyc.status).toBe(400);
    expect(cyc.json.error.message).toMatch(/depends on itself/);
  });

  it('existing records are back-filled when a formula is added', async () => {
    const before = await api('POST', '/api/v1/records/account', { name: 'Backfill Co', employees: 120 });
    expect((await api('PUT', '/api/admin/objects/account/fields/emp_band', { label: 'Band', type: 'formula', options: { expression: 'IF(employees > 100, "Mid", "Small")', returnType: 'text' } })).status).toBe(200);
    const r = await api('GET', `/api/v1/records/account/${before.json.id}`);
    expect(r.json.emp_band).toBe('Mid');
  });
});

describe('roll-up summary fields', () => {
  it('count and sum children, following creates, updates, re-parenting, deletes and merges', async () => {
    const c1 = await api('PUT', '/api/admin/objects/account/fields/deal_count', { label: 'Deals', type: 'rollup', options: { rollup: { object: 'deal', via: 'account_id', aggregate: 'count' } } });
    expect(c1.status, JSON.stringify(c1.json)).toBe(200);
    const c2 = await api('PUT', '/api/admin/objects/account/fields/pipeline_value', { label: 'Pipeline value', type: 'rollup', options: { rollup: { object: 'deal', via: 'account_id', aggregate: 'sum', field: 'amount', filters: [{ field: 'amount', op: 'gt', value: 0 }] } } });
    expect(c2.status, JSON.stringify(c2.json)).toBe(200);
    expect((await obj('account')).fields.find((x: Json) => x.key === 'pipeline_value').options.returnType).toBe('currency');

    // back-fill picked up "Tower A" (1,000,000) created earlier
    let a = (await api('GET', `/api/v1/records/account/${accountId}`)).json;
    expect(a.deal_count).toBe(1);
    expect(a.pipeline_value).toBe(1_000_000);

    const d2 = (await api('POST', '/api/v1/records/deal', { name: 'Tower B', amount: 500_000, account_id: accountId })).json;
    a = (await api('GET', `/api/v1/records/account/${accountId}`)).json;
    expect([a.deal_count, a.pipeline_value]).toEqual([2, 1_500_000]);

    await api('PATCH', `/api/v1/records/deal/${d2.id}`, { amount: 250_000 });
    expect((await api('GET', `/api/v1/records/account/${accountId}`)).json.pipeline_value).toBe(1_250_000);

    const other = (await api('POST', '/api/v1/records/account', { name: 'Other Builders' })).json;
    expect(other.deal_count).toBe(0);
    await api('PATCH', `/api/v1/records/deal/${d2.id}`, { account_id: other.id });
    expect((await api('GET', `/api/v1/records/account/${accountId}`)).json.deal_count).toBe(1);
    expect((await api('GET', `/api/v1/records/account/${other.id}`)).json.deal_count).toBe(1);

    await api('DELETE', `/api/v1/records/deal/${d2.id}`);
    expect((await api('GET', `/api/v1/records/account/${other.id}`)).json.deal_count).toBe(0);

    // merging the other account into the main one keeps the totals right
    await api('POST', '/api/v1/records/deal', { name: 'Tower C', amount: 100_000, account_id: other.id });
    const m = await api('POST', '/api/v1/records/account/merge', { masterId: accountId, duplicateIds: [other.id] });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    a = (await api('GET', `/api/v1/records/account/${accountId}`)).json;
    expect([a.deal_count, a.pipeline_value]).toEqual([2, 1_100_000]);
  });

  it('rejects roll-ups over a lookup that does not point at the object', async () => {
    const r = await api('PUT', '/api/admin/objects/account/fields/bad_roll', { label: 'Bad', type: 'rollup', options: { rollup: { object: 'deal', via: 'contact_id', aggregate: 'count' } } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/no lookup field/);
  });
});

describe('validation rules and field dependencies', () => {
  it('blocks saves when the error condition is true, with the message on the field', async () => {
    const rule = await api('POST', '/api/admin/objects/deal/validation-rules', { name: 'Won deals need an amount', condition: 'stage_category = "won" && BLANKVALUE(amount, 0) <= 0', message: 'Enter the deal amount before marking it won', field: 'amount' });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    const pipe = (await meta()).pipelines.find((p: Json) => p.objectKey === 'deal');
    const won = pipe.stages.find((s: Json) => s.category === 'won');
    const d = (await rep('POST', '/api/v1/records/deal', { name: 'No amount yet' })).json;
    const r = await rep('PATCH', `/api/v1/records/deal/${d.id}`, { stage_id: won.id });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe('Enter the deal amount before marking it won');
    expect(r.json.error.details[0].field).toBe('amount');
    expect((await rep('PATCH', `/api/v1/records/deal/${d.id}`, { stage_id: won.id, amount: 5000 })).status).toBe(200);

    // inactive rules do not run; invalid conditions are refused
    await api('PUT', `/api/admin/objects/deal/validation-rules/${rule.json.id}`, { name: 'Won deals need an amount', condition: 'stage_category = "won" && BLANKVALUE(amount, 0) <= 0', message: 'x', field: 'amount', active: false });
    const d2 = (await rep('POST', '/api/v1/records/deal', { name: 'Zero' })).json;
    expect((await rep('PATCH', `/api/v1/records/deal/${d2.id}`, { stage_id: won.id })).status).toBe(200);
    expect((await api('POST', '/api/admin/objects/deal/validation-rules', { name: 'x', condition: 'amount >', message: 'x' })).status).toBe(400);
  });

  it('ISCHANGED / PRIORVALUE let rules guard transitions', async () => {
    await api('POST', '/api/admin/objects/lead/validation-rules', { name: 'Email is locked once set', condition: 'ISCHANGED(email) && NOT ISBLANK(PRIORVALUE(email))', message: 'Email cannot be changed after it is set' });
    const l = (await api('POST', '/api/v1/records/lead', { last_name: 'Lock', email: 'a@lock.test' })).json;
    expect((await api('PATCH', `/api/v1/records/lead/${l.id}`, { email: 'b@lock.test' })).status).toBe(400);
    expect((await api('PATCH', `/api/v1/records/lead/${l.id}`, { company: 'Lock Co' })).status).toBe(200);
  });

  it('dependent picklists and conditional requirements are enforced', async () => {
    await api('PUT', '/api/admin/objects/lead/fields/city_pick', { label: 'City', type: 'picklist', options: { choices: [{ value: 'blr', label: 'Bengaluru' }, { value: 'mum', label: 'Mumbai' }] } });
    const area = await api('PUT', '/api/admin/objects/lead/fields/area', {
      label: 'Area', type: 'picklist',
      options: { choices: [{ value: 'hsr', label: 'HSR Layout' }, { value: 'bandra', label: 'Bandra' }], controlling: { field: 'city_pick', map: { blr: ['hsr'], mum: ['bandra'] } } },
    });
    expect(area.status, JSON.stringify(area.json)).toBe(200);
    // conditions may only use fields that exist
    expect((await api('PUT', '/api/admin/objects/lead/fields/loan_bank', { label: 'Lender', type: 'text', options: { requiredWhen: 'needs_loan' } })).status).toBe(400);
    await api('PUT', '/api/admin/objects/lead/fields/needs_loan', { label: 'Needs loan', type: 'boolean' });
    expect((await api('PUT', '/api/admin/objects/lead/fields/loan_bank', { label: 'Lender', type: 'text', options: { requiredWhen: 'needs_loan', visibleWhen: 'needs_loan' } })).status).toBe(200);

    const bad = await api('POST', '/api/v1/records/lead', { last_name: 'Dep', city_pick: 'blr', area: 'bandra' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details[0].field).toBe('area');
    expect((await api('POST', '/api/v1/records/lead', { last_name: 'Dep', city_pick: 'blr', area: 'hsr' })).status).toBe(201);

    const noBank = await api('POST', '/api/v1/records/lead', { last_name: 'Loan', needs_loan: true });
    expect(noBank.status).toBe(400);
    expect(noBank.json.error.details[0].field).toBe('loan_bank');
    expect((await api('POST', '/api/v1/records/lead', { last_name: 'Loan', needs_loan: true, loan_bank: 'HDFC' })).status).toBe(201);

    const badMap = await api('PUT', '/api/admin/objects/lead/fields/area', { label: 'Area', type: 'picklist', options: { choices: [{ value: 'hsr', label: 'HSR' }], controlling: { field: 'city_pick', map: { blr: ['koramangala'] } } } });
    expect(badMap.status).toBe(400);
  });
});

describe('page layouts', () => {
  it('saves sections, rejects hiding required fields, and resets', async () => {
    const layout = { sections: [{ id: 'main', title: 'Basics', columns: 2, fields: ['name', 'amount', 'stage_id'] }, { id: 'more', title: 'More', columns: 1, fields: ['close_date'] }], hidden: ['currency'] };
    const r = await api('PUT', '/api/admin/objects/deal/layout', layout);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await obj('deal')).layout.sections.map((s: Json) => s.title)).toEqual(['Basics', 'More']);
    expect((await api('PUT', '/api/admin/objects/deal/layout', { ...layout, hidden: ['name'] })).status).toBe(400);
    expect((await api('PUT', '/api/admin/objects/deal/layout', { ...layout, sections: [{ id: 'x', title: 'X', columns: 2, fields: ['ghost'] }] })).status).toBe(400);
    expect((await rep('PUT', '/api/admin/objects/deal/layout', layout)).status).toBe(403);
    expect((await api('PUT', '/api/admin/objects/deal/layout', { reset: true })).status).toBe(200);
    expect((await obj('deal')).layout).toBe(null);
  });
});

describe('visual automations with branches', () => {
  it('runs the matching branch and records the path taken', async () => {
    const w = await api('POST', '/api/admin/workflows', {
      name: 'Route by budget',
      objectKey: 'lead',
      triggerEvent: 'created',
      conditions: [{ field: 'last_name', op: 'formula', value: 'BEGINS(last_name, "Route")' }],
      actions: [
        {
          type: 'branch',
          label: 'Big budget?',
          conditions: [{ field: 'company', op: 'not_empty' }],
          then: [
            { type: 'create_task', title: 'Call {{full_name}} from {{company}}', priority: 'high' },
            { type: 'branch', conditions: [{ field: 'source', op: 'eq', value: 'referral' }], then: [{ type: 'add_note', subject: 'Referral from {{company}}' }], else: [] },
          ],
          else: [{ type: 'create_record', object: 'deal', values: { name: 'Deal for {{full_name}}', amount: 1000 } }],
        },
      ],
    });
    expect(w.status, JSON.stringify(w.json)).toBe(201);

    const a = (await api('POST', '/api/v1/records/lead', { first_name: 'Ana', last_name: 'Route1', company: 'Acme Infra', source: 'referral' })).json;
    const tasks = (await api('GET', `/api/v1/tasks?relatedObject=lead&relatedId=${a.id}`)).json.items.map((t: Json) => t.title);
    expect(tasks).toContain('Call Ana Route1 from Acme Infra');
    const tl = (await api('GET', `/api/v1/records/lead/${a.id}/timeline`)).json.items.map((x: Json) => x.subject);
    expect(tl).toContain('Referral from Acme Infra');

    await api('POST', '/api/v1/records/lead', { first_name: 'Bo', last_name: 'Route2' });
    const deals = (await api('GET', `/api/v1/records/deal?q=${encodeURIComponent('Deal for Bo Route2')}`)).json.items;
    expect(deals.length).toBe(1);

    // formula gate on the workflow: not matched → nothing happens
    const c = (await api('POST', '/api/v1/records/lead', { last_name: 'Elsewhere', company: 'X' })).json;
    expect((await api('GET', `/api/v1/tasks?relatedObject=lead&relatedId=${c.id}`)).json.items.length).toBe(0);

    const runs = (await api('GET', `/api/admin/workflows/${w.json.id}/runs`)).json.items;
    const pathOfFirst = runs.find((r: Json) => r.record_id === a.id).output;
    expect(pathOfFirst[0]).toMatchObject({ branch: 'Big budget?', result: 'then' });
  });

  it('limits nesting depth', async () => {
    const deep = (n: number): Json => (n === 0 ? { type: 'ai_score' } : { type: 'branch', conditions: [], then: [deep(n - 1)], else: [] });
    const r = await api('POST', '/api/admin/workflows', { name: 'Too deep', objectKey: 'lead', triggerEvent: 'created', actions: [deep(5)] });
    expect(r.status).toBe(400);
  });
});
