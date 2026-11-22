/**
 * Built-in apps: groups of standard objects and screens a workspace switches on in
 * Settings → Apps. Switching an app on creates its objects (module_key 'app.<key>'), seeds its
 * defaults and roles; switching it off hides them without deleting data.
 */
export interface AppObject {
  key: string;
  label: string;
  plural: string;
  icon: string;
}

export interface AppDefinition {
  key: string;
  name: string;
  description: string;
  objects: AppObject[];
  /** apps that must be on first */
  requires: string[];
  /** roles created when the app is switched on (key → name, description, permissions) */
  roles?: { key: string; name: string; description: string; permissions: Record<string, unknown> }[];
}

const all = { read: 'all', create: true, update: 'all', delete: 'none' } as const;
const readOnly = { read: 'all', create: false, update: 'none', delete: 'none' } as const;
const none = { read: 'none', create: false, update: 'none', delete: 'none' } as const;
/** everyone files their own expenses and claims (the Books app) */
const ownExpense = { read: 'own', create: true, update: 'own', delete: 'own' } as const;

export const APPS: Record<string, AppDefinition> = {
  orders: {
    key: 'orders',
    name: 'Sales orders',
    description: 'Turn accepted quotes into orders, track status from confirmation to completion, and plan payment milestones (advance, before dispatch, after installation).',
    objects: [{ key: 'sales_order', label: 'Sales Order', plural: 'Sales Orders', icon: 'shopping-cart' }],
    requires: [],
  },
  inventory: {
    key: 'inventory',
    name: 'Inventory',
    description: 'Warehouses, stock in / out / adjust / transfer, reservations against orders, product categories and variants, and reorder alerts.',
    objects: [],
    requires: [],
    roles: [
      {
        key: 'inventory_manager',
        name: 'Inventory Manager',
        description: 'Products, stock, warehouses and goods receipts',
        permissions: { objects: { expense: ownExpense, '*': readOnly, product: all, purchase_order: all, vendor: all, sales_order: readOnly }, admin: ['operations'] },
      },
    ],
  },
  purchasing: {
    key: 'purchasing',
    name: 'Vendors & purchasing',
    description: 'Vendor master with documents and performance, purchase orders with approval, and goods receipts that bring stock in.',
    objects: [
      { key: 'vendor', label: 'Vendor', plural: 'Vendors', icon: 'truck' },
      { key: 'purchase_order', label: 'Purchase Order', plural: 'Purchase Orders', icon: 'clipboard' },
    ],
    requires: [],
    roles: [
      {
        key: 'operations',
        name: 'Operations',
        description: 'Orders, purchasing, deliveries and installations',
        permissions: { objects: { expense: ownExpense, '*': readOnly, sales_order: all, purchase_order: all, vendor: all, product: all, shipment: all, installation: all, lead: none }, admin: ['operations'] },
      },
    ],
  },
  delivery: {
    key: 'delivery',
    name: 'Delivery & installation',
    description: 'Plan dispatches against orders, track vehicles and delivery proof, schedule technicians for installation with checklists, and collect customer sign-off by link.',
    objects: [
      { key: 'shipment', label: 'Delivery', plural: 'Deliveries', icon: 'truck' },
      { key: 'installation', label: 'Installation', plural: 'Installations', icon: 'tool' },
    ],
    requires: ['orders'],
    roles: [
      {
        key: 'technician',
        name: 'Technician',
        description: 'Own installation jobs and deliveries; read customers and orders',
        permissions: { objects: { expense: ownExpense, '*': none, installation: { read: 'own', create: false, update: 'own', delete: 'none' }, shipment: { read: 'own', create: false, update: 'own', delete: 'none' }, account: readOnly, contact: readOnly, sales_order: readOnly, product: readOnly, ticket: { read: 'own', create: true, update: 'own', delete: 'none' } } },
      },
    ],
  },
  service: {
    key: 'service',
    name: 'Service & complaints',
    description: 'Complaint tickets from phone, WhatsApp, web forms or walk-ins, with categories, priorities, SLA timers, escalation on breach, and a status link for the customer.',
    objects: [{ key: 'ticket', label: 'Ticket', plural: 'Tickets', icon: 'life-buoy' }],
    requires: [],
    roles: [
      {
        key: 'service_agent',
        name: 'Service Agent',
        description: 'Tickets end to end; read customers, orders and products',
        permissions: { objects: { expense: ownExpense, '*': readOnly, ticket: all, lead: none, deal: none, quote: none } },
      },
    ],
  },
  billing: {
    key: 'billing',
    name: 'GST billing',
    description: 'Tax invoices and credit notes with FY-wise numbering, CGST/SGST or IGST by place of supply, milestone invoicing from orders, payments and receivables, plus e-invoice JSON, GSTR-1 and Tally exports.',
    objects: [
      { key: 'invoice', label: 'Invoice', plural: 'Invoices', icon: 'receipt' },
      { key: 'payment', label: 'Payment', plural: 'Payments', icon: 'wallet' },
    ],
    requires: [],
    roles: [
      {
        key: 'accounts',
        name: 'Accounts',
        description: 'Invoices, credit notes, payments and GST exports',
        permissions: { objects: { '*': readOnly, invoice: { ...all, delete: 'all' }, payment: all, expense: readOnly, account: { read: 'all', create: true, update: 'all', delete: 'none' }, lead: none, deal: readOnly }, admin: ['billing'] },
      },
    ],
  },
  books: {
    key: 'books',
    name: 'Books (accounting)',
    description: 'Full double-entry accounting: chart of accounts and journals posted automatically from invoices, payments, bills and expenses; vendor bills, credits and payments with TDS; expenses and employee claims; banking with statement import, rules and reconciliation; recurring transactions, budgets, fixed assets and depreciation; trial balance, P&L, balance sheet, cash flow, GSTR-3B, GSTR-2B matching and TDS reports. Choose SanchalanOS or Tally as the books of record.',
    objects: [
      { key: 'bill', label: 'Bill', plural: 'Bills', icon: 'file-text' },
      { key: 'vendor_payment', label: 'Vendor Payment', plural: 'Vendor Payments', icon: 'send' },
      { key: 'expense', label: 'Expense', plural: 'Expenses', icon: 'credit-card' },
    ],
    requires: ['billing', 'purchasing'],
    roles: [
      {
        key: 'accountant',
        name: 'Accountant',
        description: 'Books, bills, expenses, banking, journals and financial reports',
        permissions: { objects: { '*': readOnly, invoice: { ...all, delete: 'all' }, payment: all, bill: { ...all, delete: 'all' }, vendor_payment: all, expense: all, vendor: all, account: all, lead: none, deal: readOnly }, admin: ['billing', 'books'] },
      },
      {
        key: 'chartered_accountant',
        name: 'Chartered accountant (CA)',
        description: 'Your CA: the compliance calendar and filings, financial statements, GST and TDS returns and the audit trail; read-only access to invoices, bills and payments',
        permissions: { objects: { '*': none, invoice: readOnly, payment: readOnly, bill: readOnly, vendor_payment: readOnly, expense: readOnly, vendor: readOnly, account: readOnly }, admin: ['compliance'] },
      },
    ],
  },
  manufacturing: {
    key: 'manufacturing',
    name: 'Manufacturing',
    description: 'Multi-level bills of materials with routings, work centres and by-products; work orders with material issue, operations, output, scrap and batch / lot numbers with expiry; job work under GST challans with ITC-04; quality checks; MRP that turns sales orders and stock levels into purchase and production suggestions; production costing posted to the books.',
    objects: [
      { key: 'work_order', label: 'Work Order', plural: 'Work Orders', icon: 'tool' },
      { key: 'job_work', label: 'Job Work', plural: 'Job Work', icon: 'repeat' },
    ],
    requires: ['inventory', 'purchasing'],
    roles: [
      {
        key: 'production_manager',
        name: 'Production manager',
        description: 'Bills of materials, work orders, job work, quality, MRP and stock',
        permissions: { objects: { expense: ownExpense, '*': readOnly, work_order: { ...all, delete: 'all' }, job_work: { ...all, delete: 'all' }, product: all, purchase_order: all, vendor: readOnly, lead: none }, admin: ['manufacturing', 'operations'] },
      },
      {
        key: 'shop_floor',
        name: 'Shop floor',
        description: 'Works on released work orders: issues material, records operations and output',
        permissions: { objects: { expense: ownExpense, '*': none, work_order: { read: 'all', create: false, update: 'all', delete: 'none' }, product: readOnly } },
      },
    ],
  },
  projects: {
    key: 'projects',
    name: 'Projects and timesheets',
    description: 'Projects with milestones, task lists, sub-tasks and dependencies; Kanban and Gantt views; issues; time tracking with timers and weekly timesheets approved by the project manager; billing of time, milestones and expenses to GST invoices; budgets, resource utilisation and project profitability.',
    objects: [{ key: 'project', label: 'Project', plural: 'Projects', icon: 'briefcase' }],
    requires: [],
    roles: [
      {
        key: 'project_manager',
        name: 'Project manager',
        description: 'Runs projects: plans tasks, approves timesheets, bills time and sees project profitability',
        permissions: { objects: { expense: ownExpense, '*': none, project: { read: 'own', create: true, update: 'own', delete: 'own' } } },
      },
      {
        key: 'project_member',
        name: 'Project team member',
        description: 'Works only on the projects they are added to: their tasks and work items, time, calls and documents. No CRM, sales, billing or books.',
        permissions: { objects: { expense: ownExpense, '*': none } },
      },
    ],
  },
};

export const APP_KEYS = Object.keys(APPS);
export const appModuleKey = (k: string) => `app.${k}`;

/** Objects that belong to an app (so screens can tell whether it is switched on). */
export function appOfObject(objectKey: string): string | null {
  for (const a of Object.values(APPS)) if (a.objects.some((o) => o.key === objectKey)) return a.key;
  return null;
}
