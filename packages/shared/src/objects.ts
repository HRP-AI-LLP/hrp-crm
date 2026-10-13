import type { FieldDef } from './fields';

export const STANDARD_OBJECT_KEYS = ['lead', 'contact', 'account', 'deal', 'product', 'quote'] as const;
export type StandardObjectKey = (typeof STANDARD_OBJECT_KEYS)[number];

export interface ObjectStorage {
  /** physical table */
  table: string;
  /** column holding the record title */
  titleColumn: string;
  /** columns searched by the quick search box (trigram indexed) */
  searchColumns: string[];
  /** object participates in pipelines (has pipeline_id / stage_id) */
  hasPipeline: boolean;
  /** custom-object rows live in `records` and are discriminated by object_key */
  discriminated: boolean;
}

const LEAD_SOURCES = ['website', 'referral', 'campaign', 'event', 'cold_call', 'whatsapp', 'partner', 'other'];
const INDUSTRIES = ['technology', 'finance', 'healthcare', 'real_estate', 'retail', 'manufacturing', 'education', 'services', 'other'];
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'omitted'] as const;
const choices = (vals: readonly string[]) => vals.map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }));

const owner: FieldDef = { key: 'owner_id', label: 'Owner', type: 'user', standard: true, indexed: true };
const pipelineFields: FieldDef[] = [
  { key: 'pipeline_id', label: 'Pipeline', type: 'lookup', standard: true, options: { lookupObject: 'pipeline' } },
  { key: 'stage_id', label: 'Stage', type: 'lookup', standard: true, indexed: true, options: { lookupObject: 'stage' } },
];

export const STANDARD_FIELDS: Record<StandardObjectKey, FieldDef[]> = {
  lead: [
    { key: 'first_name', label: 'First name', type: 'text', standard: true, pii: true },
    { key: 'last_name', label: 'Last name', type: 'text', standard: true, required: true, pii: true },
    { key: 'full_name', label: 'Name', type: 'text', standard: true, readOnly: true, pii: true },
    { key: 'company', label: 'Company', type: 'text', standard: true },
    { key: 'email', label: 'Email', type: 'email', standard: true, pii: true, indexed: true },
    { key: 'phone', label: 'Phone', type: 'phone', standard: true, pii: true },
    { key: 'source', label: 'Source', type: 'picklist', standard: true, options: { choices: choices(LEAD_SOURCES) } },
    ...pipelineFields,
    { key: 'ai_score', label: 'AI score', type: 'number', standard: true, readOnly: true },
    { key: 'sentiment', label: 'Sentiment', type: 'text', standard: true, readOnly: true },
    { key: 'converted_at', label: 'Converted at', type: 'datetime', standard: true, readOnly: true },
    owner,
  ],
  contact: [
    { key: 'first_name', label: 'First name', type: 'text', standard: true, pii: true },
    { key: 'last_name', label: 'Last name', type: 'text', standard: true, required: true, pii: true },
    { key: 'full_name', label: 'Name', type: 'text', standard: true, readOnly: true, pii: true },
    { key: 'email', label: 'Email', type: 'email', standard: true, pii: true, indexed: true },
    { key: 'phone', label: 'Phone', type: 'phone', standard: true, pii: true },
    { key: 'title', label: 'Job title', type: 'text', standard: true },
    { key: 'account_id', label: 'Account', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    owner,
  ],
  account: [
    { key: 'name', label: 'Account name', type: 'text', standard: true, required: true },
    { key: 'domain', label: 'Domain', type: 'text', standard: true },
    { key: 'industry', label: 'Industry', type: 'picklist', standard: true, options: { choices: choices(INDUSTRIES) } },
    { key: 'phone', label: 'Phone', type: 'phone', standard: true },
    { key: 'website', label: 'Website', type: 'url', standard: true },
    { key: 'annual_revenue', label: 'Annual revenue', type: 'currency', standard: true },
    { key: 'employees', label: 'Employees', type: 'number', standard: true, options: { min: 0 } },
    owner,
  ],
  deal: [
    { key: 'name', label: 'Deal name', type: 'text', standard: true, required: true },
    { key: 'account_id', label: 'Account', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'contact_id', label: 'Contact', type: 'lookup', standard: true, options: { lookupObject: 'contact' } },
    ...pipelineFields,
    { key: 'amount', label: 'Amount', type: 'currency', standard: true, options: { min: 0 } },
    { key: 'currency', label: 'Currency', type: 'text', standard: true, options: { maxLength: 3 } },
    { key: 'close_date', label: 'Close date', type: 'date', standard: true },
    { key: 'probability', label: 'Probability %', type: 'percent', standard: true },
    { key: 'closed_at', label: 'Closed at', type: 'datetime', standard: true, readOnly: true },
    { key: 'forecast_category', label: 'Forecast category', type: 'picklist', standard: true, helpText: 'Leave empty to follow the stage probability', options: { choices: choices(FORECAST_CATEGORIES) } },
    owner,
  ],
  product: [
    { key: 'name', label: 'Product name', type: 'text', standard: true, required: true },
    { key: 'sku', label: 'SKU / code', type: 'text', standard: true },
    { key: 'family', label: 'Product family', type: 'text', standard: true },
    { key: 'list_price', label: 'List price', type: 'currency', standard: true, options: { min: 0 } },
    { key: 'unit', label: 'Unit', type: 'text', standard: true, helpText: 'e.g. Nos, Sq.ft, Hours, Licence' },
    { key: 'tax_rate', label: 'GST %', type: 'percent', standard: true },
    { key: 'hsn_sac', label: 'HSN / SAC code', type: 'text', standard: true },
    { key: 'description', label: 'Description', type: 'textarea', standard: true },
    { key: 'is_active', label: 'Active', type: 'boolean', standard: true },
    owner,
  ],
  quote: [
    { key: 'name', label: 'Quote name', type: 'text', standard: true, required: true },
    { key: 'quote_number', label: 'Quote #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, indexed: true, options: { choices: choices(QUOTE_STATUSES) } },
    { key: 'deal_id', label: 'Deal', type: 'lookup', standard: true, options: { lookupObject: 'deal' } },
    { key: 'account_id', label: 'Account', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'contact_id', label: 'Contact', type: 'lookup', standard: true, options: { lookupObject: 'contact' } },
    { key: 'valid_until', label: 'Valid until', type: 'date', standard: true },
    { key: 'currency', label: 'Currency', type: 'text', standard: true, options: { maxLength: 3 } },
    { key: 'subtotal', label: 'Subtotal', type: 'currency', standard: true, readOnly: true },
    { key: 'discount_total', label: 'Discount', type: 'currency', standard: true, readOnly: true },
    { key: 'tax_total', label: 'Tax', type: 'currency', standard: true, readOnly: true },
    { key: 'grand_total', label: 'Grand total', type: 'currency', standard: true, readOnly: true },
    { key: 'terms', label: 'Terms & conditions', type: 'textarea', standard: true },
    { key: 'notes', label: 'Notes for the customer', type: 'textarea', standard: true },
    { key: 'accepted_at', label: 'Accepted at', type: 'datetime', standard: true, readOnly: true },
    { key: 'accepted_by', label: 'Accepted by', type: 'text', standard: true, readOnly: true },
    owner,
  ],
};

/** Standard fields every custom object gets (stored in the generic `records` table). */
export const CUSTOM_OBJECT_BASE_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', standard: true, required: true },
  ...pipelineFields,
  owner,
];

/** Columns the API manages; never writable by clients. */
export const SYSTEM_COLUMNS = ['id', 'tenant_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at', 'version', 'custom', 'object_key'] as const;

export const RESERVED_FIELD_KEYS = new Set<string>([
  ...SYSTEM_COLUMNS,
  ...Object.values(STANDARD_FIELDS).flat().map((f) => f.key),
  ...CUSTOM_OBJECT_BASE_FIELDS.map((f) => f.key),
  'tenant', 'owner', 'object', 'stage', 'pipeline',
]);

export function storageFor(objectKey: string): ObjectStorage {
  switch (objectKey) {
    case 'lead':
      return { table: 'leads', titleColumn: 'full_name', searchColumns: ['full_name', 'email', 'company'], hasPipeline: true, discriminated: false };
    case 'contact':
      return { table: 'contacts', titleColumn: 'full_name', searchColumns: ['full_name', 'email'], hasPipeline: false, discriminated: false };
    case 'account':
      return { table: 'accounts', titleColumn: 'name', searchColumns: ['name', 'domain'], hasPipeline: false, discriminated: false };
    case 'deal':
      return { table: 'deals', titleColumn: 'name', searchColumns: ['name'], hasPipeline: true, discriminated: false };
    case 'product':
      return { table: 'products', titleColumn: 'name', searchColumns: ['name', 'sku'], hasPipeline: false, discriminated: false };
    case 'quote':
      return { table: 'quotes', titleColumn: 'name', searchColumns: ['name', 'quote_number'], hasPipeline: false, discriminated: false };
    default:
      return { table: 'records', titleColumn: 'name', searchColumns: ['name'], hasPipeline: true, discriminated: true };
  }
}

export function isStandardObject(key: string): key is StandardObjectKey {
  return (STANDARD_OBJECT_KEYS as readonly string[]).includes(key);
}

export function standardFieldsFor(objectKey: string): FieldDef[] {
  return isStandardObject(objectKey) ? STANDARD_FIELDS[objectKey] : CUSTOM_OBJECT_BASE_FIELDS;
}
