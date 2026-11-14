/**
 * Books (accounting) reference data shared by the API and the app.
 */
export interface TdsSection {
  section: string;
  label: string;
  /** default rate % (companies / firms; individuals may differ) */
  rate: number;
  threshold: string;
}

/** Common TDS sections for payments to vendors (rates as notified for FY 2025-26; check before use). */
export const TDS_SECTIONS: TdsSection[] = [
  { section: '194C', label: 'Contractors and job work', rate: 2, threshold: '₹30,000 per bill or ₹1,00,000 a year (1% for individuals / HUF)' },
  { section: '194J(b)', label: 'Professional fees', rate: 10, threshold: '₹50,000 a year' },
  { section: '194J(a)', label: 'Technical services, royalty for films', rate: 2, threshold: '₹50,000 a year' },
  { section: '194H', label: 'Commission and brokerage', rate: 2, threshold: '₹20,000 a year' },
  { section: '194I(a)', label: 'Rent of plant and machinery', rate: 2, threshold: '₹50,000 a month' },
  { section: '194I(b)', label: 'Rent of land, building, furniture', rate: 10, threshold: '₹50,000 a month' },
  { section: '194Q', label: 'Purchase of goods', rate: 0.1, threshold: 'Above ₹50 lakh a year (buyer turnover above ₹10 crore)' },
  { section: '194A', label: 'Interest (other than securities)', rate: 10, threshold: '₹10,000 a year' },
  { section: '194O', label: 'E-commerce operators', rate: 0.1, threshold: '₹5,00,000 a year (individuals / HUF)' },
  { section: '194M', label: 'Contract work / commission by individuals', rate: 2, threshold: '₹50 lakh a year' },
];

export const GL_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountTypeKey = (typeof GL_ACCOUNT_TYPES)[number];

/** Sub-types per type, with labels (they decide report grouping). */
export const ACCOUNT_SUBTYPES: Record<AccountTypeKey, [string, string][]> = {
  asset: [
    ['cash', 'Cash'],
    ['bank', 'Bank'],
    ['accounts_receivable', 'Accounts receivable'],
    ['inventory', 'Inventory'],
    ['current_asset', 'Other current asset'],
    ['tax_receivable', 'Tax receivable'],
    ['fixed_asset', 'Fixed asset'],
    ['accumulated_depreciation', 'Accumulated depreciation'],
    ['other_asset', 'Other asset'],
  ],
  liability: [
    ['accounts_payable', 'Accounts payable'],
    ['credit_card', 'Credit card'],
    ['current_liability', 'Other current liability'],
    ['tax_payable', 'Tax payable'],
    ['long_term_liability', 'Long-term liability'],
    ['other_liability', 'Other liability'],
  ],
  equity: [
    ['equity', 'Equity'],
    ['retained_earnings', 'Retained earnings'],
  ],
  income: [
    ['income', 'Income'],
    ['other_income', 'Other income'],
  ],
  expense: [
    ['cost_of_goods_sold', 'Cost of goods sold'],
    ['expense', 'Expense'],
    ['other_expense', 'Other expense'],
  ],
};

export const SUBTYPE_LABEL: Record<string, string> = Object.fromEntries(Object.values(ACCOUNT_SUBTYPES).flat());
