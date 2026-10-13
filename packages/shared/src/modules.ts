/**
 * Domain extension modules. A module is a declarative manifest applied to a tenant through the
 * metadata engine: it adds custom objects, extends standard objects with fields, ships pipelines
 * and starter workflows, and gives the AI features domain context. Installing is idempotent;
 * every created artifact is tagged with module_key so it can be upgraded or removed cleanly.
 */
import type { FieldSpec } from './fields';

export interface ModuleObject {
  key: string;
  label: string;
  plural: string;
  icon?: string;
  fields: FieldSpec[];
}

export interface ModulePipeline {
  object: string;
  name: string;
  isDefault?: boolean;
  stages: { key: string; label: string; probability: number; category: 'open' | 'won' | 'lost'; color?: string }[];
}

export interface ModuleWorkflow {
  name: string;
  object: string;
  trigger: 'created' | 'updated' | 'stage_changed';
  conditions: { field: string; op: string; value: unknown }[];
  actions: Record<string, unknown>[];
}

export interface ModuleManifest {
  key: string;
  name: string;
  version: string;
  industry: string;
  description: string;
  objects: ModuleObject[];
  /** extra fields on existing objects (standard or module objects) */
  fields: { object: string; fields: FieldSpec[] }[];
  pipelines: ModulePipeline[];
  workflows: ModuleWorkflow[];
  /** appended to AI system prompts for tenants with this module enabled */
  aiContext: string;
}

const pick = (...vals: string[]) => ({ choices: vals.map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })) });

export const REAL_ESTATE: ModuleManifest = {
  key: 'real_estate',
  name: 'Real Estate',
  version: '1.0.0',
  industry: 'real_estate',
  description: 'Property inventory, site visits, buyer requirements and a property sales pipeline.',
  objects: [
    {
      key: 'property',
      label: 'Property',
      plural: 'Properties',
      icon: 'home',
      fields: [
        { key: 'project_name', label: 'Project', type: 'text', indexed: true },
        { key: 'property_type', label: 'Type', type: 'picklist', indexed: true, options: pick('apartment', 'villa', 'plot', 'commercial', 'office') },
        { key: 'bhk', label: 'BHK', type: 'number', indexed: true, options: { min: 0, max: 20 } },
        { key: 'carpet_area_sqft', label: 'Carpet area (sq ft)', type: 'number', options: { min: 0 } },
        { key: 'price', label: 'Price', type: 'currency', indexed: true, options: { min: 0 } },
        { key: 'locality', label: 'Locality', type: 'text', indexed: true },
        { key: 'city', label: 'City', type: 'text', indexed: true },
        { key: 'rera_id', label: 'RERA registration', type: 'text' },
        { key: 'availability', label: 'Availability', type: 'picklist', indexed: true, options: pick('available', 'on_hold', 'booked', 'sold') },
      ],
    },
    {
      key: 'site_visit',
      label: 'Site Visit',
      plural: 'Site Visits',
      icon: 'map-pin',
      fields: [
        { key: 'lead', label: 'Lead', type: 'lookup', options: { lookupObject: 'lead' } },
        { key: 'property', label: 'Property', type: 'lookup', options: { lookupObject: 'property' } },
        { key: 'visit_at', label: 'Visit time', type: 'datetime', indexed: true, required: true },
        { key: 'outcome', label: 'Outcome', type: 'picklist', options: pick('scheduled', 'completed', 'no_show', 'interested', 'not_interested') },
        { key: 'feedback', label: 'Feedback', type: 'textarea' },
      ],
    },
  ],
  fields: [
    {
      object: 'lead',
      fields: [
        { key: 'budget_min', label: 'Budget min', type: 'currency', indexed: true },
        { key: 'budget_max', label: 'Budget max', type: 'currency', indexed: true },
        { key: 'preferred_locality', label: 'Preferred locality', type: 'text', indexed: true },
        { key: 'bhk_preference', label: 'BHK preference', type: 'multipicklist', options: pick('1', '2', '3', '4', '5_plus') },
        { key: 'purchase_timeline', label: 'Purchase timeline', type: 'picklist', options: pick('immediate', '3_months', '6_months', '12_months', 'exploring') },
        { key: 'home_loan_required', label: 'Home loan required', type: 'boolean' },
      ],
    },
  ],
  pipelines: [
    {
      object: 'deal',
      name: 'Property Sales',
      stages: [
        { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
        { key: 'site_visit', label: 'Site Visit', probability: 30, category: 'open' },
        { key: 'negotiation', label: 'Negotiation', probability: 60, category: 'open' },
        { key: 'token_paid', label: 'Token Paid', probability: 85, category: 'open' },
        { key: 'registered', label: 'Registered', probability: 100, category: 'won' },
        { key: 'dropped', label: 'Dropped', probability: 0, category: 'lost' },
      ],
    },
  ],
  workflows: [
    {
      name: 'Follow up after site visit',
      object: 'site_visit',
      trigger: 'updated',
      conditions: [{ field: 'outcome', op: 'eq', value: 'completed' }],
      actions: [{ type: 'create_task', title: 'Call buyer for site-visit feedback', dueInHours: 24, assignTo: 'owner' }],
    },
  ],
  aiContext:
    'The business is an Indian real-estate brokerage/developer. Buyers are qualified on budget fit, locality preference, purchase timeline, home-loan readiness and site-visit engagement. Prices are in INR; use lakh/crore conventions when summarising.',
};

export const HEALTHCARE: ModuleManifest = {
  key: 'healthcare',
  name: 'Healthcare',
  version: '1.0.0',
  industry: 'healthcare',
  description: 'Patient enquiries, appointments and treatment pipelines. Clinical fields are PII-flagged.',
  objects: [
    {
      key: 'appointment',
      label: 'Appointment',
      plural: 'Appointments',
      icon: 'calendar',
      fields: [
        { key: 'patient', label: 'Patient (contact)', type: 'lookup', options: { lookupObject: 'contact' } },
        { key: 'department', label: 'Department', type: 'picklist', indexed: true, options: pick('general', 'cardiology', 'orthopedics', 'pediatrics', 'dermatology', 'dental', 'other') },
        { key: 'doctor', label: 'Doctor', type: 'text', indexed: true },
        { key: 'scheduled_at', label: 'Scheduled at', type: 'datetime', indexed: true, required: true },
        { key: 'status', label: 'Status', type: 'picklist', indexed: true, options: pick('booked', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show') },
      ],
    },
  ],
  fields: [
    {
      object: 'contact',
      fields: [
        { key: 'date_of_birth', label: 'Date of birth', type: 'date', pii: true },
        { key: 'abha_id', label: 'ABHA ID', type: 'text', pii: true },
        { key: 'insurance_provider', label: 'Insurance provider', type: 'text', pii: true },
      ],
    },
    {
      object: 'lead',
      fields: [
        { key: 'treatment_interest', label: 'Treatment interest', type: 'text', pii: true },
        { key: 'preferred_branch', label: 'Preferred branch', type: 'text', indexed: true },
      ],
    },
  ],
  pipelines: [
    {
      object: 'deal',
      name: 'Treatment Journey',
      stages: [
        { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
        { key: 'consultation', label: 'Consultation', probability: 40, category: 'open' },
        { key: 'estimate_shared', label: 'Estimate Shared', probability: 60, category: 'open' },
        { key: 'admitted', label: 'Admitted / Treated', probability: 100, category: 'won' },
        { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
      ],
    },
  ],
  workflows: [],
  aiContext:
    'The business is a healthcare provider. Treat all patient information as sensitive health data: never infer diagnoses, keep summaries factual, and recommend human follow-up for clinical questions.',
};

export const ECOMMERCE: ModuleManifest = {
  key: 'ecommerce',
  name: 'E-Commerce',
  version: '1.0.0',
  industry: 'retail',
  description: 'Orders, customer lifetime value and B2B/wholesale deal flow.',
  objects: [
    {
      key: 'order',
      label: 'Order',
      plural: 'Orders',
      icon: 'shopping-cart',
      fields: [
        { key: 'customer', label: 'Customer', type: 'lookup', options: { lookupObject: 'contact' } },
        { key: 'order_number', label: 'Order #', type: 'text', indexed: true, required: true },
        { key: 'order_total', label: 'Total', type: 'currency', indexed: true },
        { key: 'order_status', label: 'Status', type: 'picklist', indexed: true, options: pick('pending', 'paid', 'shipped', 'delivered', 'returned', 'cancelled') },
        { key: 'channel', label: 'Channel', type: 'picklist', options: pick('website', 'marketplace', 'whatsapp', 'store') },
        { key: 'ordered_at', label: 'Ordered at', type: 'datetime', indexed: true },
      ],
    },
  ],
  fields: [
    {
      object: 'contact',
      fields: [
        { key: 'lifetime_value', label: 'Lifetime value', type: 'currency', indexed: true },
        { key: 'orders_count', label: 'Orders', type: 'number' },
        { key: 'last_order_at', label: 'Last order', type: 'datetime', indexed: true },
      ],
    },
  ],
  pipelines: [
    {
      object: 'deal',
      name: 'Wholesale / B2B',
      stages: [
        { key: 'inquiry', label: 'Inquiry', probability: 10, category: 'open' },
        { key: 'sample_sent', label: 'Sample Sent', probability: 35, category: 'open' },
        { key: 'quote', label: 'Quote', probability: 60, category: 'open' },
        { key: 'po_received', label: 'PO Received', probability: 100, category: 'won' },
        { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
      ],
    },
  ],
  workflows: [],
  aiContext: 'The business sells products online. Prioritise repeat-purchase signals, cart value and support sentiment.',
};

export const FINANCIAL_SERVICES: ModuleManifest = {
  key: 'financial_services',
  name: 'Financial Services',
  version: '1.0.0',
  industry: 'finance',
  description: 'Loan / policy applications with KYC tracking and an application pipeline.',
  objects: [
    {
      key: 'application',
      label: 'Application',
      plural: 'Applications',
      icon: 'file-text',
      fields: [
        { key: 'applicant', label: 'Applicant', type: 'lookup', options: { lookupObject: 'contact' } },
        { key: 'product', label: 'Product', type: 'picklist', indexed: true, options: pick('home_loan', 'personal_loan', 'business_loan', 'life_insurance', 'health_insurance', 'mutual_fund') },
        { key: 'requested_amount', label: 'Requested amount', type: 'currency', indexed: true },
        { key: 'kyc_status', label: 'KYC status', type: 'picklist', indexed: true, options: pick('pending', 'submitted', 'verified', 'rejected') },
        { key: 'cibil_band', label: 'Credit band', type: 'picklist', pii: true, options: pick('excellent', 'good', 'fair', 'poor', 'unknown') },
      ],
    },
  ],
  fields: [
    {
      object: 'lead',
      fields: [
        { key: 'monthly_income_band', label: 'Monthly income band', type: 'picklist', pii: true, options: pick('lt_25k', '25k_50k', '50k_1l', '1l_3l', 'gt_3l') },
        { key: 'product_interest', label: 'Product interest', type: 'picklist', indexed: true, options: pick('loan', 'insurance', 'investment') },
      ],
    },
  ],
  pipelines: [
    {
      object: 'application',
      name: 'Application Processing',
      isDefault: true,
      stages: [
        { key: 'received', label: 'Received', probability: 10, category: 'open' },
        { key: 'kyc', label: 'KYC', probability: 30, category: 'open' },
        { key: 'underwriting', label: 'Underwriting', probability: 60, category: 'open' },
        { key: 'sanctioned', label: 'Sanctioned', probability: 90, category: 'open' },
        { key: 'disbursed', label: 'Disbursed / Issued', probability: 100, category: 'won' },
        { key: 'rejected', label: 'Rejected', probability: 0, category: 'lost' },
      ],
    },
  ],
  workflows: [
    {
      name: 'KYC verified → move to underwriting task',
      object: 'application',
      trigger: 'updated',
      conditions: [{ field: 'kyc_status', op: 'eq', value: 'verified' }],
      actions: [{ type: 'create_task', title: 'Start underwriting review', dueInHours: 48, assignTo: 'owner' }],
    },
  ],
  aiContext:
    'The business is a regulated Indian financial-services distributor. Do not give investment advice; flag suitability and KYC gaps; income and credit fields are sensitive.',
};

export const MODULES: Record<string, ModuleManifest> = {
  [REAL_ESTATE.key]: REAL_ESTATE,
  [HEALTHCARE.key]: HEALTHCARE,
  [ECOMMERCE.key]: ECOMMERCE,
  [FINANCIAL_SERVICES.key]: FINANCIAL_SERVICES,
};
