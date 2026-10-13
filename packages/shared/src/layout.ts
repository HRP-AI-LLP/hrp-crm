/**
 * Page layouts, validation rules and field dependencies — the declarative layer the visual
 * builders edit. Evaluated identically by the API (enforcement) and the SPA (live behaviour).
 */
import { z } from 'zod';
import { type FieldDef, isComputed, isEmpty, KEY_PATTERN, type PicklistChoice } from './fields';
import { evalCondition, type FormulaEnv, type FValue } from './formula';
import type { ObjectMeta } from './types';

export interface LayoutSection {
  id: string;
  title: string;
  columns: 1 | 2;
  fields: string[];
  collapsed?: boolean;
}

export interface PageLayout {
  sections: LayoutSection[];
  /** fields deliberately removed from the page; any other unplaced field is appended */
  hidden: string[];
}

export const layoutSchema = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        title: z.string().trim().max(80),
        columns: z.union([z.literal(1), z.literal(2)]),
        fields: z.array(z.string().regex(KEY_PATTERN)).max(200),
        collapsed: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(30),
  hidden: z.array(z.string().regex(KEY_PATTERN)).max(300).default([]),
});

export interface ValidationRule {
  id: string;
  name: string;
  /** error condition: the save is blocked when this formula is TRUE */
  condition: string;
  message: string;
  /** field the message is shown under (optional; otherwise at the top of the form) */
  field: string | null;
  active: boolean;
}

export const validationRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  condition: z.string().trim().min(1).max(2000),
  message: z.string().trim().min(1).max(300),
  field: z.string().regex(KEY_PATTERN).nullish(),
  active: z.boolean().default(true),
});

/** Fields the layout never shows (internal plumbing). */
const NEVER_ON_LAYOUT = new Set(['full_name', 'pipeline_id']);

/** The default page: everything in one two-column "Details" section, standard fields first. */
export function defaultLayout(obj: ObjectMeta): PageLayout {
  const keys = obj.fields.filter((f) => !NEVER_ON_LAYOUT.has(f.key)).map((f) => f.key);
  return { sections: [{ id: 'details', title: 'Details', columns: 2, fields: keys }], hidden: [] };
}

/** Saved layout reconciled with the current fields: unknown keys dropped, new fields appended. */
export function resolveLayout(obj: ObjectMeta): PageLayout {
  const saved = obj.layout;
  if (!saved?.sections?.length) return defaultLayout(obj);
  const known = new Set(obj.fields.filter((f) => !NEVER_ON_LAYOUT.has(f.key)).map((f) => f.key));
  const placed = new Set<string>();
  const sections = saved.sections.map((s) => ({
    ...s,
    fields: s.fields.filter((k) => {
      if (!known.has(k) || placed.has(k)) return false;
      placed.add(k);
      return true;
    }),
  }));
  const hidden = saved.hidden.filter((k) => known.has(k) && !placed.has(k));
  const missing = [...known].filter((k) => !placed.has(k) && !hidden.includes(k));
  if (missing.length) sections[sections.length - 1]!.fields.push(...missing);
  return { sections, hidden };
}

// --------------------------------------------------------------------------- dependencies
export function formulaEnv(values: Record<string, unknown>, extra: Partial<FormulaEnv> = {}): FormulaEnv {
  return { get: (k) => values[k] as FValue | undefined, ...extra };
}

export function fieldVisible(f: FieldDef, values: Record<string, unknown>): boolean {
  return !f.options?.visibleWhen || evalCondition(f.options.visibleWhen, formulaEnv(values));
}

export function fieldRequired(f: FieldDef, values: Record<string, unknown>): boolean {
  if (isComputed(f) || f.readOnly) return false;
  if (f.required) return true;
  return !!f.options?.requiredWhen && fieldVisible(f, values) && evalCondition(f.options.requiredWhen, formulaEnv(values));
}

/** Picklist choices allowed by the controlling field's current value (all when not dependent). */
export function allowedChoices(f: FieldDef, values: Record<string, unknown>): PicklistChoice[] {
  const all = f.options?.choices ?? [];
  const ctl = f.options?.controlling;
  if (!ctl) return all;
  const cv = values[ctl.field];
  if (isEmpty(cv)) return [];
  const allowed = new Set(ctl.map[String(cv)] ?? []);
  return all.filter((c) => allowed.has(c.value));
}

export interface DependencyIssue {
  field: string;
  message: string;
}

/** Requirement and dependent-picklist checks on the merged (old + new) values. */
export function checkDependencies(obj: ObjectMeta, values: Record<string, unknown>, touched: Set<string> | null): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  for (const f of obj.fields) {
    if (isComputed(f)) continue;
    if (f.options?.requiredWhen && !f.required && fieldRequired(f, values) && isEmpty(values[f.key])) {
      issues.push({ field: f.key, message: 'is required' });
    }
    const ctl = f.options?.controlling;
    if (ctl && !isEmpty(values[f.key]) && (touched === null || touched.has(f.key) || touched.has(ctl.field))) {
      const allowed = allowedChoices(f, values).map((c) => c.value);
      const v = values[f.key];
      const bad = Array.isArray(v) ? v.some((x) => !allowed.includes(String(x))) : !allowed.includes(String(v));
      if (bad) {
        const parent = obj.fields.find((x) => x.key === ctl.field);
        issues.push({ field: f.key, message: `is not allowed when ${parent?.label ?? ctl.field} is "${String(values[ctl.field] ?? '')}"` });
      }
    }
  }
  return issues;
}
