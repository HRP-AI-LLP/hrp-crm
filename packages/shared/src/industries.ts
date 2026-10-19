/**
 * Industry solutions for made-to-order and project businesses. A solution is an industry module
 * (fields, pipelines, objects, starter automations, AI context) plus the operating setup the
 * business runs on: which apps to switch on, the usual payment-milestone plan, the installation
 * checklist, complaint categories and KPI targets. Installing is idempotent and never deletes data.
 */
import type { ModuleManifest } from './modules';

const pick = (...vals: string[]) => ({ choices: vals.map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) })) });

export interface MilestoneStep {
  name: string;
  percent: number;
  trigger: 'on_confirmation' | 'before_dispatch' | 'on_delivery' | 'on_installation';
}

export interface IndustrySolution {
  key: string;
  name: string;
  tagline: string;
  /** who it is for, shown on the card */
  forWho: string;
  module: ModuleManifest;
  apps: string[];
  milestonePlan: MilestoneStep[];
  installChecklist: string[];
  /** KPI targets the workspace starts from (editable in Business health) */
  kpiTargets: Record<string, number>;
  /** what a typical day looks like with it: shown before installing */
  highlights: string[];
}

const SITE_VISIT_FOLLOW_UP = (object: string, field: string, value: string, title: string) => ({
  name: `Follow up after ${value.replace(/_/g, ' ')}`,
  object,
  trigger: 'updated' as const,
  conditions: [{ field, op: 'changed_to', value }],
  actions: [{ type: 'create_task', title, dueInHours: 24, assignTo: 'owner' }],
});

export const INTERIORS: IndustrySolution = {
  key: 'interiors',
  name: 'Interior design & fit-out',
  tagline: 'Homes, offices and retail: from site measurement to handover.',
  forWho: 'Interior designers, turnkey fit-out firms, design-and-build studios',
  apps: ['orders', 'delivery', 'billing', 'service', 'purchasing'],
  milestonePlan: [
    { name: 'Booking advance', percent: 10, trigger: 'on_confirmation' },
    { name: 'Design sign-off', percent: 40, trigger: 'on_confirmation' },
    { name: 'Before material dispatch', percent: 40, trigger: 'before_dispatch' },
    { name: 'On handover', percent: 10, trigger: 'on_installation' },
  ],
  installChecklist: ['Site ready and measurements re-checked', 'Civil and electrical points as per drawing', 'Modules installed, levelled and aligned', 'Snag list walked with the customer', 'Deep clean done', 'Handover photos taken', 'Care and warranty explained'],
  kpiTargets: { lead_response_minutes: 15, quote_lead_days: 7, quote_acceptance_rate: 35, win_rate: 25, on_time_delivery: 90, install_first_time_right: 85, collection_efficiency: 85, csat: 4.5 },
  highlights: ['Site measurement and design presentation stages on every deal', 'Scope (kitchen, wardrobes, full home), area and budget band on every lead', '10 / 40 / 40 / 10 payment plan applied to new orders', 'A seven-step handover checklist with customer sign-off'],
  module: {
    key: 'interiors',
    name: 'Interior design & fit-out',
    version: '1.0.0',
    industry: 'interiors',
    description: 'Scope, area, budget and possession date on leads; a design-led project pipeline; site measurements.',
    objects: [
      {
        key: 'site_measurement',
        label: 'Site measurement',
        plural: 'Site measurements',
        icon: 'ruler',
        fields: [
          { key: 'lead', label: 'Lead', type: 'lookup', options: { lookupObject: 'lead' } },
          { key: 'deal', label: 'Deal', type: 'lookup', options: { lookupObject: 'deal' } },
          { key: 'visit_at', label: 'Visit time', type: 'datetime', indexed: true, required: true },
          { key: 'measured_by', label: 'Measured by', type: 'user' },
          { key: 'outcome', label: 'Outcome', type: 'picklist', indexed: true, options: pick('scheduled', 'done', 'rescheduled', 'cancelled') },
          { key: 'carpet_area_sqft', label: 'Carpet area (sq ft)', type: 'number', options: { min: 0 } },
          { key: 'notes', label: 'Notes and constraints', type: 'textarea' },
        ],
      },
    ],
    fields: [
      {
        object: 'lead',
        fields: [
          { key: 'property_type', label: 'Property type', type: 'picklist', indexed: true, options: pick('apartment', 'villa', 'independent_house', 'office', 'retail', 'hospitality') },
          { key: 'scope', label: 'Scope', type: 'multipicklist', options: pick('full_home', 'modular_kitchen', 'wardrobes', 'living_room', 'bedrooms', 'false_ceiling', 'office_fit_out') },
          { key: 'carpet_area_sqft', label: 'Carpet area (sq ft)', type: 'number', indexed: true, options: { min: 0 } },
          { key: 'budget_band', label: 'Budget', type: 'picklist', indexed: true, options: pick('under_5_lakh', '5_10_lakh', '10_25_lakh', '25_50_lakh', 'above_50_lakh') },
          { key: 'possession_date', label: 'Possession / start date', type: 'date', indexed: true },
          { key: 'style_preference', label: 'Style', type: 'picklist', options: pick('modern', 'contemporary', 'minimal', 'traditional', 'industrial', 'not_sure') },
        ],
      },
    ],
    pipelines: [
      {
        object: 'deal',
        name: 'Interior projects',
        stages: [
          { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
          { key: 'site_measurement', label: 'Site measurement', probability: 25, category: 'open' },
          { key: 'design_presentation', label: 'Design presentation', probability: 45, category: 'open' },
          { key: 'quote_negotiation', label: 'Quote & negotiation', probability: 65, category: 'open' },
          { key: 'booking_advance', label: 'Booking advance', probability: 90, category: 'open' },
          { key: 'won', label: 'Won', probability: 100, category: 'won' },
          { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
        ],
      },
    ],
    workflows: [SITE_VISIT_FOLLOW_UP('site_measurement', 'outcome', 'done', 'Share the design brief and book the presentation')],
    aiContext: 'The business designs and executes home and office interiors in India. Typical deals run 2–8 weeks from site measurement to booking; customers compare 2–3 designers on design quality, timelines and price per square foot. Payment usually follows booking, design sign-off, dispatch and handover milestones.',
  },
};

export const MODULAR: IndustrySolution = {
  key: 'modular',
  name: 'Modular kitchens & wardrobes',
  tagline: 'Showroom visits, 3D designs, factory orders and installation.',
  forWho: 'Modular kitchen and wardrobe brands, franchise showrooms, dealers',
  apps: ['orders', 'delivery', 'billing', 'service', 'inventory', 'purchasing'],
  milestonePlan: [
    { name: 'Advance', percent: 50, trigger: 'on_confirmation' },
    { name: 'Before dispatch', percent: 40, trigger: 'before_dispatch' },
    { name: 'After installation', percent: 10, trigger: 'on_installation' },
  ],
  installChecklist: ['Carcass fixed, level and plumb', 'Shutters aligned with even gaps', 'Hinges, channels and soft-close tested', 'Countertop and sink fitted and sealed', 'Hob, chimney and appliances fitted', 'Skirting, handles and profiles finished', 'Customer shown care, warranty and service number'],
  kpiTargets: { lead_response_minutes: 10, quote_lead_days: 5, quote_acceptance_rate: 40, win_rate: 30, on_time_delivery: 90, install_first_time_right: 90, collection_efficiency: 90, csat: 4.5 },
  highlights: ['Kitchen layout, finish and appliance needs on every lead', 'Showroom visit → measurement → 3D design → quote pipeline', '50 / 40 / 10 payment plan on new orders', 'A seven-point installation checklist with sign-off'],
  module: {
    key: 'modular',
    name: 'Modular kitchens & wardrobes',
    version: '1.0.0',
    industry: 'modular',
    description: 'Layout, finish, appliances and showroom visits on leads; a design-to-order pipeline.',
    objects: [],
    fields: [
      {
        object: 'lead',
        fields: [
          { key: 'requirement', label: 'Requirement', type: 'multipicklist', options: pick('kitchen', 'wardrobe', 'tv_unit', 'vanity', 'study', 'full_home') },
          { key: 'kitchen_layout', label: 'Kitchen layout', type: 'picklist', indexed: true, options: pick('l_shaped', 'u_shaped', 'parallel', 'straight', 'island', 'not_sure') },
          { key: 'finish', label: 'Finish', type: 'picklist', indexed: true, options: pick('laminate', 'acrylic', 'pu_lacquer', 'veneer', 'membrane', 'glass', 'not_sure') },
          { key: 'appliances_needed', label: 'Appliances needed', type: 'boolean' },
          { key: 'budget_band', label: 'Budget', type: 'picklist', indexed: true, options: pick('under_2_lakh', '2_4_lakh', '4_8_lakh', '8_15_lakh', 'above_15_lakh') },
          { key: 'showroom_visit_at', label: 'Showroom visit', type: 'datetime', indexed: true },
        ],
      },
    ],
    pipelines: [
      {
        object: 'deal',
        name: 'Modular orders',
        stages: [
          { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
          { key: 'showroom_visit', label: 'Showroom visit', probability: 25, category: 'open' },
          { key: 'measurement', label: 'Site measurement', probability: 40, category: 'open' },
          { key: 'design_3d', label: '3D design', probability: 55, category: 'open' },
          { key: 'quotation', label: 'Quotation', probability: 70, category: 'open' },
          { key: 'advance', label: 'Advance received', probability: 95, category: 'open' },
          { key: 'won', label: 'Won', probability: 100, category: 'won' },
          { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
        ],
      },
    ],
    workflows: [
      {
        name: 'Confirm the showroom visit',
        object: 'lead',
        trigger: 'updated',
        conditions: [{ field: 'showroom_visit_at', op: 'changed' }, { field: 'showroom_visit_at', op: 'not_empty' }],
        actions: [{ type: 'create_task', title: 'Confirm the showroom visit and share the location', dueInHours: 4, assignTo: 'owner' }],
      },
    ],
    aiContext: 'The business sells and installs modular kitchens and wardrobes in India. Leads usually visit a showroom, then get a site measurement and a 3D design before a quote. Customers compare finishes (laminate, acrylic, PU), hardware brands and warranty. Production takes 3–5 weeks after the advance.',
  },
};

export const SOLAR: IndustrySolution = {
  key: 'solar',
  name: 'Rooftop solar (EPC)',
  tagline: 'Site surveys, subsidy and net-metering paperwork, commissioning.',
  forWho: 'Rooftop solar installers and EPC companies for homes, shops and factories',
  apps: ['orders', 'delivery', 'billing', 'service', 'inventory', 'purchasing'],
  milestonePlan: [
    { name: 'Advance', percent: 30, trigger: 'on_confirmation' },
    { name: 'On material delivery', percent: 60, trigger: 'on_delivery' },
    { name: 'After commissioning', percent: 10, trigger: 'on_installation' },
  ],
  installChecklist: ['Mounting structure fixed and torque checked', 'Panels mounted and strings connected', 'Inverter installed and configured', 'Earthing and lightning arrester done', 'DCDB / ACDB wired and labelled', 'Net-meter application filed', 'System commissioned and generation verified', 'Customer trained on the monitoring app'],
  kpiTargets: { lead_response_minutes: 30, quote_lead_days: 5, win_rate: 25, on_time_delivery: 85, install_first_time_right: 90, collection_efficiency: 85, csat: 4.5 },
  highlights: ['Sanctioned load, monthly bill, roof type and DISCOM on every lead', 'Site survey → proposal → subsidy / loan → net metering pipeline', '30 / 60 / 10 payment plan', 'An eight-point commissioning checklist'],
  module: {
    key: 'solar',
    name: 'Rooftop solar (EPC)',
    version: '1.0.0',
    industry: 'solar',
    description: 'Load, bill, roof and DISCOM details on leads; site surveys; a subsidy and net-metering aware pipeline.',
    objects: [
      {
        key: 'site_survey',
        label: 'Site survey',
        plural: 'Site surveys',
        icon: 'sun',
        fields: [
          { key: 'lead', label: 'Lead', type: 'lookup', options: { lookupObject: 'lead' } },
          { key: 'survey_at', label: 'Survey time', type: 'datetime', indexed: true, required: true },
          { key: 'shadow_free_area_sqft', label: 'Shadow-free area (sq ft)', type: 'number', options: { min: 0 } },
          { key: 'recommended_kw', label: 'Recommended size (kW)', type: 'number', indexed: true, options: { min: 0 } },
          { key: 'structure', label: 'Structure', type: 'picklist', options: pick('rcc_roof', 'metal_sheet', 'elevated', 'ground_mount') },
          { key: 'outcome', label: 'Outcome', type: 'picklist', indexed: true, options: pick('scheduled', 'done', 'not_feasible', 'cancelled') },
          { key: 'notes', label: 'Notes', type: 'textarea' },
        ],
      },
    ],
    fields: [
      {
        object: 'lead',
        fields: [
          { key: 'consumer_type', label: 'Consumer', type: 'picklist', indexed: true, options: pick('residential', 'housing_society', 'commercial', 'industrial', 'institution') },
          { key: 'sanctioned_load_kw', label: 'Sanctioned load (kW)', type: 'number', indexed: true, options: { min: 0 } },
          { key: 'monthly_bill', label: 'Average monthly bill', type: 'currency', indexed: true, options: { min: 0 } },
          { key: 'roof_type', label: 'Roof', type: 'picklist', options: pick('rcc', 'metal_sheet', 'tiled', 'not_sure') },
          { key: 'discom', label: 'Electricity distributor (DISCOM)', type: 'text', indexed: true },
          { key: 'finance', label: 'Payment', type: 'picklist', options: pick('self_funded', 'bank_loan', 'emi', 'not_decided') },
          { key: 'subsidy_applicable', label: 'Government subsidy applicable', type: 'boolean' },
        ],
      },
    ],
    pipelines: [
      {
        object: 'deal',
        name: 'Solar projects',
        stages: [
          { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
          { key: 'site_survey', label: 'Site survey', probability: 25, category: 'open' },
          { key: 'proposal', label: 'Proposal', probability: 45, category: 'open' },
          { key: 'finance_subsidy', label: 'Loan / subsidy', probability: 65, category: 'open' },
          { key: 'advance', label: 'Advance received', probability: 85, category: 'open' },
          { key: 'net_metering', label: 'Net metering', probability: 95, category: 'open' },
          { key: 'commissioned', label: 'Commissioned', probability: 100, category: 'won' },
          { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
        ],
      },
    ],
    workflows: [SITE_VISIT_FOLLOW_UP('site_survey', 'outcome', 'done', 'Send the solar proposal with savings and payback')],
    aiContext: 'The business designs and installs rooftop solar systems in India. Proposals are sized from the sanctioned load, monthly bill and shadow-free roof area; customers weigh savings, payback, subsidy eligibility, financing and panel / inverter brands. Net-metering approval by the DISCOM is often the slowest step. Do not promise subsidy amounts; say they depend on current scheme rules.',
  },
};

export const FABRICATION: IndustrySolution = {
  key: 'fabrication',
  name: 'Fabrication & contract manufacturing',
  tagline: 'RFQs, drawings, costing, POs and quality checks before dispatch.',
  forWho: 'Sheet-metal, structural and steel fabricators, job shops, contract manufacturers',
  apps: ['orders', 'delivery', 'billing', 'service', 'inventory', 'purchasing'],
  milestonePlan: [
    { name: 'Advance against PO', percent: 30, trigger: 'on_confirmation' },
    { name: 'Before dispatch', percent: 70, trigger: 'before_dispatch' },
  ],
  installChecklist: ['Dimensions checked against the drawing', 'Weld and finish inspected', 'Surface treatment / paint verified', 'Packed and labelled', 'Test certificate and dispatch documents attached'],
  kpiTargets: { lead_response_minutes: 60, quote_lead_days: 3, quote_acceptance_rate: 30, win_rate: 30, on_time_delivery: 95, collection_efficiency: 80, dso_days: 60 },
  highlights: ['Material, quantity, drawing status and required-by date on every RFQ', 'RFQ → drawing review → costing → quote → PO pipeline', '30 / 70 payment plan on POs', 'A five-point QC check before dispatch'],
  module: {
    key: 'fabrication',
    name: 'Fabrication & contract manufacturing',
    version: '1.0.0',
    industry: 'fabrication',
    description: 'RFQ details (material, quantity, drawings, deadlines) on leads; an RFQ-to-PO pipeline.',
    objects: [],
    fields: [
      {
        object: 'lead',
        fields: [
          { key: 'material', label: 'Material', type: 'multipicklist', options: pick('mild_steel', 'stainless_steel', 'aluminium', 'galvanised', 'copper_brass', 'other') },
          { key: 'process', label: 'Process', type: 'multipicklist', options: pick('laser_cutting', 'bending', 'welding', 'machining', 'powder_coating', 'assembly') },
          { key: 'quantity', label: 'Quantity', type: 'number', options: { min: 0 } },
          { key: 'drawing_status', label: 'Drawing', type: 'picklist', indexed: true, options: pick('received', 'to_be_made', 'sample_only', 'awaited') },
          { key: 'required_by', label: 'Required by', type: 'date', indexed: true },
          { key: 'buyer_industry', label: 'Buyer industry', type: 'picklist', options: pick('automotive', 'construction', 'electrical', 'pharma', 'food', 'oem', 'other') },
        ],
      },
    ],
    pipelines: [
      {
        object: 'deal',
        name: 'RFQs',
        stages: [
          { key: 'rfq', label: 'RFQ received', probability: 10, category: 'open' },
          { key: 'drawing_review', label: 'Drawing review', probability: 25, category: 'open' },
          { key: 'costing', label: 'Costing', probability: 40, category: 'open' },
          { key: 'quoted', label: 'Quoted', probability: 55, category: 'open' },
          { key: 'negotiation', label: 'Negotiation', probability: 75, category: 'open' },
          { key: 'po_received', label: 'PO received', probability: 100, category: 'won' },
          { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
        ],
      },
    ],
    workflows: [
      {
        name: 'Ask for the drawing',
        object: 'lead',
        trigger: 'created',
        conditions: [{ field: 'drawing_status', op: 'eq', value: 'awaited' }],
        actions: [{ type: 'create_task', title: 'Get the drawing and specifications from the buyer', dueInHours: 24, assignTo: 'owner' }],
      },
    ],
    aiContext: 'The business is an Indian fabrication or contract-manufacturing job shop. Buyers send RFQs with drawings; winning depends on fast, accurate costing (material, process time, finish), lead time and quality documents. Payment is usually advance against PO and balance before dispatch or on credit terms.',
  },
};

export const SIGNAGE: IndustrySolution = {
  key: 'signage',
  name: 'Signage & branding',
  tagline: 'Recce, mock-ups, approvals and multi-site installation.',
  forWho: 'Signage makers, retail branding agencies, LED and display installers',
  apps: ['orders', 'delivery', 'billing', 'service'],
  milestonePlan: [
    { name: 'Advance', percent: 50, trigger: 'on_confirmation' },
    { name: 'Before installation', percent: 40, trigger: 'before_dispatch' },
    { name: 'After installation', percent: 10, trigger: 'on_installation' },
  ],
  installChecklist: ['Mounting surface checked', 'Sign fixed level and secure', 'Electrical connection and timer tested', 'Before and after photos taken', 'Site cleaned', 'Customer sign-off'],
  kpiTargets: { lead_response_minutes: 30, quote_lead_days: 3, quote_acceptance_rate: 40, win_rate: 35, on_time_delivery: 90, install_first_time_right: 90, collection_efficiency: 85 },
  highlights: ['Sign type, size, number of sites and permission needs on every lead', 'Recce → mock-up → approval → quote pipeline', '50 / 40 / 10 payment plan', 'Before/after photo checklist on every installation'],
  module: {
    key: 'signage',
    name: 'Signage & branding',
    version: '1.0.0',
    industry: 'signage',
    description: 'Sign type, size, sites and permissions on leads; a recce-to-approval pipeline.',
    objects: [],
    fields: [
      {
        object: 'lead',
        fields: [
          { key: 'sign_type', label: 'Sign type', type: 'multipicklist', options: pick('acp_letters', 'led_signage', 'neon', 'glow_sign_box', 'flex_vinyl', 'wayfinding', 'digital_display') },
          { key: 'sites', label: 'Number of sites', type: 'number', indexed: true, options: { min: 1 } },
          { key: 'size_sqft', label: 'Total size (sq ft)', type: 'number', options: { min: 0 } },
          { key: 'permission_needed', label: 'Municipal permission needed', type: 'boolean' },
          { key: 'launch_date', label: 'Store launch / deadline', type: 'date', indexed: true },
        ],
      },
    ],
    pipelines: [
      {
        object: 'deal',
        name: 'Signage jobs',
        stages: [
          { key: 'enquiry', label: 'Enquiry', probability: 10, category: 'open' },
          { key: 'recce', label: 'Site recce', probability: 25, category: 'open' },
          { key: 'mockup', label: 'Design mock-up', probability: 45, category: 'open' },
          { key: 'approval', label: 'Brand approval', probability: 65, category: 'open' },
          { key: 'quote', label: 'Quote', probability: 80, category: 'open' },
          { key: 'won', label: 'Won', probability: 100, category: 'won' },
          { key: 'lost', label: 'Lost', probability: 0, category: 'lost' },
        ],
      },
    ],
    workflows: [],
    aiContext: 'The business makes and installs signage and retail branding in India, often across many store sites. Brand approval of mock-ups, launch deadlines and municipal permissions drive timelines.',
  },
};

export const SOLUTIONS: Record<string, IndustrySolution> = {
  [INTERIORS.key]: INTERIORS,
  [MODULAR.key]: MODULAR,
  [SOLAR.key]: SOLAR,
  [FABRICATION.key]: FABRICATION,
  [SIGNAGE.key]: SIGNAGE,
};
