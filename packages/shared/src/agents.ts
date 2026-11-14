/**
 * The agent catalog shown in the app. Each agent works over the context layer (what the viewer can
 * see) and cites the records its output relies on. "needsAi" agents have no rule-based fallback.
 */
export type AgentCategory = 'pipeline' | 'deal' | 'growth' | 'team';
export type AgentSubject = 'lead' | 'contact' | 'account' | 'deal' | 'event' | 'call' | 'me' | 'team';

export interface AgentDef {
  key: string;
  label: string;
  category: AgentCategory;
  subjects: AgentSubject[];
  description: string;
  needsAi: boolean;
  /** can run on its own from the hourly sweep when switched on */
  autoRun?: string;
}

export const AGENT_CATEGORIES: Record<AgentCategory, string> = {
  pipeline: 'Pipeline creation',
  deal: 'Deal execution',
  growth: 'Customer success and growth',
  team: 'Team performance',
};

export const AGENTS: AgentDef[] = [
  { key: 'account_research', label: 'Account research', category: 'pipeline', subjects: ['account', 'lead'], needsAi: false, description: 'Profiles the customer from the CRM and their website: what they likely need, how well they fit, talking points and questions to ask.' },
  { key: 'outreach', label: 'Outreach writer', category: 'pipeline', subjects: ['lead', 'contact'], needsAi: false, description: 'Drafts a personal first message and two follow-ups on email or WhatsApp, checked against consent.' },
  { key: 'meeting_prep', label: 'Meeting prep', category: 'deal', subjects: ['event'], needsAi: false, autoRun: 'Prepares a brief for meetings in the next 18 hours', description: 'A one-page brief before a meeting: recap, open items, risks, competitor notes, questions and the outcome to aim for.' },
  { key: 'meeting_debrief', label: 'Meeting debrief', category: 'deal', subjects: ['event'], needsAi: false, description: 'Turns meeting notes or a recording into a summary, action items, qualification (budget, authority, need, timeline) and suggested field updates.' },
  { key: 'call_debrief', label: 'Call debrief', category: 'deal', subjects: ['call'], needsAi: true, description: 'Transcribes a call and pulls out the summary, sentiment, competitors mentioned and action items.' },
  { key: 'deal_risk', label: 'Deal risk', category: 'deal', subjects: ['deal'], needsAi: false, description: 'Scores how likely a deal is to slip and suggests a plan to save it.' },
  { key: 'competitive', label: 'Competitive coach', category: 'deal', subjects: ['deal'], needsAi: false, description: 'Positioning, likely objections and answers against the competitors on a deal, from your battlecards.' },
  { key: 'account_health', label: 'Account health', category: 'growth', subjects: ['account'], needsAi: false, description: 'Scores the relationship from service, payments and contact history, and suggests how to keep the customer.' },
  { key: 'growth', label: 'Growth opportunities', category: 'growth', subjects: ['account'], needsAi: false, description: 'Finds repeat business: service plans, add-ons other customers bought, referrals and re-engagement.' },
  { key: 'rep_focus', label: 'My focus today', category: 'team', subjects: ['me'], needsAi: false, description: 'A ranked list of what to do first today: meetings to prepare, leads waiting, deals at risk and overdue follow-ups.' },
  { key: 'pipeline_review', label: 'Pipeline review', category: 'team', subjects: ['team'], needsAi: false, description: 'Inspects every open deal you can see: stalled and slipped deals, missing next steps, risk by owner, and coaching notes.' },
];

export const AGENT_BY_KEY: Record<string, AgentDef> = Object.fromEntries(AGENTS.map((a) => [a.key, a]));
