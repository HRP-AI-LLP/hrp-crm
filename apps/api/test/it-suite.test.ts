/**
 * The IT company suite: agile delivery (backlog, sprints, burndown, velocity, releases, code links),
 * change requests with client approval on the portal, estimates against actuals, capacity planning,
 * service contracts with period billing and overage, SaaS subscriptions (trial, renewal, invoicing,
 * seats, cancellation, MRR metrics) and product management (RICE roadmap, requests, public roadmap).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, PW } from './harness';

const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + n);
  return t.toISOString().slice(0, 10);
};

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
const ids = {} as Record<string, string> & { [k: string]: string };

beforeAll(async () => {
  h = await makeHarness('synapse_test_it_suite');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh' } } });
  const u = await api('POST', '/api/admin/users', { email: 'dev@acme.test', fullName: 'Dev', password: PW, roles: ['sales_rep'] });
  expect(u.status, JSON.stringify(u.json)).toBe(201);
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  ids.dev = (await dev('GET', '/api/auth/me')).json.user.id;
  ids.owner = (await api('GET', '/api/auth/me')).json.user.id;
  ids.customer = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', state: 'Uttar Pradesh' })).json.id;
  const p = await api('POST', '/api/v1/records/project', { name: 'NGO portal', account_id: ids.customer, billing_method: 'fixed_price', fixed_fee: 500000, budget_type: 'hours', budget_hours: 200, start_date: addDays(today, -20), end_date: addDays(today, 60) });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  ids.project = p.json.id;
  expect((await api('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member', billRate: 2000, costRate: 800 }] })).status).toBe(200);
}, 120_000);

const task = async (name: string, extra: Record<string, unknown> = {}) => {
  const r = await dev('POST', `/api/v1/projects/${ids.project}/tasks`, { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
};
const agile = (tid: string | undefined, b: Record<string, unknown>, who = dev) => who('PUT', `/api/v1/projects/${ids.project}/agile/tasks/${tid}`, b);

describe('agile delivery', () => {
  it('epics, stories with points, a ranked backlog', async () => {
    ids.epic = await task('Donor management');
    expect((await agile(ids.epic, { workType: 'epic' })).status).toBe(200);
    ids.s1 = await task('Donor sign-up form');
    ids.s2 = await task('Receipt e-mails');
    ids.bug = await task('Login fails on Safari');
    expect((await agile(ids.s1, { workType: 'story', storyPoints: 5, epicId: ids.epic })).status).toBe(200);
    expect((await agile(ids.s2, { workType: 'story', storyPoints: 3, epicId: ids.epic })).status).toBe(200);
    expect((await agile(ids.bug, { workType: 'bug', storyPoints: 2 })).status).toBe(200);
    // an epic is not an epic's child
    expect((await agile(ids.s1, { epicId: ids.s2 })).status).toBe(400);
    expect((await dev('PUT', `/api/v1/projects/${ids.project}/agile/backlog`, { ids: [ids.bug, ids.s1, ids.s2] })).status).toBe(200);
    const b = (await dev('GET', `/api/v1/projects/${ids.project}/agile`)).json;
    expect(b.items.map((i: any) => i.id).slice(0, 3)).toEqual([ids.bug, ids.s1, ids.s2]);
    expect(b.epics[0]).toMatchObject({ items: 2, points: 8 });
  });

  it('sprints: plan, start, burndown, close with carry-over, velocity', async () => {
    // members cannot run sprints
    expect((await dev('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'S1', startDate: addDays(today, -6), endDate: addDays(today, 7) })).status).toBe(403);
    const s = await api('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 1', goal: 'Donors can sign up', startDate: addDays(today, -6), endDate: addDays(today, 7), capacityPoints: 20 });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    ids.sprint1 = s.json.id;
    expect((await api('POST', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint1}/start`)).status).toBe(400); // nothing planned
    for (const t of [ids.s1, ids.s2, ids.bug]) expect((await agile(t, { sprintId: ids.sprint1 })).status).toBe(200);
    expect((await api('POST', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint1}/start`)).json).toMatchObject({ committedPoints: 10 });
    const next = (await api('GET', `/api/v1/projects/${ids.project}/agile/next-sprint`)).json;
    expect(next).toMatchObject({ name: 'Sprint 2', startDate: addDays(today, 8) });
    ids.sprint2 = (await api('POST', `/api/v1/projects/${ids.project}/agile/sprints`, next)).json.id;
    // only one sprint runs at a time
    await agile(ids.s2, { sprintId: ids.sprint2 });
    expect((await api('POST', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint2}/start`)).status).toBe(409);
    await agile(ids.s2, { sprintId: ids.sprint1 });
    // finish the sign-up form
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.s1}`, { status: 'done' })).status).toBe(200);
    const bd = (await api('GET', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint1}/burndown`)).json;
    expect(bd.total).toBe(10);
    expect(bd.days[0]).toMatchObject({ ideal: 10, remaining: 10 });
    expect(bd.days.find((d: any) => d.date === today).remaining).toBe(5);
    expect(bd.days[bd.days.length - 1]).toMatchObject({ ideal: 0, remaining: null });
    const close = await api('POST', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint1}/close`, { moveTo: ids.sprint2 });
    expect(close.json).toMatchObject({ completedPoints: 5, carriedOver: 2 });
    const v = (await api('GET', `/api/v1/projects/${ids.project}/agile/velocity`)).json;
    expect(v).toMatchObject({ average: 5, sprints: [{ name: 'Sprint 1', committed: 10, completed: 5 }] });
  });

  it('pull requests and commits on a task', async () => {
    const l = await dev('POST', `/api/v1/projects/${ids.project}/agile/tasks/${ids.s1}/links`, { url: 'https://github.com/hrpai/ngo-portal/pull/42' });
    expect(l.status, JSON.stringify(l.json)).toBe(201);
    expect(l.json).toMatchObject({ kind: 'pr', title: 'ngo-portal #42' });
    expect((await dev('PUT', `/api/v1/projects/${ids.project}/agile/links/${l.json.id}`, { status: 'merged' })).status).toBe(200);
    const c = await dev('POST', `/api/v1/projects/${ids.project}/agile/tasks/${ids.s1}/links`, { url: 'https://github.com/hrpai/ngo-portal/commit/9fceb02d0ae598e95dc970b74767f19372d61af8' });
    expect(c.json.kind).toBe('commit');
    expect((await dev('GET', `/api/v1/projects/${ids.project}/agile/tasks/${ids.s1}/links`)).json).toHaveLength(2);
  });

  it('a release with notes written from the finished work', async () => {
    const r = await api('POST', `/api/v1/projects/${ids.project}/agile/releases`, { name: 'Donor module', version: '1.2.0', targetDate: addDays(today, 10) });
    ids.release = r.json.id;
    await agile(ids.s1, { releaseId: ids.release });
    await agile(ids.s2, { releaseId: ids.release });
    const notes = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/notes`)).json;
    expect(notes.notes).toContain('# Donor module (1.2.0)');
    expect(notes.notes).toContain('- Donor sign-up form (#2)');
    expect(notes.notes).not.toContain('Receipt e-mails');
    const rel = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/release`, {});
    expect(rel.json).toMatchObject({ movedOut: 1 });
    const b = (await api('GET', `/api/v1/projects/${ids.project}/agile`)).json;
    expect(b.releases[0]).toMatchObject({ status: 'released', released_at: today });
  });
});

describe('change requests, the client portal, estimates', () => {
  it('a change request approved by the client on the portal adds to the budget, fee and end date', async () => {
    const cr = await dev('POST', `/api/v1/projects/${ids.project}/agile/change-requests`, { title: 'Add UPI donations', requestedBy: 'Trustee', impactHours: 24, impactAmount: 60000, impactDays: 10 });
    expect(cr.status, JSON.stringify(cr.json)).toBe(201);
    ids.cr = cr.json.id;
    expect((await dev('POST', `/api/v1/projects/${ids.project}/agile/change-requests/${ids.cr}/approve`)).status).toBe(403);
    expect((await dev('POST', `/api/v1/projects/${ids.project}/agile/change-requests/${ids.cr}/submit`)).status).toBe(200);
    const portal = await api('POST', `/api/v1/projects/${ids.project}/agile/portal`, { on: true });
    expect(portal.json.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    const view = await h.call('GET', `/api/public/portal/${portal.json.token}`);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect(view.json).toMatchObject({ company: 'HRP AI LLP', project: { name: 'NGO portal' } });
    expect(view.json.sprint).toBeFalsy();
    expect(view.json.releases[0]).toMatchObject({ name: 'Donor module', status: 'released' });
    expect(view.json.changeRequests[0]).toMatchObject({ title: 'Add UPI donations', status: 'submitted' });
    const ok = await h.call('POST', `/api/public/portal/${portal.json.token}/change-requests/${ids.cr}`, { body: { decision: 'approve', name: 'R. Trustee' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const p = (await api('GET', `/api/v1/projects/${ids.project}`)).json.project;
    expect(Number(p.budget_hours)).toBe(224);
    expect(Number(p.fixed_fee)).toBe(560000);
    expect(String(p.end_date).slice(0, 10)).toBe(addDays(today, 70));
    const list = (await api('GET', `/api/v1/projects/${ids.project}/agile/change-requests`)).json;
    expect(list[0]).toMatchObject({ status: 'approved', decided_by: 'R. Trustee (client)', applied: true });
    // turned off, the link stops working
    await api('POST', `/api/v1/projects/${ids.project}/agile/portal`, { on: false });
    expect((await h.call('GET', `/api/public/portal/${portal.json.token}`)).status).toBe(404);
  });

  it('estimates against actual hours', async () => {
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.bug}`, { estimateHours: 4 })).status).toBe(200);
    expect((await dev('POST', '/api/v1/time', { projectId: ids.project, taskId: ids.bug, date: addDays(today, -1), minutes: 360 })).status).toBe(201);
    const e = (await dev('GET', `/api/v1/projects/${ids.project}/agile/estimates`)).json;
    expect(e.tasks.find((t: any) => t.id === ids.bug)).toMatchObject({ estimate: 4, actual: 6, variance: 2 });
    expect(e.totals).toMatchObject({ estimate: 4, actual: 6 });
  });

  it('capacity planning: allocations against capacity, by week', async () => {
    const a = await api('POST', '/api/v1/it/allocations', { userId: ids.dev, projectId: ids.project, startDate: today, endDate: addDays(today, 27), hoursPerWeek: 30, role: 'Developer' });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const cap = (await api('GET', `/api/v1/it/capacity?from=${today}`)).json;
    const me = cap.people.find((p: any) => p.userId === ids.dev);
    expect(me.capacity).toBe(40);
    expect(me.weeks[0]).toMatchObject({ planned: 30, load: 75, projects: ['NGO portal'] });
    expect((await dev('GET', `/api/v1/it/capacity?from=${today}`)).status).toBe(403);
  });
});

describe('service contracts', () => {
  it('a monthly retainer: period fee in advance, hours beyond those included in arrears, renewal', async () => {
    const start = addMonths(today, -1);
    const c = await api('POST', '/api/v1/it/contracts', {
      name: 'NGO portal support', accountId: ids.customer, projectId: ids.project, kind: 'retainer', startDate: start, endDate: addDays(addMonths(start, 3), -1),
      billingFrequency: 'monthly', periodFee: 25000, hoursPerPeriod: 2, overageRate: 1500, slaResponseHours: 4, slaResolutionHours: 24, autoRenew: true,
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    expect(c.json.number).toMatch(/^CON\/\d{2}-\d{2}\/0001$/);
    ids.contract = c.json.id;
    expect((await dev('POST', '/api/v1/it/contracts', { name: 'x', accountId: ids.customer, kind: 'amc', startDate: today, billingFrequency: 'yearly' })).status).toBe(403);
    expect((await api('POST', `/api/v1/it/contracts/${ids.contract}/activate`)).status).toBe(200);
    // the run bills the first month (fee only) and the current month (fee + 4 hours over the 2 included last month)
    const run = await api('POST', '/api/v1/it/contracts-run');
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json).toMatchObject({ invoiced: 1, failed: [] });
    const run2 = await api('POST', '/api/v1/it/contracts-run');
    expect(run2.json.invoiced).toBe(1);
    const got = (await api('GET', `/api/v1/it/contracts/${ids.contract}`)).json;
    expect(got.invoices).toHaveLength(2);
    const cur = got.invoices[0];
    expect(cur.overage_hours).toBe(4);
    expect(cur.total).toBe(Math.round((25000 + 4 * 1500) * 1.18));
    expect((await api('POST', `/api/v1/it/contracts/${ids.contract}/invoice`, { periodStart: cur.period_start })).status).toBe(409);
    const list = (await api('GET', '/api/v1/it/contracts')).json;
    expect(list[0]).toMatchObject({ contract_number: c.json.number, hours_per_period: 2 });
    const ren = await api('POST', `/api/v1/it/contracts/${ids.contract}/renew`);
    expect(ren.json.endDate).toBe(addDays(addMonths(start, 6), -1));
  });
});

describe('SaaS subscriptions', () => {
  it('plans, a trial that converts, invoicing in advance with seats, add-ons and usage', async () => {
    const p = await api('POST', '/api/v1/it/plans', { name: 'Synapse Growth', code: 'GROWTH', product: 'Synapse CRM', interval: 'month', price: 4999, includedSeats: 5, seatPrice: 499, usageUnit: 'WhatsApp messages', includedUsage: 1000, usagePrice: 0.5, trialDays: 14 });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.plan = p.json.id;
    ids.planPro = (await api('POST', '/api/v1/it/plans', { name: 'Synapse Pro', interval: 'year', price: 120000, includedSeats: 10, seatPrice: 4000 })).json.id;
    const s = await api('POST', '/api/v1/it/subscriptions', { accountId: ids.customer, planId: ids.plan, startDate: addDays(today, -20), seats: 7, addons: [{ name: 'Priority support', quantity: 1, unitPrice: 1000 }] });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    expect(s.json).toMatchObject({ status: 'trial', number: expect.stringMatching(/^SUB\//) });
    ids.sub = s.json.id;
    expect((await api('POST', `/api/v1/it/subscriptions/${ids.sub}/usage`, { date: addDays(today, -10), quantity: 1600 })).status).toBe(201);
    const run = await api('POST', '/api/v1/it/subscriptions-run');
    expect(run.json, JSON.stringify(run.json)).toMatchObject({ converted: 1, invoiced: 1, failed: [] });
    const got = (await api('GET', `/api/v1/it/subscriptions/${ids.sub}`)).json;
    expect(got.subscription).toMatchObject({ status: 'active', current_period_start: addDays(today, -6) });
    // 4,999 + 2 extra seats × 499 + 1,000 add-on = 6,997 a month
    expect(got.subscription.mrr).toBe(6997);
    expect(got.invoices).toHaveLength(1);
    // plus 600 messages over the 1,000 included × ₹0.50 = ₹300; all + 18% GST
    // rounded to the rupee on the invoice
    expect(got.invoices[0].total).toBe(Math.round((6997 + 300) * 1.18));
    expect((await api('POST', '/api/v1/it/subscriptions-run')).json.invoiced).toBe(0);
  });

  it('seat changes, upgrades, cancellation at period end, and the metrics', async () => {
    expect((await api('PUT', `/api/v1/it/subscriptions/${ids.sub}`, { seats: 9 })).json).toMatchObject({ mrr: 7995, change: 'seats_changed' });
    const second = await api('POST', '/api/v1/it/subscriptions', { accountId: ids.customer, planId: ids.planPro, startDate: today, discountPct: 10 });
    expect(second.json.status).toBe('active');
    const up = await api('PUT', `/api/v1/it/subscriptions/${second.json.id}`, { seats: 12 });
    // (1,20,000 + 2 × 4,000) × 90% ÷ 12 months
    expect(up.json).toMatchObject({ mrr: 9600, change: 'seats_changed' });
    expect((await api('POST', `/api/v1/it/subscriptions/${second.json.id}/cancel_at_period_end`, { reason: 'Moving to monthly' })).json.cancelsOn).toBe(addDays(addMonths(today, 12), -1));
    const m = (await api('GET', '/api/v1/it/saas-metrics')).json;
    expect(m).toMatchObject({ mrr: 7995 + 9600, arr: (7995 + 9600) * 12, subscriptions: 2, customers: 1, trials: 0 });
    const month = m.months[m.months.length - 1];
    expect(month.new).toBeGreaterThan(0);
    expect(month.expansion).toBeGreaterThan(0);
    expect(m.byPlan.map((x: any) => x.name)).toEqual(['Synapse Pro', 'Synapse Growth']);
    const c = await api('POST', `/api/v1/it/subscriptions/${second.json.id}/cancel`, { reason: 'Closed' });
    expect(c.json.status).toBe('cancelled');
    const m2 = (await api('GET', '/api/v1/it/saas-metrics')).json;
    expect(m2.mrr).toBe(7995);
    expect(m2.lostSubscriptions30d).toBe(1);
    expect(m2.revenueChurnPct).toBeGreaterThan(0);
  });
});

describe('product management', () => {
  it('a RICE-scored roadmap, customer requests as votes, items into the backlog, a public roadmap', async () => {
    const p = await api('POST', '/api/v1/it/products', { name: 'NGO Cloud', key: 'ngo', vision: 'Run an NGO from one screen', projectId: ids.project });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.product = p.json.id;
    const i = await api('POST', `/api/v1/it/products/${ids.product}/items`, { title: 'Recurring donations', kind: 'feature', reach: 400, impact: 2, confidence: 80, effort: 2, quarter: '2026-Q4' });
    expect(i.status, JSON.stringify(i.json)).toBe(201);
    ids.item = i.json.id;
    // a salesperson logs what a customer asked for
    const q = await dev('POST', `/api/v1/it/products/${ids.product}/requests`, { title: 'Monthly auto-debit for donors', accountId: ids.customer, importance: 'critical' });
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    expect((await dev('POST', `/api/v1/it/products/${ids.product}/requests/${q.json.id}/triage`, { itemId: ids.item })).status).toBe(403);
    expect((await api('POST', `/api/v1/it/products/${ids.product}/requests/${q.json.id}/triage`, { itemId: ids.item })).json).toMatchObject({ status: 'linked' });
    const r = (await api('GET', `/api/v1/it/products/${ids.product}/roadmap`)).json;
    expect(r.items[0]).toMatchObject({ title: 'Recurring donations', score: 320, votes: 1, critical: 1, weight: 3, mrr_asking: 7995 });
    const w = await api('POST', `/api/v1/it/products/${ids.product}/items/${ids.item}/to-work`, {});
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    const b = (await api('GET', `/api/v1/projects/${ids.project}/agile`)).json;
    expect(b.items.find((x: any) => x.id === w.json.taskId)).toMatchObject({ work_type: 'story', name: 'Recurring donations' });
    expect((await api('GET', `/api/v1/it/products/${ids.product}/roadmap`)).json.items[0].status).toBe('planned');
    // public roadmap and asking for a feature there
    const sh = (await api('POST', `/api/v1/it/products/${ids.product}/share`, { on: true })).json.token;
    const pub = await h.call('GET', `/api/public/roadmap/${sh}`);
    expect(pub.status).toBe(200);
    expect(pub.json.items[0]).toMatchObject({ title: 'Recurring donations', status: 'planned', votes: 1 });
    expect((await h.call('POST', `/api/public/roadmap/${sh}/requests`, { body: { title: 'Tally export', name: 'Asha' } })).status).toBe(201);
    expect((await api('GET', `/api/v1/it/products/${ids.product}/roadmap`)).json.requests.find((x: any) => x.title === 'Tally export')).toMatchObject({ source: 'portal', status: 'new' });
  });
});
