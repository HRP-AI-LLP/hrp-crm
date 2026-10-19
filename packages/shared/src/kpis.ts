/**
 * The KPI library behind "Business health". Each KPI is computed by the API over the records the
 * viewer can see; definitions here give the UI its label, format, direction and explanation.
 */
export type KpiFormat = 'number' | 'money' | 'percent' | 'minutes' | 'hours' | 'days' | 'money_per_day' | 'ratio';
export type KpiArea = 'acquisition' | 'sales' | 'operations' | 'finance' | 'service' | 'engagement';

export interface KpiDef {
  key: string;
  label: string;
  area: KpiArea;
  format: KpiFormat;
  /** which way is good */
  better: 'higher' | 'lower';
  /** shown under the number: how it is measured */
  how: string;
  /** app that must be on (orders, delivery, billing, service) */
  app?: string;
}

export const KPI_AREAS: Record<KpiArea, string> = {
  acquisition: 'Leads',
  sales: 'Sales',
  operations: 'Delivery',
  finance: 'Cash',
  service: 'Service',
  engagement: 'Conversations',
};

export const KPIS: KpiDef[] = [
  { key: 'leads_new', label: 'New leads', area: 'acquisition', format: 'number', better: 'higher', how: 'Leads created in the period' },
  { key: 'lead_response_minutes', label: 'Lead response time', area: 'acquisition', format: 'minutes', better: 'lower', how: 'Median time from a new lead to the first call, message, email or meeting' },
  { key: 'lead_conversion_rate', label: 'Lead conversion', area: 'acquisition', format: 'percent', better: 'higher', how: 'Leads created in the period that have been converted' },
  { key: 'referral_share', label: 'Referral and partner leads', area: 'acquisition', format: 'percent', better: 'higher', how: 'Share of new leads from referrals, architects, designers, dealers and partners' },
  { key: 'quote_lead_days', label: 'Enquiry to quote', area: 'sales', format: 'days', better: 'lower', how: 'Median days from a deal being opened to its first quote' },
  { key: 'quote_acceptance_rate', label: 'Quote acceptance', area: 'sales', format: 'percent', better: 'higher', how: 'Quotes accepted out of those decided (accepted, rejected or expired) in the period' },
  { key: 'win_rate', label: 'Win rate', area: 'sales', format: 'percent', better: 'higher', how: 'Deals won out of deals closed in the period' },
  { key: 'avg_deal_size', label: 'Average deal size', area: 'sales', format: 'money', better: 'higher', how: 'Average amount of deals won in the period' },
  { key: 'sales_cycle_days', label: 'Sales cycle', area: 'sales', format: 'days', better: 'lower', how: 'Average days from opening to winning a deal' },
  { key: 'revenue_won', label: 'Revenue won', area: 'sales', format: 'money', better: 'higher', how: 'Amount of deals won in the period' },
  { key: 'pipeline_coverage', label: 'Pipeline coverage', area: 'sales', format: 'ratio', better: 'higher', how: 'Open pipeline divided by the revenue target (3× is healthy)' },
  { key: 'sales_velocity', label: 'Sales velocity', area: 'sales', format: 'money_per_day', better: 'higher', how: 'Open deals × win rate × average deal size ÷ sales cycle' },
  { key: 'orders_booked', label: 'Orders booked', area: 'operations', format: 'money', better: 'higher', how: 'Value of orders confirmed in the period', app: 'orders' },
  { key: 'on_time_delivery', label: 'On-time delivery', area: 'operations', format: 'percent', better: 'higher', how: 'Deliveries made on or before the planned date', app: 'delivery' },
  { key: 'install_first_time_right', label: 'Installed right first time', area: 'operations', format: 'percent', better: 'higher', how: 'Installations with no defect or installation complaint within 30 days', app: 'delivery' },
  { key: 'collected', label: 'Collected', area: 'finance', format: 'money', better: 'higher', how: 'Payments received in the period', app: 'billing' },
  { key: 'dso_days', label: 'Days sales outstanding', area: 'finance', format: 'days', better: 'lower', how: 'Receivables ÷ invoiced in the last 90 days × 90', app: 'billing' },
  { key: 'collection_efficiency', label: 'Collection efficiency', area: 'finance', format: 'percent', better: 'higher', how: 'Share of invoices due in the period that were paid', app: 'billing' },
  { key: 'overdue_share', label: 'Overdue receivables', area: 'finance', format: 'percent', better: 'lower', how: 'Overdue amount as a share of all receivables', app: 'billing' },
  { key: 'sla_compliance', label: 'Resolved within SLA', area: 'service', format: 'percent', better: 'higher', how: 'Tickets resolved in the period without breaching their SLA', app: 'service' },
  { key: 'ticket_first_response_hours', label: 'First response to complaints', area: 'service', format: 'hours', better: 'lower', how: 'Median hours to the first response on a ticket', app: 'service' },
  { key: 'csat', label: 'Customer satisfaction', area: 'service', format: 'number', better: 'higher', how: 'Average rating (1–5) customers gave resolved tickets', app: 'service' },
  { key: 'chat_response_minutes', label: 'WhatsApp reply time', area: 'engagement', format: 'minutes', better: 'lower', how: 'Median minutes to the first reply in a new conversation' },
  { key: 'campaign_read_rate', label: 'Campaign read rate', area: 'engagement', format: 'percent', better: 'higher', how: 'Messages read out of messages sent by campaigns in the period' },
];

export const KPI_BY_KEY: Record<string, KpiDef> = Object.fromEntries(KPIS.map((k) => [k.key, k]));
