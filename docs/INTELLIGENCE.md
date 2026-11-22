# Revenue intelligence (Copilot)

SanchalanOS adds an intelligence layer on top of the CRM: a **context layer** that links everything known about a customer, **task agents** that work over it, a daily **Copilot** workspace, an **insights feed**, and **Ask SanchalanOS**. Every agent cites the records it used, and everything runs as the person asking, so nobody sees more than they could in the app.

## The context layer

`apps/api/src/services/intel/context.ts`

- For a lead, contact, account or deal it gathers, as the viewer:
  - the record;
  - the customer account and its contacts and deals;
  - quotes, orders, invoices, tickets and installations;
  - competitors on the deal(s) with their battlecards;
  - calls, notes, emails, WhatsApp messages and meetings (with debriefs);
  - open action items and tasks;
  - risk and health scores.
- Every piece goes through record visibility and field security. Contact details and fields marked as personal data are left out of the text sent to models.
- Facts are numbered (`F1`, `F2`, …). Agents must cite the refs they rely on, and refs that don't match a fact are dropped. The UI turns citations into links to the records.
- **Entity resolution:** emails that arrived without a linked record are matched to a contact or lead by address. If that fails, they are matched to an account by the sender's company domain (never public mail domains such as gmail.com). This runs in the hourly sweep.

## Agents

Defined in `packages/shared/src/agents.ts`; run by `services/intel/agents.ts`.

| Area | Agent | Runs on | What it does |
|---|---|---|---|
| Pipeline creation | Account research | account, lead | CRM facts plus the company's public website. Gives an overview, likely needs, talking points, fit score, risks, and questions from the industry playbook. |
| | Outreach writer | lead, contact | A first message plus two follow-ups on email or WhatsApp. It checks consent and never sends anything itself. |
| Deal execution | Meeting prep | calendar meeting | A brief with the objective, recap, open items, risks, competition, talking points, questions and the outcome to aim for. It can run on its own for meetings in the next 18 hours, within a daily budget. |
| | Meeting debrief | calendar meeting | Built from notes, a pasted transcript or an uploaded recording (transcribed with Whisper; the audio is not kept). Produces a summary, decisions, qualification (budget, authority, need, timeline), action items, **suggested field updates** and competitors mentioned. |
| | Call debrief | logged call | The same as the meeting debrief, from a transcript or recording. |
| | Deal risk | deal | A rule-based risk score with the factors behind it, plus a plan to save the deal. |
| | Competitive coach | deal | Positioning, objections with answers, and questions that expose the competitor, all from your battlecards. |
| Customer success and growth | Account health | account | A rule-based health score from tickets, SLA breaches, CSAT, overdue invoices and contact gaps, plus a retention plan. |
| | Growth opportunities | account | Industry plays (AMC and cleaning for solar, wardrobes after kitchens, LED upgrades for signage, next room for interiors…), products similar customers also bought, referral asks and re-engagement. |
| Team performance | My focus today | the signed-in person | A ranked list covering meetings to prepare, leads waiting, deals at risk or closing, overdue follow-ups, expiring quotes and tasks due. |
| | Pipeline review | every deal you can see | Stalled, slipped and no-next-step deals, risk by owner, and coaching notes. |

**Rule-based first.** Every agent produces a rule-based result, so it still answers when AI is switched off, over quota or failing; the model adds language and judgement on top. Scores, the insights sweep and the focus list never call a model. Outputs say whether AI was used.

**Writes need a person.** Agents never change records on their own:

- **Field updates** become suggestions. Someone with edit access applies or rejects each one, and the change is logged on the timeline.
- **Action items** are created for the meeting or record owner.
- **Competitor tags** from a conversation are marked as coming from AI.

## Copilot workspace (`/copilot`)

- Today's meetings, each marked "Brief ready / Prepare" or "Debriefed / Debrief".
- **Do these first:** the focus list.
- Action items, split into open, in progress, overdue and done; AI-made items are flagged.
- The insights feed, with snooze and dismiss.
- Ask SanchalanOS.
- A pipeline review for managers (anyone who can see more than their own deals).

Records (leads, contacts, accounts, deals) get a **Copilot** tab with:

- scores, Ask about this record, and the agents for the record with their last results and sources;
- suggested updates waiting for approval;
- competitors (on deals), calls to debrief and action items;
- "What SanchalanOS knows about this record".

## Insights (hourly sweep)

`services/intel/sweep.ts`, called from the 5-minute cron and gated in KV so it runs at most hourly. It recomputes deal-risk and account-health scores and finds:

- deals at risk;
- slipped close dates;
- new leads nobody has answered (default 4 hours);
- meetings in the next day without a brief;
- quotes expiring within 3 days;
- late-stage deals with a competitor;
- accounts at risk;
- growth opportunities;
- overdue action items.

Each insight goes to the record owner, who is notified once. Insights that stop being true disappear on the next run unless someone already acted on them or dismissed them.

## Ask SanchalanOS

- **About a record:** answers from that record's context.
- **Across the CRM:**
  - finds conversations by meaning through the vector index (Vectorize, namespace `<tenant>:ix`, ids only — never text), with Postgres full-text search as the fallback;
  - also uses records named in the question and knowledge-base excerpts.
- Every hit is re-read from the database and kept only if the person asking can open its record.
- New conversations are added to the index by the hourly sweep.

## Settings

- **Settings → AI agents:** switch each agent on or off; let meeting prep run on its own, with a daily budget; set the stalled-deal days and the lead-reply hours.
- **Settings → Competitors:** battlecards (strengths, weaknesses, pricing, how we win, other names customers use) and win rate against each competitor.

## Privacy

Erasing a person (DPDP request) also removes:

- their search-index entries (including the vectors);
- agent runs about them or citing them;
- suggestions, action items, insights and scores about them;
- notes and transcripts of meetings linked to them.
