import { z } from 'zod';
import type { FormulaReturnType } from './formula';

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean',
  'picklist', 'multipicklist', 'email', 'phone', 'url', 'lookup', 'user', 'formula', 'rollup',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export interface PicklistChoice {
  value: string;
  label: string;
  color?: string;
}

export const RETURN_TYPES = ['number', 'currency', 'percent', 'text', 'date', 'boolean'] as const;
export const ROLLUP_AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;

export interface RollupSpec {
  /** child object holding the lookup */
  object: string;
  /** lookup field on the child that points at this object */
  via: string;
  aggregate: (typeof ROLLUP_AGGREGATES)[number];
  /** child field aggregated (not needed for count) */
  field?: string;
  /** only children matching all of these */
  filters?: { field: string; op: string; value?: unknown }[];
}

export interface FieldOptions {
  choices?: PicklistChoice[];
  lookupObject?: string;
  precision?: number;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: unknown;
  /** formula fields */
  expression?: string;
  returnType?: FormulaReturnType;
  /** roll-up summary fields */
  rollup?: RollupSpec;
  /** dependent picklist: allowed values of this field per value of the controlling picklist */
  controlling?: { field: string; map: Record<string, string[]> };
  /** formula conditions: show the field only when true / require it when true */
  visibleWhen?: string;
  requiredWhen?: string;
  /**
   * picklists: whether people may type a value that isn't a choice yet ("Other…"); it is then added
   * as a choice for everyone. Default: yes for custom fields, no for standard ones (whose values the
   * application acts on) unless the standard field says so.
   */
  addable?: boolean;
}

/** Unified field descriptor for standard columns and tenant custom fields. */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  indexed?: boolean;
  pii?: boolean;
  readOnly?: boolean;
  /** true = physical column on the object table; false = stored in `custom` jsonb */
  standard: boolean;
  options?: FieldOptions;
  helpText?: string | null;
  position?: number;
  moduleKey?: string | null;
}

export const fieldSpecSchema = z.object({
  key: z.string().regex(KEY_PATTERN, 'lowercase letters, digits and _; must start with a letter'),
  label: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  indexed: z.boolean().optional(),
  pii: z.boolean().optional(),
  helpText: z.string().max(300).nullish(),
  position: z.number().int().optional(),
  options: z
    .object({
      choices: z
        .array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(80), color: z.string().optional() }))
        .max(500)
        .optional(),
      lookupObject: z.string().regex(KEY_PATTERN).optional(),
      precision: z.number().int().min(0).max(6).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      maxLength: z.number().int().min(1).max(100_000).optional(),
      default: z.unknown().optional(),
      expression: z.string().trim().min(1).max(2000).optional(),
      returnType: z.enum(RETURN_TYPES).optional(),
      rollup: z
        .object({
          object: z.string().regex(KEY_PATTERN),
          via: z.string().regex(KEY_PATTERN),
          aggregate: z.enum(ROLLUP_AGGREGATES),
          field: z.string().regex(KEY_PATTERN).optional(),
          filters: z.array(z.object({ field: z.string().regex(KEY_PATTERN), op: z.string().max(20), value: z.unknown().optional() })).max(10).optional(),
        })
        .optional(),
      controlling: z.object({ field: z.string().regex(KEY_PATTERN), map: z.record(z.string().max(80), z.array(z.string().max(80)).max(500)) }).optional(),
      visibleWhen: z.string().trim().max(2000).optional(),
      requiredWhen: z.string().trim().max(2000).optional(),
      addable: z.boolean().optional(),
    })
    .optional(),
});
export type FieldSpec = z.infer<typeof fieldSpecSchema>;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Computed fields (formula, roll-up) are stored like their result type; everything else as itself. */
export function valueType(field: Pick<FieldDef, 'type' | 'options'>): Exclude<FieldType, 'formula' | 'rollup'> {
  if (field.type === 'formula' || field.type === 'rollup') return field.options?.returnType ?? 'number';
  return field.type;
}

export const isComputed = (f: Pick<FieldDef, 'type'>) => f.type === 'formula' || f.type === 'rollup';

/** Can people add a new choice to this picklist by typing it ("Other…")? */
export function choicesAddable(f: Pick<FieldDef, 'type' | 'standard' | 'readOnly' | 'options'>): boolean {
  if (f.type !== 'picklist' && f.type !== 'multipicklist') return false;
  if (f.readOnly || f.options?.controlling) return false;
  return f.options?.addable ?? !f.standard;
}

/** The stored value for a choice typed by a person: lowercase words joined by _ (as the built-in choices are). */
export function choiceValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** A typed label matching an existing choice (by value or label, ignoring case) returns that choice. */
export function findChoice(choices: PicklistChoice[], typed: string): PicklistChoice | undefined {
  const t = typed.trim().toLowerCase();
  const v = choiceValue(typed);
  return choices.find((c) => c.value === typed || c.label.toLowerCase() === t || c.value === v);
}

/** Builds a zod validator for one field value (null clears the field). */
export function valueSchema(field: FieldDef): z.ZodType<unknown> {
  const o = field.options ?? {};
  let s: z.ZodType<unknown>;
  switch (valueType(field)) {
    case 'text':
      s = z.string().trim().max(o.maxLength ?? 255);
      break;
    case 'textarea':
      s = z.string().max(o.maxLength ?? 32_000);
      break;
    case 'email':
      s = z.string().trim().toLowerCase().pipe(z.email()).or(z.literal(''));
      break;
    case 'phone':
      s = z.string().trim().regex(/^[+0-9 ()\-.]{4,25}$/, 'invalid phone number');
      break;
    case 'url':
      s = z.string().trim().pipe(z.url({ protocol: /^https?$/ }));
      break;
    case 'number':
    case 'currency':
    case 'percent': {
      let n = z.coerce.number().refine(Number.isFinite, 'must be a number');
      if (o.min !== undefined) n = n.refine((v) => v >= (o.min as number), `must be ≥ ${o.min}`);
      if (o.max !== undefined) n = n.refine((v) => v <= (o.max as number), `must be ≤ ${o.max}`);
      if (field.type === 'percent') n = n.refine((v) => v >= 0 && v <= 100, 'must be 0–100');
      s = n;
      break;
    }
    case 'date':
      s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
      break;
    case 'datetime':
      s = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'expected ISO date-time');
      break;
    case 'boolean':
      s = z.boolean();
      break;
    case 'picklist': {
      const values = (o.choices ?? []).map((c) => c.value);
      s = values.length ? z.string().refine((v) => values.includes(v), `must be one of: ${values.join(', ')}`) : z.string();
      break;
    }
    case 'multipicklist': {
      const values = (o.choices ?? []).map((c) => c.value);
      s = z.array(z.string()).refine((arr) => arr.every((v) => !values.length || values.includes(v)), 'invalid choice');
      break;
    }
    case 'lookup':
    case 'user':
      s = z.string().regex(uuidRe, 'expected an id');
      break;
    default:
      s = z.unknown();
  }
  return s.nullable();
}

export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}
