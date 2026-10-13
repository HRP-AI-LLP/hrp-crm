import { z } from 'zod';

export const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean',
  'picklist', 'multipicklist', 'email', 'phone', 'url', 'lookup', 'user',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export interface PicklistChoice {
  value: string;
  label: string;
  color?: string;
}

export interface FieldOptions {
  choices?: PicklistChoice[];
  lookupObject?: string;
  precision?: number;
  min?: number;
  max?: number;
  maxLength?: number;
  default?: unknown;
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
    })
    .optional(),
});
export type FieldSpec = z.infer<typeof fieldSpecSchema>;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds a zod validator for one field value (null clears the field). */
export function valueSchema(field: FieldDef): z.ZodType<unknown> {
  const o = field.options ?? {};
  let s: z.ZodType<unknown>;
  switch (field.type) {
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
