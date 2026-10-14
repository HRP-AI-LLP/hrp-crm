import type { FieldDef } from './fields';

export const STANDARD_OBJECT_KEYS = ['lead', 'contact', 'account', 'deal', 'product', 'quote', 'sales_order', 'vendor', 'purchase_order', 'shipment', 'installation', 'ticket', 'invoice', 'payment'] as const;
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

export const LEAD_SOURCES = ['website', 'whatsapp', 'instagram', 'facebook', 'google_ads', 'phone_call', 'walk_in', 'referral', 'architect', 'interior_designer', 'dealer', 'campaign', 'event', 'cold_call', 'partner', 'manual', 'other'];
export const ACCOUNT_TYPES = ['customer', 'prospect', 'architect', 'interior_designer', 'dealer', 'builder', 'partner', 'other'];
export const APPROVAL_STATUSES = ['not_required', 'required', 'pending', 'approved', 'rejected'] as const;
const INDUSTRIES = ['technology', 'finance', 'healthcare', 'real_estate', 'retail', 'manufacturing', 'education', 'services', 'other'];
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded'] as const;
export const FORECAST_CATEGORIES = ['pipeline', 'best_case', 'commit', 'omitted'] as const;
export const ORDER_STATUSES = ['draft', 'confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed', 'completed', 'cancelled'] as const;
export const PO_STATUSES = ['draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export const SHIPMENT_STATUSES = ['planned', 'packed', 'dispatched', 'delivered', 'failed', 'cancelled'] as const;
export const INSTALLATION_STATUSES = ['scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const;
export const TICKET_STATUSES = ['new', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_CATEGORIES = ['damage', 'defect', 'installation', 'delivery', 'warranty', 'billing', 'feedback', 'other'] as const;
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const;
export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'] as const;
export const VENDOR_TYPES = ['manufacturer', 'supplier', 'contractor', 'transporter', 'installer', 'service_provider', 'other'] as const;
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
    { key: 'source', label: 'Source', type: 'picklist', standard: true, indexed: true, options: { choices: choices(LEAD_SOURCES) } },
    { key: 'source_detail', label: 'Source detail', type: 'text', standard: true, helpText: 'Campaign name, referrer, showroom…' },
    { key: 'referred_by_id', label: 'Referred by (architect / dealer)', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    ...pipelineFields,
    { key: 'next_follow_up_at', label: 'Next follow-up', type: 'datetime', standard: true, helpText: 'The owner gets a reminder at this time' },
    { key: 'score', label: 'Score', type: 'number', standard: true, readOnly: true, helpText: 'From the scoring rules in Settings' },
    { key: 'rating', label: 'Rating', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['hot', 'warm', 'cold']) } },
    { key: 'last_activity_at', label: 'Last activity', type: 'datetime', standard: true, readOnly: true },
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
    { key: 'account_type', label: 'Type', type: 'picklist', standard: true, options: { choices: choices(ACCOUNT_TYPES) } },
    { key: 'industry', label: 'Industry', type: 'picklist', standard: true, options: { choices: choices(INDUSTRIES) } },
    { key: 'phone', label: 'Phone', type: 'phone', standard: true },
    { key: 'website', label: 'Website', type: 'url', standard: true },
    { key: 'annual_revenue', label: 'Annual revenue', type: 'currency', standard: true },
    { key: 'employees', label: 'Employees', type: 'number', standard: true, options: { min: 0 } },
    { key: 'gstin', label: 'GSTIN', type: 'text', standard: true, options: { maxLength: 15 }, helpText: '15-character GST number (printed on invoices)' },
    { key: 'address', label: 'Address', type: 'textarea', standard: true },
    { key: 'city', label: 'City', type: 'text', standard: true },
    { key: 'state', label: 'State', type: 'text', standard: true, helpText: 'Decides CGST + SGST (same state) or IGST' },
    { key: 'pincode', label: 'PIN code', type: 'text', standard: true },
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
    { key: 'referred_by_id', label: 'Referred by (architect / dealer)', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'last_activity_at', label: 'Last activity', type: 'datetime', standard: true, readOnly: true },
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
    { key: 'category_id', label: 'Category', type: 'picklist', standard: true, indexed: true, options: { choices: [] }, helpText: 'Manage categories under Inventory' },
    { key: 'product_type', label: 'Type', type: 'picklist', standard: true, options: { choices: choices(['goods', 'service']) } },
    { key: 'variant_of', label: 'Variant of', type: 'lookup', standard: true, options: { lookupObject: 'product' } },
    { key: 'variant_options', label: 'Variant', type: 'text', standard: true, helpText: 'e.g. Teak / 3-seater' },
    { key: 'track_inventory', label: 'Track stock', type: 'boolean', standard: true },
    { key: 'reorder_level', label: 'Reorder level', type: 'number', standard: true, options: { min: 0 }, helpText: 'Alert when available stock falls to this' },
    { key: 'reorder_qty', label: 'Reorder quantity', type: 'number', standard: true, options: { min: 0 } },
    { key: 'cost_price', label: 'Cost price', type: 'currency', standard: true, options: { min: 0 } },
    { key: 'mrp', label: 'MRP', type: 'currency', standard: true, options: { min: 0 } },
    { key: 'barcode', label: 'Barcode', type: 'text', standard: true },
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
    { key: 'revision', label: 'Revision', type: 'number', standard: true, readOnly: true },
    { key: 'max_discount_pct', label: 'Highest line discount %', type: 'percent', standard: true, readOnly: true },
    { key: 'approval_status', label: 'Approval', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(APPROVAL_STATUSES) } },
    { key: 'accepted_at', label: 'Accepted at', type: 'datetime', standard: true, readOnly: true },
    { key: 'accepted_by', label: 'Accepted by', type: 'text', standard: true, readOnly: true },
    owner,
  ],
  sales_order: [
    { key: 'name', label: 'Order name', type: 'text', standard: true, required: true },
    { key: 'order_number', label: 'Order #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, indexed: true, options: { choices: choices(ORDER_STATUSES) } },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'contact_id', label: 'Contact', type: 'lookup', standard: true, options: { lookupObject: 'contact' } },
    { key: 'deal_id', label: 'Deal', type: 'lookup', standard: true, options: { lookupObject: 'deal' } },
    { key: 'quote_id', label: 'From quote', type: 'lookup', standard: true, readOnly: true, options: { lookupObject: 'quote' } },
    { key: 'order_date', label: 'Order date', type: 'date', standard: true },
    { key: 'expected_delivery_date', label: 'Expected delivery', type: 'date', standard: true },
    { key: 'warehouse_id', label: 'Ship from', type: 'picklist', standard: true, options: { choices: [] } },
    { key: 'site_address', label: 'Delivery / site address', type: 'textarea', standard: true },
    { key: 'delivery_required', label: 'Needs delivery', type: 'boolean', standard: true },
    { key: 'installation_required', label: 'Needs installation', type: 'boolean', standard: true },
    { key: 'fulfilment_status', label: 'Fulfilment', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['unfulfilled', 'partially_delivered', 'delivered']) } },
    { key: 'payment_status', label: 'Payment', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['unpaid', 'partially_paid', 'paid']) } },
    { key: 'currency', label: 'Currency', type: 'text', standard: true, options: { maxLength: 3 } },
    { key: 'subtotal', label: 'Subtotal', type: 'currency', standard: true, readOnly: true },
    { key: 'discount_total', label: 'Discount', type: 'currency', standard: true, readOnly: true },
    { key: 'tax_total', label: 'Tax', type: 'currency', standard: true, readOnly: true },
    { key: 'grand_total', label: 'Order total', type: 'currency', standard: true, readOnly: true },
    { key: 'amount_paid', label: 'Paid', type: 'currency', standard: true, readOnly: true },
    { key: 'balance_due', label: 'Balance due', type: 'currency', standard: true, readOnly: true },
    { key: 'max_discount_pct', label: 'Highest line discount %', type: 'percent', standard: true, readOnly: true },
    { key: 'approval_status', label: 'Approval', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(APPROVAL_STATUSES) } },
    { key: 'terms', label: 'Terms', type: 'textarea', standard: true },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
    { key: 'confirmed_at', label: 'Confirmed at', type: 'datetime', standard: true, readOnly: true },
    owner,
  ],
  vendor: [
    { key: 'name', label: 'Vendor name', type: 'text', standard: true, required: true },
    { key: 'vendor_code', label: 'Vendor code', type: 'text', standard: true },
    { key: 'vendor_type', label: 'Type', type: 'picklist', standard: true, indexed: true, options: { choices: choices(VENDOR_TYPES) } },
    { key: 'category', label: 'Supplies', type: 'text', standard: true, helpText: 'e.g. Fabric, Plywood, Hardware, Transport' },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, options: { choices: choices(['active', 'on_hold', 'blocked']) } },
    { key: 'contact_person', label: 'Contact person', type: 'text', standard: true },
    { key: 'email', label: 'Email', type: 'email', standard: true },
    { key: 'phone', label: 'Phone', type: 'phone', standard: true },
    { key: 'gstin', label: 'GSTIN', type: 'text', standard: true, options: { maxLength: 15 } },
    { key: 'pan', label: 'PAN', type: 'text', standard: true, options: { maxLength: 10 } },
    { key: 'address', label: 'Address', type: 'textarea', standard: true },
    { key: 'city', label: 'City', type: 'text', standard: true },
    { key: 'state', label: 'State', type: 'text', standard: true },
    { key: 'payment_terms_days', label: 'Payment terms (days)', type: 'number', standard: true, options: { min: 0, max: 365 } },
    { key: 'lead_time_days', label: 'Usual lead time (days)', type: 'number', standard: true, options: { min: 0, max: 365 } },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
    owner,
  ],
  purchase_order: [
    { key: 'name', label: 'PO name', type: 'text', standard: true, required: true },
    { key: 'po_number', label: 'PO #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, indexed: true, options: { choices: choices(PO_STATUSES) } },
    { key: 'vendor_id', label: 'Vendor', type: 'lookup', standard: true, required: true, options: { lookupObject: 'vendor' } },
    { key: 'sales_order_id', label: 'For sales order', type: 'lookup', standard: true, options: { lookupObject: 'sales_order' } },
    { key: 'warehouse_id', label: 'Deliver to', type: 'picklist', standard: true, options: { choices: [] } },
    { key: 'order_date', label: 'PO date', type: 'date', standard: true },
    { key: 'expected_date', label: 'Expected by', type: 'date', standard: true },
    { key: 'currency', label: 'Currency', type: 'text', standard: true, options: { maxLength: 3 } },
    { key: 'subtotal', label: 'Subtotal', type: 'currency', standard: true, readOnly: true },
    { key: 'discount_total', label: 'Discount', type: 'currency', standard: true, readOnly: true },
    { key: 'tax_total', label: 'Tax', type: 'currency', standard: true, readOnly: true },
    { key: 'grand_total', label: 'PO total', type: 'currency', standard: true, readOnly: true },
    { key: 'max_discount_pct', label: 'Highest line discount %', type: 'percent', standard: true, readOnly: true },
    { key: 'approval_status', label: 'Approval', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(APPROVAL_STATUSES) } },
    { key: 'terms', label: 'Terms', type: 'textarea', standard: true },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
    { key: 'sent_at', label: 'Sent at', type: 'datetime', standard: true, readOnly: true },
    { key: 'received_at', label: 'Fully received at', type: 'datetime', standard: true, readOnly: true },
    owner,
  ],
  shipment: [
    { key: 'name', label: 'Shipment', type: 'text', standard: true, required: true },
    { key: 'shipment_number', label: 'Delivery #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, indexed: true, options: { choices: choices(SHIPMENT_STATUSES) } },
    { key: 'sales_order_id', label: 'Sales order', type: 'lookup', standard: true, readOnly: true, options: { lookupObject: 'sales_order' } },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'planned_date', label: 'Planned date', type: 'date', standard: true, indexed: true },
    { key: 'warehouse_id', label: 'Ship from', type: 'picklist', standard: true, options: { choices: [] } },
    { key: 'delivery_address', label: 'Delivery address', type: 'textarea', standard: true },
    { key: 'contact_phone', label: 'Site contact phone', type: 'phone', standard: true },
    { key: 'carrier', label: 'Carrier / transporter', type: 'text', standard: true },
    { key: 'vehicle_no', label: 'Vehicle no.', type: 'text', standard: true },
    { key: 'driver_name', label: 'Driver', type: 'text', standard: true },
    { key: 'driver_phone', label: 'Driver phone', type: 'phone', standard: true },
    { key: 'tracking_ref', label: 'Tracking / LR no.', type: 'text', standard: true },
    { key: 'dispatched_at', label: 'Dispatched at', type: 'datetime', standard: true, readOnly: true },
    { key: 'delivered_at', label: 'Delivered at', type: 'datetime', standard: true, readOnly: true },
    { key: 'received_by', label: 'Received by', type: 'text', standard: true, readOnly: true },
    { key: 'exception_reason', label: 'Exception', type: 'textarea', standard: true, readOnly: true },
    { key: 'customer_rating', label: 'Customer rating', type: 'number', standard: true, readOnly: true },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
    { ...owner, label: 'Coordinator' },
  ],
  installation: [
    { key: 'name', label: 'Job', type: 'text', standard: true, required: true },
    { key: 'job_number', label: 'Job #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, indexed: true, options: { choices: choices(INSTALLATION_STATUSES) } },
    { key: 'sales_order_id', label: 'Sales order', type: 'lookup', standard: true, options: { lookupObject: 'sales_order' } },
    { key: 'shipment_id', label: 'Delivery', type: 'lookup', standard: true, options: { lookupObject: 'shipment' } },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'scheduled_start', label: 'Starts', type: 'datetime', standard: true, indexed: true },
    { key: 'scheduled_end', label: 'Ends', type: 'datetime', standard: true },
    { key: 'site_address', label: 'Site address', type: 'textarea', standard: true },
    { key: 'contact_phone', label: 'Site contact phone', type: 'phone', standard: true },
    { key: 'started_at', label: 'Started at', type: 'datetime', standard: true, readOnly: true },
    { key: 'completed_at', label: 'Completed at', type: 'datetime', standard: true, readOnly: true },
    { key: 'completion_notes', label: 'Completion notes', type: 'textarea', standard: true, readOnly: true },
    { key: 'issue_type', label: 'Exception', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['site_not_ready', 'customer_unavailable', 'missing_parts', 'damaged_item', 'measurement_mismatch', 'other']) } },
    { key: 'issue_notes', label: 'Exception notes', type: 'textarea', standard: true, readOnly: true },
    { key: 'customer_rating', label: 'Customer rating', type: 'number', standard: true, readOnly: true },
    { ...owner, label: 'Technician' },
  ],
  ticket: [
    { key: 'name', label: 'Subject', type: 'text', standard: true, required: true },
    { key: 'ticket_number', label: 'Ticket #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, indexed: true, options: { choices: choices(TICKET_STATUSES) } },
    { key: 'priority', label: 'Priority', type: 'picklist', standard: true, indexed: true, options: { choices: choices(TICKET_PRIORITIES) } },
    { key: 'category', label: 'Category', type: 'picklist', standard: true, indexed: true, options: { choices: choices(TICKET_CATEGORIES) } },
    { key: 'channel', label: 'Channel', type: 'picklist', standard: true, options: { choices: choices(['phone', 'email', 'whatsapp', 'instagram', 'web', 'walk_in', 'internal']) } },
    { key: 'description', label: 'Description', type: 'textarea', standard: true },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'contact_id', label: 'Contact', type: 'lookup', standard: true, options: { lookupObject: 'contact' } },
    { key: 'sales_order_id', label: 'Sales order', type: 'lookup', standard: true, options: { lookupObject: 'sales_order' } },
    { key: 'product_id', label: 'Product', type: 'lookup', standard: true, options: { lookupObject: 'product' } },
    { key: 'customer_name', label: 'Reported by', type: 'text', standard: true },
    { key: 'customer_phone', label: 'Reporter phone', type: 'phone', standard: true },
    { key: 'customer_email', label: 'Reporter email', type: 'email', standard: true },
    { key: 'resolution', label: 'Resolution', type: 'textarea', standard: true },
    { key: 'first_response_due', label: 'First response due', type: 'datetime', standard: true, readOnly: true },
    { key: 'resolution_due', label: 'Resolve by', type: 'datetime', standard: true, readOnly: true, indexed: true },
    { key: 'first_responded_at', label: 'First response', type: 'datetime', standard: true, readOnly: true },
    { key: 'resolved_at', label: 'Resolved at', type: 'datetime', standard: true, readOnly: true },
    { key: 'sla_breached', label: 'SLA breached', type: 'boolean', standard: true, readOnly: true },
    { key: 'satisfaction', label: 'Customer satisfaction', type: 'number', standard: true, readOnly: true },
    { ...owner, label: 'Assigned to' },
  ],
  invoice: [
    { key: 'name', label: 'Title', type: 'text', standard: true, required: true },
    { key: 'invoice_number', label: 'Invoice #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'doc_type', label: 'Type', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['tax_invoice', 'credit_note', 'proforma']) } },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, indexed: true, options: { choices: choices(INVOICE_STATUSES) } },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, options: { lookupObject: 'account' } },
    { key: 'contact_id', label: 'Contact', type: 'lookup', standard: true, options: { lookupObject: 'contact' } },
    { key: 'sales_order_id', label: 'Sales order', type: 'lookup', standard: true, readOnly: true, options: { lookupObject: 'sales_order' } },
    { key: 'original_invoice_id', label: 'Against invoice', type: 'lookup', standard: true, readOnly: true, options: { lookupObject: 'invoice' } },
    { key: 'invoice_date', label: 'Invoice date', type: 'date', standard: true, indexed: true },
    { key: 'due_date', label: 'Due date', type: 'date', standard: true, indexed: true },
    { key: 'place_of_supply', label: 'Place of supply', type: 'text', standard: true, helpText: 'State the goods / services are supplied to; defaults to the customer state' },
    { key: 'shipping_address', label: 'Ship to', type: 'textarea', standard: true },
    { key: 'reverse_charge', label: 'Reverse charge', type: 'boolean', standard: true },
    { key: 'buyer_gstin', label: 'Customer GSTIN', type: 'text', standard: true, readOnly: true },
    { key: 'supply_type', label: 'Supply', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['intra', 'inter', 'export']) } },
    { key: 'currency', label: 'Currency', type: 'text', standard: true, options: { maxLength: 3 } },
    { key: 'taxable_total', label: 'Taxable value', type: 'currency', standard: true, readOnly: true },
    { key: 'cgst_total', label: 'CGST', type: 'currency', standard: true, readOnly: true },
    { key: 'sgst_total', label: 'SGST', type: 'currency', standard: true, readOnly: true },
    { key: 'igst_total', label: 'IGST', type: 'currency', standard: true, readOnly: true },
    { key: 'grand_total', label: 'Invoice total', type: 'currency', standard: true, readOnly: true },
    { key: 'amount_paid', label: 'Paid', type: 'currency', standard: true, readOnly: true },
    { key: 'amount_credited', label: 'Credited', type: 'currency', standard: true, readOnly: true },
    { key: 'balance_due', label: 'Balance due', type: 'currency', standard: true, readOnly: true, indexed: true },
    { key: 'max_discount_pct', label: 'Highest line discount %', type: 'percent', standard: true, readOnly: true },
    { key: 'approval_status', label: 'Approval', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(APPROVAL_STATUSES) } },
    { key: 'irn', label: 'IRN (e-invoice)', type: 'text', standard: true, readOnly: true },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
    { key: 'terms', label: 'Terms', type: 'textarea', standard: true },
    owner,
  ],
  payment: [
    { key: 'name', label: 'Payment', type: 'text', standard: true, required: true },
    { key: 'payment_number', label: 'Receipt #', type: 'text', standard: true, readOnly: true, indexed: true },
    { key: 'status', label: 'Status', type: 'picklist', standard: true, readOnly: true, options: { choices: choices(['received', 'void']) } },
    { key: 'account_id', label: 'Customer', type: 'lookup', standard: true, required: true, options: { lookupObject: 'account' } },
    { key: 'sales_order_id', label: 'Sales order', type: 'lookup', standard: true, options: { lookupObject: 'sales_order' } },
    { key: 'payment_date', label: 'Received on', type: 'date', standard: true, indexed: true },
    { key: 'amount', label: 'Amount', type: 'currency', standard: true, required: true, options: { min: 0.01 } },
    { key: 'mode', label: 'Mode', type: 'picklist', standard: true, options: { choices: choices(PAYMENT_MODES) } },
    { key: 'reference', label: 'Reference (UTR / cheque no.)', type: 'text', standard: true },
    { key: 'amount_allocated', label: 'Applied to invoices', type: 'currency', standard: true, readOnly: true },
    { key: 'unallocated', label: 'Unapplied', type: 'currency', standard: true, readOnly: true },
    { key: 'notes', label: 'Notes', type: 'textarea', standard: true },
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

const ALWAYS_RESERVED = [...SYSTEM_COLUMNS, ...CUSTOM_OBJECT_BASE_FIELDS.map((f) => f.key), 'tenant', 'owner', 'object', 'stage', 'pipeline', 'title'];

/** Keys a custom field on this object may not use (its standard fields and system columns). */
export function reservedKeysFor(objectKey: string): Set<string> {
  return new Set<string>([...ALWAYS_RESERVED, ...standardFieldsFor(objectKey).map((f) => f.key)]);
}

const reg = (table: string, titleColumn: string, searchColumns: string[], hasPipeline = false): ObjectStorage => ({ table, titleColumn, searchColumns, hasPipeline, discriminated: false });

/** Physical storage of every standard object (mirrored in SQL by app.object_table()). */
export const OBJECT_STORAGE: Record<string, ObjectStorage> = {
  lead: reg('leads', 'full_name', ['full_name', 'email', 'company'], true),
  contact: reg('contacts', 'full_name', ['full_name', 'email']),
  account: reg('accounts', 'name', ['name', 'domain']),
  deal: reg('deals', 'name', ['name'], true),
  product: reg('products', 'name', ['name', 'sku']),
  quote: reg('quotes', 'name', ['name', 'quote_number']),
  sales_order: reg('sales_orders', 'name', ['name', 'order_number']),
  vendor: reg('vendors', 'name', ['name', 'vendor_code', 'phone']),
  purchase_order: reg('purchase_orders', 'name', ['name', 'po_number']),
  shipment: reg('shipments', 'name', ['name', 'shipment_number', 'tracking_ref']),
  installation: reg('installations', 'name', ['name', 'job_number']),
  ticket: reg('tickets', 'name', ['name', 'ticket_number', 'customer_phone']),
  invoice: reg('invoices', 'name', ['name', 'invoice_number', 'buyer_name']),
  payment: reg('payments', 'name', ['name', 'payment_number', 'reference']),
};

export function storageFor(objectKey: string): ObjectStorage {
  return OBJECT_STORAGE[objectKey] ?? { table: 'records', titleColumn: 'name', searchColumns: ['name'], hasPipeline: true, discriminated: true };
}

export function isStandardObject(key: string): key is StandardObjectKey {
  return (STANDARD_OBJECT_KEYS as readonly string[]).includes(key);
}

export function standardFieldsFor(objectKey: string): FieldDef[] {
  return isStandardObject(objectKey) ? STANDARD_FIELDS[objectKey] : CUSTOM_OBJECT_BASE_FIELDS;
}
