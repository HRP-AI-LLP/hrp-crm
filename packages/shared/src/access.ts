/**
 * Work areas: what parts of the product a role may use. A role lists its areas in
 * `permissions.apps` ("*" = every area). Outside its areas a role sees no records (whatever its
 * object rights say) and every API route of that area answers 403. Home, tasks, calendar,
 * notifications, approvals, files, own expenses, own connections and the assistant are always there.
 * Being on a project's team opens Projects (only the projects they are on), whatever the role.
 */
export const WORK_AREAS = [
  { key: 'crm', label: 'CRM', help: 'Leads, contacts, accounts, deals, pipeline, forecast' },
  { key: 'sales', label: 'Sales', help: 'Quotes, sales orders, price lists, dealers and schemes' },
  { key: 'marketing', label: 'Marketing', help: 'Campaigns, sequences, lead forms' },
  { key: 'inbox', label: 'Inbox & WhatsApp', help: 'Customer conversations on email, WhatsApp, Instagram' },
  { key: 'calls', label: 'Calls & meetings', help: 'Calls, meetings, recordings and their AI notes' },
  { key: 'service', label: 'Service & quality', help: 'Tickets, after-sales, warranties, CAPA, help centre' },
  { key: 'operations', label: 'Operations', help: 'Inventory, purchasing, vendors, deliveries, installations, field work' },
  { key: 'manufacturing', label: 'Manufacturing', help: 'BOMs, work orders, planning, job work' },
  { key: 'billing', label: 'Billing', help: 'Invoices, payments, deposits, payment links' },
  { key: 'books', label: 'Books', help: 'Ledger, banks, bills, vendor payments, Tally' },
  { key: 'gst', label: 'GST', help: 'GST returns, GSTN portal, e-invoices and e-way bills' },
  { key: 'intake', label: 'Intake', help: 'GeM bids, bills and documents read from mail' },
  { key: 'projects', label: 'Projects', help: 'Projects they can open, work items, timesheets, AI delivery, coding agent' },
  { key: 'it', label: 'IT services', help: 'Subscriptions, contracts, client IT assets and vault, capacity' },
  { key: 'insights', label: 'Dashboards & reports', help: 'Dashboards, reports, KPIs, analytics' },
  { key: 'knowledge', label: 'Knowledge base', help: 'Company knowledge base and its AI answers' },
] as const;
export type WorkArea = (typeof WORK_AREAS)[number]['key'];
export const AREA_KEYS = WORK_AREAS.map((a) => a.key) as WorkArea[];

/** Always available to everyone signed in (their own things, or filtered by record rights). */
export const ALWAYS = 'always';

const OBJECT_AREA: Record<string, WorkArea | typeof ALWAYS> = {
  lead: 'crm', contact: 'crm', account: 'crm', deal: 'crm',
  quote: 'sales', product: 'sales', sales_order: 'sales', price_book: 'sales',
  invoice: 'billing', payment: 'billing',
  bill: 'books', vendor_payment: 'books',
  vendor: 'operations', purchase_order: 'operations', shipment: 'operations', installation: 'operations',
  ticket: 'service',
  work_order: 'manufacturing', job_work: 'manufacturing',
  project: 'projects',
  // everyone files their own expenses; tasks and activities follow the records they belong to
  expense: ALWAYS, task: ALWAYS, activity: ALWAYS,
};

/** The area of a record object; objects added by industry packs or by hand belong to the CRM. */
export function areaOfObject(objectKey: string): WorkArea | typeof ALWAYS {
  return OBJECT_AREA[objectKey] ?? 'crm';
}

/** Allowed areas of a role: missing means every area (roles saved before areas existed). */
export function roleAreas(apps: string[] | undefined | null): '*' | Set<string> {
  if (apps === undefined || apps === null || apps.includes('*')) return '*';
  return new Set(apps);
}

export function canUseArea(apps: string[] | undefined, area: string): boolean {
  if (area === ALWAYS) return true;
  return !apps || apps.includes('*') || apps.includes(area);
}

type Rule = [prefix: string, area: WorkArea | typeof ALWAYS];
// first match wins: more specific prefixes first. Paths are under /api/v1.
const RULES: Rule[] = [
  // projects (incl. their calls, chats, AI delivery, coding agent)
  ['/projects', 'projects'], ['/my-tasks', 'projects'], ['/project-reports', 'projects'], ['/time', 'projects'], ['/timesheet', 'projects'],
  ['/work', 'projects'], ['/dev', 'projects'], ['/github', 'projects'], ['/sdlc', 'projects'], ['/agent', 'projects'], ['/mcp', 'projects'],
  // IT services
  ['/it', 'it'], ['/client-assets', 'it'], ['/client-vault', 'it'], ['/connectors', 'it'],
  // calls & meetings
  ['/calls', 'calls'], ['/intel', 'calls'], ['/telephony', 'calls'], ['/meeting-accounts', ALWAYS],
  // CRM
  ['/accounts', 'crm'], ['/deals-loss-reasons', 'crm'], ['/deals', 'crm'], ['/forecast', 'crm'], ['/quotas', 'crm'], ['/email-templates', 'crm'],
  // sales
  ['/quotes', 'sales'], ['/price-books', 'sales'], ['/price-lists', 'sales'], ['/price-for', 'sales'], ['/rebates', 'sales'], ['/rfqs', 'sales'], ['/sales-orders', 'sales'],
  ['/channel', 'sales'], ['/dealer', 'sales'], ['/credit-watch', 'sales'], ['/orders', 'sales'], ['/products', 'sales'], ['/product-categories', 'sales'],
  // marketing
  ['/campaigns', 'marketing'], ['/sequences', 'marketing'], ['/sequences-run', 'marketing'], ['/sequence-enrollments', 'marketing'],
  // inbox
  ['/inbox', 'inbox'], ['/whatsapp', 'inbox'], ['/quick-replies', 'inbox'], ['/docs', 'inbox'], ['/doc-link', 'inbox'],
  // service & quality
  ['/tickets', 'service'], ['/after-sales', 'service'], ['/warranties', 'service'], ['/capas', 'service'], ['/quality-stats', 'service'], ['/spares', 'service'],
  ['/help-centre', 'service'], ['/help', 'service'], ['/tech-docs', 'service'], ['/escalation-matrix', 'service'], ['/sla-policies', 'service'],
  // operations
  ['/inventory', 'operations'], ['/purchase-orders', 'operations'], ['/vendors', 'operations'], ['/warehouses', 'operations'], ['/shipments', 'operations'],
  ['/installations', 'operations'], ['/installation-checklist', 'operations'], ['/field', 'operations'],
  // manufacturing
  ['/mfg', 'manufacturing'],
  // billing
  ['/billing', 'billing'], ['/invoices', 'billing'], ['/payments', 'billing'], ['/deposits', 'billing'], ['/recurring-invoices', 'billing'], ['/payment-links', 'billing'],
  // books & GST (everyone files and follows their own expense claims)
  ['/books/expenses', ALWAYS], ['/books/expense-categories', ALWAYS], ['/books', 'books'], ['/tally', 'books'], ['/gst', 'gst'],
  // intake
  ['/intake', 'intake'],
  // insights
  ['/dashboards', 'insights'], ['/reports', 'insights'], ['/kpis', 'insights'], ['/analytics', 'insights'], ['/insights', 'insights'], ['/solutions', 'insights'],
  // knowledge
  ['/kb', 'knowledge'],
  // always: records (filtered by object rights), search, home, own things
  ['/reconcile', ALWAYS], ['/records', ALWAYS], ['/search', ALWAYS], ['/meta', ALWAYS], ['/home', ALWAYS], ['/dashboard', ALWAYS], ['/tasks', ALWAYS], ['/users', ALWAYS], ['/teams', ALWAYS],
  ['/views', ALWAYS], ['/export', ALWAYS], ['/import', ALWAYS], ['/events', ALWAYS], ['/notifications', ALWAYS], ['/approvals', ALWAYS], ['/files', ALWAYS],
  ['/rules', ALWAYS], ['/digests', ALWAYS], ['/assistant', ALWAYS], ['/push', ALWAYS], ['/integrations', ALWAYS], ['/me', ALWAYS], ['/oauth', ALWAYS],
  ['/hooks', ALWAYS], ['/apps', ALWAYS], ['/organisation', ALWAYS], ['/professionals', ALWAYS], ['/stores', ALWAYS], ['/documents', ALWAYS], ['/doc-templates', ALWAYS], ['/identity', ALWAYS],
  ['/verify', ALWAYS], ['/verify-pdf', ALWAYS], ['/privacy', ALWAYS], ['/consent', ALWAYS], ['/audit', ALWAYS], ['/unsubscribe', ALWAYS], ['/privacy-status', ALWAYS],
  ['/privacy-verify', ALWAYS], ['/openapi.json', ALWAYS], ['/webhook-deliveries', ALWAYS], ['/webhook-events', ALWAYS], ['/status', ALWAYS],
  ['/score', ALWAYS], ['/sentiment', ALWAYS], ['/summarize', ALWAYS], ['/next-actions', ALWAYS], ['/draft-email', ALWAYS],
];

/**
 * The area an API path belongs to (path without /api/v1 or /api/ai), ALWAYS, or null when it is not
 * known — unknown paths are refused for restricted roles, so a new route must be listed here.
 */
// exceptions that cross areas
const PATTERNS: [RegExp, WorkArea | typeof ALWAYS][] = [
  // a work order's status, for whoever may read work orders (sales tells customers where an order is)
  [/^\/mfg\/work-orders\/[^/]+$/, ALWAYS],
  // salespeople log what a customer asked for on a product's roadmap
  [/^\/it\/products\/[^/]+\/requests$/, 'crm'],
  // service figures belong to service
  [/^\/insights\/service(\/|$)/, 'service'],
];

export function areaOfPath(path: string): WorkArea | typeof ALWAYS | null {
  const p = path.replace(/\/+$/, '') || '/';
  for (const [re, area] of PATTERNS) if (re.test(p)) return area;
  for (const [prefix, area] of RULES) if (p === prefix || p.startsWith(`${prefix}/`)) return area;
  return null;
}

/** Areas of the built-in roles. */
export const ROLE_AREAS: Record<string, string[]> = {
  admin: ['*'],
  read_only: ['*'],
  sales_manager: ['crm', 'sales', 'marketing', 'inbox', 'calls', 'service', 'operations', 'insights', 'knowledge'],
  sales_rep: ['crm', 'sales', 'inbox', 'calls', 'insights', 'knowledge'],
  project_manager: ['projects', 'it', 'calls', 'insights', 'knowledge'],
  project_member: ['projects', 'calls', 'knowledge'],
  inventory_manager: ['operations', 'sales', 'knowledge'],
  operations: ['operations', 'sales', 'knowledge'],
  technician: ['operations', 'service', 'knowledge'],
  service_agent: ['service', 'inbox', 'crm', 'knowledge'],
  accounts: ['billing', 'books', 'gst', 'intake', 'sales', 'crm', 'insights', 'knowledge'],
  accountant: ['billing', 'books', 'gst', 'intake', 'insights', 'knowledge'],
  chartered_accountant: ['books', 'gst', 'billing'],
  production_manager: ['manufacturing', 'operations', 'knowledge'],
  shop_floor: ['manufacturing'],
};
