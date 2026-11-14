import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { extractActionLines, siteUrl } from '../src/services/intel/agents';
import { intelSweepTenant } from '../src/services/intel/sweep';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let token = '';
let tenantId = '';
let accountId = '';
let dealId = '';
let contactId = '';
let eventId = '';
let aiDown = false;
const prompts: { system: string; user: string }[] = [];
const realFetch = globalThis.fetch;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

/** Workers AI stand-in: answers each agent's prompt with plausible JSON. */
const fakeAi = {
  async run(model: string, input: Record<string, any>) {
    if (input.audio) return { text: 'Customer said the budget is about 5.5 lakh and they want to close by mid December. Action: send revised quote with walnut finish.' };
    if (aiDown) throw new Error('model overloaded');
    const system = String(input.messages?.[0]?.content ?? '');
    const user = String(input.messages?.[1]?.content ?? '');
    prompts.push({ system, user });
    const reply = (o: unknown) => ({ response: JSON.stringify(o), usage: { prompt_tokens: 100, completion_tokens: 50 } });
    if (system.includes('Research this prospect')) return reply({ overview: 'Sharma Homes builds premium villas in Pune.', needs: [{ text: 'Full home interiors for a new villa', refs: ['F1', 'F99'] }], talking_points: [{ text: 'They liked walnut finishes', refs: ['F3'] }], questions: ['When is possession?'], fit: { score: 82, reasons: ['Premium segment'] }, risks: [] });
    if (system.includes('Prepare the salesperson')) return reply({ objective: 'Agree the final design and get a booking advance', recap: [{ text: 'Asked for walnut finish samples', refs: ['F2'] }], open_items: [], risks: [{ text: 'Close date already passed', refs: ['F1'] }], competitor_tips: [], talking_points: [], questions: ['Who signs off?'], desired_outcome: 'Booking advance' });
    if (system.includes('Extract what happened'))
      return reply({
        summary: 'Customer confirmed the scope and a budget of about 5.5 lakh. They compared us with WoodCraft.',
        decisions: ['Go with walnut finish'],
        action_items: [{ title: 'Send revised quote with walnut finish', owner: 'us', due_in_days: 2 }, { title: 'Share possession letter', owner: 'customer', due_in_days: 5 }],
        qualification: { budget: '5.5 lakh', authority: 'Both owners decide', need: 'Full home', timeline: 'Mid December' },
        sentiment: 'positive',
        next_step: 'Revised quote by Friday',
        field_updates: [
          { field: 'amount', value: '5.5 lakh', reason: 'Budget is about 5.5 lakh' },
          { field: 'close_date', value: '2026-12-15', reason: 'Want to close by mid December' },
          { field: 'owner_id', value: 'someone', reason: 'not allowed' },
          { field: 'stage', value: 'No such stage', reason: 'ignored' },
        ],
        competitors_mentioned: ['WoodCraft'],
      });
    if (system.includes('could slip')) return reply({ explanation: 'No contact for weeks and the close date has passed.', save_plan: [{ text: 'Call the decision maker this week', refs: ['F1'] }] });
    if (system.includes('first-touch')) return reply({ subject: 'Ideas for your new home', body: 'Hi Priya, thanks for reaching out…', follow_ups: [{ after_days: 3, body: 'Just checking in' }], refs: ['F1'] });
    if (system.includes('reviewing the pipeline')) return reply({ headline: 'Pipeline needs follow-up', highlights: [], concerns: [{ text: 'Villa interiors slipped', refs: ['F1'] }], coaching: [] });
    if (system.includes('Answer the question using only the numbered facts')) {
      const ref = user.match(/\[(F\d+)\][^\n]*walnut/i)?.[1] ?? 'F1';
      return reply({ answer: `They asked for a walnut finish [${ref}].`, refs: [ref] });
    }
    return reply({});
  },
};

beforeAll(async () => {
  h = await makeHarness('synapse_test_intel');
  (h.env as Json).AI = fakeAi;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://sharmahomes.example')) return new Response('<html><head><title>Sharma Homes</title><meta name="description" content="Premium villas in Pune"></head><body><script>x()</script><p>We build luxury villas.</p></body></html>', { headers: { 'content-type': 'text/html' } });
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('intelco', 'owner@intelco.test');
  token = (await h.login('intelco', 'owner@intelco.test')).token;
  api = h.as('intelco', token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  await api('POST', '/api/admin/users', { email: 'rep@intelco.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('intelco', (await h.login('intelco', 'rep@intelco.test')).token);

  const acc = await api('POST', '/api/v1/records/account', { name: 'Sharma Homes', website: 'https://sharmahomes.example' });
  expect(acc.status, JSON.stringify(acc.json)).toBe(201);
  accountId = acc.json.id;
  contactId = (await api('POST', '/api/v1/records/contact', { first_name: 'Priya', last_name: 'Sharma', email: 'priya@sharmahomes.example', account_id: accountId })).json.id;
  const d = await api('POST', '/api/v1/records/deal', { name: 'Villa interiors', amount: 400000, account_id: accountId, contact_id: contactId, close_date: '2026-10-01' });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  dealId = d.json.id;
  await api('POST', `/api/v1/records/contact/${contactId}/activities`, { kind: 'call', subject: 'Discovery call', body: 'Priya asked for walnut finish samples and a 3BHK layout.', direction: 'out', occurredAt: '2026-09-20T10:00:00Z' });
  await api('POST', `/api/v1/records/deal/${dealId}/activities`, { kind: 'note', subject: 'Site visit', body: 'Measured the living room and kitchen; ceiling height 10 ft.' });
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('helpers', () => {
  it('reads only public company sites and pulls follow-ups out of notes', () => {
    expect(siteUrl('priya@sharmahomes.example')).toBe('https://sharmahomes.example');
    expect(siteUrl('someone@gmail.com')).toBeNull();
    expect(siteUrl('http://10.0.0.1/admin')).toBeNull();
    expect(siteUrl('https://localhost:8080')).toBeNull();
    expect(siteUrl('intranet')).toBeNull();
    expect(extractActionLines('Notes\n- [ ] send the quote\nAction: book site visit\nTODO: call Priya\nrandom line')).toEqual(['send the quote', 'book site visit', 'call Priya']);
  });
});

describe('context layer', () => {
  it('gathers what the viewer can see, numbered for citation', async () => {
    const r = await api('GET', `/api/v1/intel/context/deal/${dealId}`);
    expect(r.status).toBe(200);
    const kinds = r.json.facts.map((f: Json) => f.kind);
    expect(kinds).toContain('record');
    expect(kinds).toContain('activity');
    expect(r.json.facts[0].ref).toBe('F1');
    expect(r.json.facts.some((f: Json) => f.text.includes('walnut'))).toBe(true);
    // no contact details in the facts
    expect(JSON.stringify(r.json.facts)).not.toContain('priya@sharmahomes.example');
    // a rep who cannot see the deal gets nothing
    expect((await rep('GET', `/api/v1/intel/context/deal/${dealId}`)).status).toBe(404);
  });
});

describe('agents', () => {
  it('research cites only real facts and reads the website', async () => {
    const r = await api('POST', '/api/v1/intel/agents/account_research/run', { object: 'account', id: accountId });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.aiUsed).toBe(true);
    expect(r.json.output.headline).toContain('Sharma Homes builds');
    const needs = r.json.output.sections.find((s: Json) => s.key === 'needs');
    expect(needs.items[0].cites.map((c: Json) => c.ref)).toEqual(['F1']);
    expect(prompts.at(-1)!.user).toContain('Premium villas in Pune');
    expect(prompts.at(-1)!.user).not.toContain('x()');
    const usage = await sql(`select task from ai_usage where task = 'agent'`);
    expect(usage.length).toBeGreaterThan(0);
  });

  it('falls back to the rule-based result when AI fails', async () => {
    aiDown = true;
    try {
      const r = await api('POST', '/api/v1/intel/agents/deal_risk/run', { object: 'deal', id: dealId });
      expect(r.status).toBe(201);
      expect(r.json.aiUsed).toBe(false);
      expect(r.json.output.note).toMatch(/rule-based/);
      expect(r.json.output.score).toBeGreaterThan(30);
      expect(r.json.output.sections[0].items.map((i: Json) => i.text).join(' ')).toMatch(/close date passed/i);
    } finally {
      aiDown = false;
    }
    const s = await api('GET', `/api/v1/intel/scores/deal/${dealId}`);
    expect(s.json.items[0]).toMatchObject({ kind: 'deal_risk' });
    const r2 = await api('POST', '/api/v1/intel/agents/deal_risk/run', { object: 'deal', id: dealId });
    expect(r2.json.output.sections.find((x: Json) => x.key === 'plan').items[0].text).toContain('decision maker');
  });

  it('outreach respects consent', async () => {
    const r = await api('POST', '/api/v1/intel/agents/outreach/run', { object: 'contact', id: contactId, channel: 'email' });
    expect(r.status).toBe(201);
    expect(r.json.output.allowed).toBe(false);
    expect(r.json.output.blockedReason).toBe('no_consent');
    expect(r.json.output.draft.body).toContain('Priya');
  });

  it('a switched-off agent does not run', async () => {
    expect((await api('PUT', '/api/admin/intel/agents/competitive', { enabled: false })).status).toBe(200);
    expect((await api('POST', '/api/v1/intel/agents/competitive/run', { object: 'deal', id: dealId })).status).toBe(409);
    expect((await rep('PUT', '/api/admin/intel/agents/competitive', { enabled: true })).status).toBe(403);
    expect((await api('PUT', '/api/admin/intel/agents/deal_risk', { autoRun: true })).status).toBe(400);
  });
});

describe('meetings', () => {
  it('prep, notes, recording, debrief, suggestions and competitor tagging', async () => {
    const c = await api('POST', '/api/admin/intel/competitors', { name: 'WoodCraft', strengths: 'Cheaper laminates', howWeWin: 'Show our 10-year warranty' });
    expect(c.status).toBe(201);
    const start = new Date(Date.now() + 3 * 3600_000).toISOString();
    const e = await api('POST', '/api/v1/events', { title: 'Design presentation', startsAt: start, endsAt: new Date(Date.parse(start) + 3600_000).toISOString(), relatedObject: 'deal', relatedId: dealId });
    expect(e.status).toBe(201);
    eventId = e.json.id;

    const prep = await api('POST', '/api/v1/intel/agents/meeting_prep/run', { object: 'event', id: eventId });
    expect(prep.status, JSON.stringify(prep.json)).toBe(201);
    expect(prep.json.output.sections.find((s: Json) => s.key === 'objective').text).toContain('booking advance');
    let m = await api('GET', `/api/v1/intel/meetings/${eventId}`);
    expect(m.json.prep.id).toBe(prep.json.id);
    expect((await rep('GET', `/api/v1/intel/meetings/${eventId}`)).status).toBe(404);

    expect((await api('PUT', `/api/v1/intel/meetings/${eventId}/notes`, { notes: 'Walked through the 3D design. Priya loved it.' })).status).toBe(200);
    const audio = await h.app.request(`http://synapse.test/api/v1/intel/meetings/${eventId}/transcribe`, { method: 'POST', headers: { 'x-tenant': 'intelco', authorization: `Bearer ${token}`, 'content-type': 'audio/mpeg' }, body: new Uint8Array([1, 2, 3, 4]) }, h.env);
    expect(audio.status).toBe(200);
    expect(((await audio.json()) as Json).transcript).toContain('5.5 lakh');

    const d = await api('POST', '/api/v1/intel/agents/meeting_debrief/run', { object: 'event', id: eventId });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(prompts.at(-1)!.user).toContain('Priya loved it');
    expect(prompts.at(-1)!.user).toContain('5.5 lakh');
    expect(d.json.actionItems.map((i: Json) => i.title)).toEqual(['Send revised quote with walnut finish', 'Customer to: Share possession letter']);
    expect(d.json.suggestions.map((s: Json) => s.field).sort()).toEqual(['amount', 'close_date']);
    m = await api('GET', `/api/v1/intel/meetings/${eventId}`);
    expect(m.json.debrief.id).toBe(d.json.id);
    expect(m.json.actionItems).toHaveLength(2);

    const comp = await api('GET', `/api/v1/intel/deals/${dealId}/competitors`);
    expect(comp.json.items).toMatchObject([{ name: 'WoodCraft', source: 'ai', status: 'active' }]);

    const sug = await api('GET', `/api/v1/intel/suggestions?object=deal&id=${dealId}`);
    const amount = sug.json.items.find((s: Json) => s.field_key === 'amount');
    expect(amount.proposed_value).toBe(550000);
    expect((await rep('POST', `/api/v1/intel/suggestions/${amount.id}/apply`)).status).toBe(404);
    expect((await api('POST', `/api/v1/intel/suggestions/${amount.id}/apply`)).status).toBe(200);
    expect((await api('GET', `/api/v1/records/deal/${dealId}`)).json.amount).toBe(550000);
    expect((await api('POST', `/api/v1/intel/suggestions/${amount.id}/apply`)).status).toBe(400);
    const close = sug.json.items.find((s: Json) => s.field_key === 'close_date');
    expect((await api('POST', `/api/v1/intel/suggestions/${close.id}/reject`)).status).toBe(200);

    const tl = await sql(`select subject from activities where related_object = 'deal' and related_id = $1 and kind = 'meeting'`, [dealId]);
    expect(tl[0]!.subject).toBe('Meeting debrief (AI summary): Design presentation');
  });

  it('action items belong to their owner', async () => {
    const mine = await api('GET', '/api/v1/intel/action-items?scope=mine');
    const item = mine.json.items.find((i: Json) => i.title.startsWith('Send revised'));
    expect(item).toMatchObject({ ai_generated: true, source: 'meeting', related_object: 'deal' });
    expect((await rep('PATCH', `/api/v1/intel/action-items/${item.id}`, { status: 'done' })).status).toBe(404);
    const done = await api('PATCH', `/api/v1/intel/action-items/${item.id}`, { status: 'done' });
    expect(done.json.status).toBe('done');
    expect(done.json.completed_at).toBeTruthy();
    const made = await rep('POST', '/api/v1/intel/action-items', { title: 'Call back', relatedObject: 'deal', relatedId: dealId });
    expect(made.status).toBe(404);
  });
});

describe('review fixes', () => {
  it("briefs are personal, meeting writes need write access, and private meetings stay out of others' context", async () => {
    const repId = (await rep('GET', '/api/auth/me')).json.user.id;
    // a meeting the rep attends, on an account the rep can read
    const start = new Date(Date.now() + 5 * 3600_000).toISOString();
    const shared = await api('POST', '/api/v1/events', { title: 'Joint visit', startsAt: start, endsAt: new Date(Date.parse(start) + 3600_000).toISOString(), relatedObject: 'account', relatedId: accountId, attendees: [{ userId: repId }] });
    expect(shared.status).toBe(201);
    const brief = await api('POST', '/api/v1/intel/agents/meeting_prep/run', { object: 'event', id: shared.json.id });
    expect(brief.status).toBe(201);
    const seen = await rep('GET', `/api/v1/intel/meetings/${shared.json.id}`);
    expect(seen.status).toBe(200);
    expect(seen.json.prep).toBeNull();
    expect((await rep('GET', `/api/v1/intel/runs?object=event&id=${shared.json.id}`)).json.items).toEqual([]);
    expect((await api('GET', `/api/v1/intel/runs?object=event&id=${shared.json.id}`)).json.items).toHaveLength(1);
    // the owner's private meeting on the same account never appears in the rep's view of the account
    const priv = await api('POST', '/api/v1/events', { title: 'Pricing strategy with Priya', startsAt: start, endsAt: new Date(Date.parse(start) + 3600_000).toISOString(), relatedObject: 'account', relatedId: accountId });
    const ctxRep = await rep('GET', `/api/v1/intel/context/account/${accountId}`);
    expect(ctxRep.status).toBe(200);
    expect(JSON.stringify(ctxRep.json.facts)).not.toContain('Pricing strategy');
    expect(JSON.stringify((await api('GET', `/api/v1/intel/context/account/${accountId}`)).json.facts)).toContain('Pricing strategy');
    // not invited: no notes, no debrief
    expect((await rep('PUT', `/api/v1/intel/meetings/${priv.json.id}/notes`, { notes: 'x' })).status).toBe(404);
    expect((await rep('POST', '/api/v1/intel/agents/meeting_debrief/run', { object: 'event', id: priv.json.id, notes: 'Action: do something risky please' })).status).toBe(404);
  });

  it('assigns action items only to people who can see the record; battlecards need deal access', async () => {
    const repId = (await rep('GET', '/api/auth/me')).json.user.id;
    const r = await api('POST', '/api/v1/intel/action-items', { title: 'Check pricing', relatedObject: 'deal', relatedId: dealId, ownerId: repId });
    expect(r.status).toBe(400);
    const ok = await api('POST', '/api/v1/intel/action-items', { title: 'Call Priya', relatedObject: 'contact', relatedId: contactId, ownerId: repId });
    expect(ok.status).toBe(201);
  });
});

describe('insights sweep and Copilot', () => {
  it('finds waiting leads and risky deals, notifies once, and clears what is resolved', async () => {
    const lead = await api('POST', '/api/v1/records/lead', { first_name: 'Anil', last_name: 'Kumar', source: 'website' });
    await sql(`update leads set created_at = now() - interval '6 hours' where id = $1`, [lead.json.id]);
    const db = Db.fromEnv(h.env);
    try {
      const r = await intelSweepTenant(h.env, db, tenantId);
      expect(r.insights).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
    const ins = await api('GET', '/api/v1/intel/insights');
    const kinds = ins.json.items.map((i: Json) => i.kind);
    expect(kinds).toContain('lead_waiting');
    expect(kinds).toContain('deal_slipped');
    expect((await rep('GET', '/api/v1/intel/insights')).json.items).toHaveLength(0);
    const notes = await sql(`select title from notifications where kind = 'insight'`);
    expect(notes.some((n) => String(n.title).includes('Anil Kumar'))).toBe(true);

    const cp = await api('GET', '/api/v1/intel/copilot');
    expect(cp.status).toBe(200);
    expect(cp.json.meetings.map((m: Json) => m.id)).toContain(eventId);
    expect(cp.json.focus.map((f: Json) => f.title)).toContain('Reply to Anil Kumar');
    expect(cp.json.actionItems.open).toBeGreaterThanOrEqual(1);

    // replying clears the insight on the next sweep; notifications are not repeated
    await api('POST', `/api/v1/records/lead/${lead.json.id}/activities`, { kind: 'call', subject: 'Called back', direction: 'out' });
    const db2 = Db.fromEnv(h.env);
    try {
      await intelSweepTenant(h.env, db2, tenantId);
    } finally {
      await db2.close();
    }
    expect((await api('GET', '/api/v1/intel/insights')).json.items.map((i: Json) => i.kind)).not.toContain('lead_waiting');
    const again = await sql(`select count(*)::int as n from notifications where kind = 'insight' and title like '%Anil Kumar%'`);
    expect(again[0]!.n).toBe(1);
    const slipped = (await api('GET', '/api/v1/intel/insights')).json.items.find((i: Json) => i.kind === 'deal_slipped');
    expect((await api('PATCH', `/api/v1/intel/insights/${slipped.id}`, { status: 'dismissed' })).json.status).toBe('dismissed');
  });

  it('focus and pipeline review run for the person asking', async () => {
    const f = await rep('POST', '/api/v1/intel/agents/rep_focus/run', {});
    expect(f.status).toBe(201);
    expect(f.json.output.focus.map((x: Json) => x.title)).toEqual(['Prepare for Joint visit']);
    const p = await api('POST', '/api/v1/intel/agents/pipeline_review/run', {});
    expect(p.status).toBe(201);
    expect(p.json.output.owners[0].deals).toBe(1);
    const rp = await rep('POST', '/api/v1/intel/agents/pipeline_review/run', {});
    expect(rp.json.output.headline).toMatch(/^0 open deals/);
  });
});

describe('Ask Synapse', () => {
  it('answers from conversations the asker can see, with citations', async () => {
    const r = await api('POST', '/api/v1/intel/ask', { question: 'Which finish did Priya ask about?' });
    expect(r.status).toBe(200);
    expect(r.json.answer).toContain('walnut');
    expect(r.json.citations.length).toBeGreaterThan(0);
    expect(r.json.citations.some((c: Json) => c.id === contactId || c.id === dealId)).toBe(true);
    // reps read shared contacts, so they find the call with Priya, but never the deal's notes
    const repAsk = await rep('POST', '/api/v1/intel/ask', { question: 'What is the ceiling height at the site?' });
    expect(repAsk.json.matches.filter((m: Json) => m.text.includes('ceiling'))).toEqual([]);
    const own = await api('POST', '/api/v1/intel/ask', { question: 'What is the ceiling height at the site?' });
    expect(own.json.matches.some((m: Json) => m.text.includes('ceiling'))).toBe(true);
    const scoped = await api('POST', '/api/v1/intel/ask', { question: 'What is the ceiling height?', object: 'deal', id: dealId });
    expect(scoped.status).toBe(200);
    expect((await rep('POST', '/api/v1/intel/ask', { question: 'What is the ceiling height?', object: 'deal', id: dealId })).status).toBe(404);
  });
});
