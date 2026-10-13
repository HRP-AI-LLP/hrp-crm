/**
 * Computed fields and declarative rules on the write path:
 *   - formula fields: evaluated in dependency order on every create/update and stored in `custom`
 *     (so they can be filtered, sorted, indexed and exported like any other value)
 *   - roll-up summaries: COUNT/SUM/AVG/MIN/MAX over child records, refreshed whenever a child is
 *     created, changed, re-parented, deleted or merged
 *   - field dependencies (dependent picklists, conditional requirement) and validation rules
 * All of it runs inside the caller's transaction, so a failed rule rolls the whole write back.
 */
import {
  checkDependencies,
  checkFormula,
  coerceResult,
  compileFormula,
  evalCondition,
  type FieldDef,
  type FormulaEnv,
  type FormulaReturnType,
  type FValue,
  isComputed,
  type ObjectMeta,
  storageFor,
  type TenantMeta,
  valueType,
} from '@synapse/shared';
import { badRequest } from '../lib/errors';
import { filterSql, getObject, ident, Params, type RecordCtx } from './records';

/** Pseudo-fields every formula can use besides the object's own fields. */
export const FORMULA_EXTRA_FIELDS = ['id', 'title', 'created_at', 'updated_at', 'stage', 'stage_category'];

export function formulaFieldNames(obj: ObjectMeta): string[] {
  return [...obj.fields.map((f) => f.key), ...FORMULA_EXTRA_FIELDS];
}

/** Flat, JSON-friendly values of a DB row (standard columns + custom), plus stage pseudo-fields. */
export function rowValues(meta: TenantMeta, obj: ObjectMeta, row: Record<string, unknown>): Record<string, unknown> {
  const custom = (row.custom ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of obj.fields) {
    let v = f.standard ? row[f.key] : custom[f.key];
    if (v instanceof Date) v = valueType(f) === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
    if (f.standard && typeof v === 'string' && ['number', 'currency', 'percent'].includes(valueType(f))) v = Number(v);
    out[f.key] = v ?? null;
  }
  for (const k of ['id', 'created_at', 'updated_at'] as const) {
    const v = row[k];
    out[k] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  out.title = row[storageFor(obj.key).titleColumn] ?? null;
  return withStage(meta, out);
}

export function withStage(meta: TenantMeta, values: Record<string, unknown>): Record<string, unknown> {
  if (values.stage_id) {
    for (const p of meta.pipelines) {
      const s = p.stages.find((x) => x.id === values.stage_id);
      if (s) return { ...values, stage: s.label, stage_category: s.category };
    }
  }
  return { ...values, stage: values.stage ?? null, stage_category: values.stage_category ?? null };
}

/** Formula fields in evaluation order; fields that are part of a cycle are left out. */
export function formulaOrder(obj: ObjectMeta): FieldDef[] {
  const formulas = new Map(obj.fields.filter((f) => f.type === 'formula' && f.options?.expression).map((f) => [f.key, f]));
  const out: FieldDef[] = [];
  const state = new Map<string, 'visiting' | 'done' | 'cycle'>();
  const visit = (k: string): boolean => {
    const st = state.get(k);
    if (st === 'done') return true;
    if (st === 'visiting' || st === 'cycle') return false;
    state.set(k, 'visiting');
    const f = formulas.get(k)!;
    let refs: string[] = [];
    try {
      refs = compileFormula(f.options!.expression!).refs;
    } catch {
      state.set(k, 'cycle');
      return false;
    }
    for (const r of refs) if (formulas.has(r) && !visit(r)) {
      state.set(k, 'cycle');
      return false;
    }
    state.set(k, 'done');
    out.push(f);
    return true;
  };
  for (const k of formulas.keys()) visit(k);
  return out;
}

/** Evaluates all formula fields on `values` (mutated so later formulas see earlier results). */
export function computeFormulas(obj: ObjectMeta, values: Record<string, unknown>, userId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const env: FormulaEnv = { get: (k) => values[k] as FValue | undefined, userId };
  for (const f of formulaOrder(obj)) {
    let r: FValue = null;
    try {
      r = compileFormula(f.options!.expression!).run(env);
    } catch {
      r = null;
    }
    const v = coerceResult(r, f.options?.returnType ?? 'number', f.options?.precision ?? 2);
    values[f.key] = v;
    out[f.key] = v;
  }
  return out;
}

export interface RuleIssue {
  field: string | null;
  message: string;
}

/** Validation rules + dependency checks. `prior` is null on create. */
export function evaluateRules(obj: ObjectMeta, values: Record<string, unknown>, prior: Record<string, unknown> | null, touched: Set<string> | null, userId: string): RuleIssue[] {
  const issues: RuleIssue[] = checkDependencies(obj, values, touched);
  const env: FormulaEnv = {
    get: (k) => values[k] as FValue | undefined,
    prior: prior ? (k) => prior[k] as FValue | undefined : undefined,
    isNew: !prior,
    userId,
  };
  for (const r of obj.validationRules ?? []) {
    if (!r.active) continue;
    if (evalCondition(r.condition, env)) issues.push({ field: r.field, message: r.message });
  }
  return issues;
}

export function throwIfIssues(issues: RuleIssue[]) {
  if (issues.length) throw badRequest(issues[0]!.message, issues.map((i) => ({ field: i.field ?? undefined, message: i.message })));
}

// ------------------------------------------------------------------------------------- roll-ups
const valueExpr = (f: FieldDef, cast: 'numeric' | 'timestamptz') =>
  f.standard ? `r.${ident(f.key)}::${cast}` : cast === 'numeric' ? `app.try_numeric(r.custom ->> '${f.key}')` : `app.try_timestamptz(r.custom ->> '${f.key}')`;

/** Current values of every roll-up field on one parent record. */
export async function computeRollups(ctx: RecordCtx, obj: ObjectMeta, parentId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const f of obj.fields) {
    const spec = f.type === 'rollup' ? f.options?.rollup : undefined;
    if (!spec) continue;
    const child = ctx.meta.objects.find((o) => o.key === spec.object);
    const via = child?.fields.find((x) => x.key === spec.via);
    if (!child || !via) {
      out[f.key] = null;
      continue;
    }
    const s = storageFor(child.key);
    const p = new Params();
    const where = [`r.tenant_id = ${p.add(ctx.tenantId)}::uuid`, 'r.deleted_at is null'];
    if (s.discriminated) where.push(`r.object_key = ${p.add(child.key)}`);
    where.push(via.standard ? `r.${ident(via.key)} = ${p.add(parentId)}::uuid` : `r.custom ->> '${via.key}' = ${p.add(parentId)}`);
    for (const flt of spec.filters ?? []) {
      const ff = child.fields.find((x) => x.key === flt.field);
      if (ff) where.push(`(${filterSql(ff, flt.op, flt.value, child.key, p)})`);
    }
    let agg = 'count(*)';
    let isDate = false;
    if (spec.aggregate !== 'count') {
      const vf = child.fields.find((x) => x.key === spec.field);
      if (!vf) {
        out[f.key] = null;
        continue;
      }
      isDate = ['date', 'datetime'].includes(valueType(vf));
      agg = `${spec.aggregate}(${valueExpr(vf, isDate ? 'timestamptz' : 'numeric')})`;
    }
    const row = await ctx.tx.one<{ v: unknown }>(`select ${agg} as v from ${ident(s.table)} r where ${where.join(' and ')}`, p.values);
    let v = row?.v ?? null;
    if (v instanceof Date) v = v.toISOString();
    out[f.key] = coerceResult(v === null ? (spec.aggregate === 'count' || spec.aggregate === 'sum' ? 0 : null) : isDate ? String(v) : Number(v), f.options?.returnType ?? 'number', f.options?.precision ?? 2);
  }
  return out;
}

/**
 * Re-evaluates roll-ups and formulas of one record and stores them when they changed.
 * Writes directly (no events, no audit noise beyond the row trigger) — derived data only.
 */
export async function recomputeRecord(ctx: RecordCtx, objectKey: string, id: string, depth = 0): Promise<boolean> {
  const obj = getObject(ctx.meta, objectKey);
  if (!obj.fields.some(isComputed)) return false;
  const s = storageFor(objectKey);
  const row = await ctx.tx.one<Record<string, unknown>>(`select r.* from ${ident(s.table)} r where r.tenant_id = $1 and r.id = $2::uuid and r.deleted_at is null for update`, [ctx.tenantId, id]);
  if (!row) return false;
  const values = rowValues(ctx.meta, obj, row);
  const rollups = await computeRollups(ctx, obj, id);
  Object.assign(values, rollups);
  const formulas = computeFormulas(obj, values, ctx.principal.user.id);
  const custom = { ...((row.custom ?? {}) as Record<string, unknown>) };
  let changed = false;
  for (const [k, v] of Object.entries({ ...rollups, ...formulas })) {
    if (JSON.stringify(custom[k] ?? null) !== JSON.stringify(v ?? null)) {
      changed = true;
      if (v === null || v === undefined) delete custom[k];
      else custom[k] = v;
    }
  }
  if (!changed) return false;
  await ctx.tx.query(`update ${ident(s.table)} set custom = $3::jsonb where tenant_id = $1 and id = $2::uuid`, [ctx.tenantId, id, JSON.stringify(custom)]);
  // a roll-up can itself be rolled up one level further (e.g. property → project → developer)
  if (depth < 2) await refreshParents(ctx, objectKey, [row], depth + 1);
  return true;
}

/** After children change: refresh roll-ups on every parent the rows point (or pointed) at. */
export async function refreshParents(ctx: RecordCtx, childObjectKey: string, rows: (Record<string, unknown> | null | undefined)[], depth = 0): Promise<void> {
  const targets = new Map<string, Set<string>>();
  for (const parent of ctx.meta.objects) {
    for (const f of parent.fields) {
      const spec = f.type === 'rollup' ? f.options?.rollup : undefined;
      if (!spec || spec.object !== childObjectKey) continue;
      const child = ctx.meta.objects.find((o) => o.key === childObjectKey);
      const via = child?.fields.find((x) => x.key === spec.via);
      if (!via) continue;
      for (const r of rows) {
        if (!r) continue;
        const v = via.standard ? r[via.key] : ((r.custom ?? {}) as Record<string, unknown>)[via.key];
        if (typeof v === 'string' && v) {
          if (!targets.has(parent.key)) targets.set(parent.key, new Set());
          targets.get(parent.key)!.add(v);
        }
      }
    }
  }
  for (const [objectKey, ids] of targets) for (const id of ids) await recomputeRecord(ctx, objectKey, id, depth);
}

/** True when anything in the tenant rolls this object up (skip the work otherwise). */
export function hasRollupParents(meta: TenantMeta, childObjectKey: string): boolean {
  return meta.objects.some((o) => o.fields.some((f) => f.type === 'rollup' && f.options?.rollup?.object === childObjectKey));
}

// ------------------------------------------------------------------------------- admin checks
/** Validates a formula / roll-up / dependency definition against the current metadata. */
export function checkComputedSpec(meta: TenantMeta, obj: ObjectMeta, f: FieldDef): string | null {
  const names = formulaFieldNames(obj).filter((k) => k !== f.key);
  if (f.type === 'formula') {
    const expr = f.options?.expression;
    if (!expr) return 'Formula fields need an expression';
    if (!f.options?.returnType) return 'Choose what the formula returns';
    const err = checkFormula(expr, [...names, f.key]);
    if (err) return err;
    if (compileFormula(expr).refs.includes(f.key)) return 'A formula cannot refer to itself';
    // reject cycles through other formulas
    const trial: ObjectMeta = { ...obj, fields: [...obj.fields.filter((x) => x.key !== f.key), f] };
    if (!formulaOrder(trial).some((x) => x.key === f.key)) return 'This formula depends on itself through another formula';
  }
  if (f.type === 'rollup') {
    const r = f.options?.rollup;
    if (!r) return 'Roll-up fields need a summary definition';
    const child = meta.objects.find((o) => o.key === r.object);
    if (!child) return `Unknown object "${r.object}"`;
    const via = child.fields.find((x) => x.key === r.via);
    if (!via || via.type !== 'lookup' || via.options?.lookupObject !== obj.key) return `${child.label} has no lookup field "${r.via}" pointing at ${obj.label}`;
    if (r.aggregate !== 'count') {
      const vf = child.fields.find((x) => x.key === r.field);
      if (!vf) return 'Choose the field to summarise';
      const t = valueType(vf);
      const numeric = ['number', 'currency', 'percent'].includes(t);
      if ((r.aggregate === 'sum' || r.aggregate === 'avg') && !numeric) return 'Sum and average need a number field';
      if (!numeric && !['date', 'datetime'].includes(t)) return 'Min and max need a number or date field';
    }
    for (const flt of r.filters ?? []) if (!child.fields.some((x) => x.key === flt.field)) return `Unknown filter field "${flt.field}"`;
  }
  for (const [label, expr] of [
    ['Show when', f.options?.visibleWhen],
    ['Required when', f.options?.requiredWhen],
  ] as const) {
    if (expr) {
      const err = checkFormula(expr, [...names, f.key]);
      if (err) return `${label}: ${err}`;
    }
  }
  const ctl = f.options?.controlling;
  if (ctl) {
    if (f.type !== 'picklist' && f.type !== 'multipicklist') return 'Only picklists can depend on another field';
    const parent = obj.fields.find((x) => x.key === ctl.field);
    if (!parent || (parent.type !== 'picklist' && parent.type !== 'boolean')) return 'The controlling field must be a picklist or checkbox';
    if (ctl.field === f.key) return 'A field cannot control itself';
    const choices = new Set((f.options?.choices ?? []).map((c) => c.value));
    for (const vals of Object.values(ctl.map)) for (const v of vals) if (!choices.has(v)) return `"${v}" is not one of this field's choices`;
  }
  return null;
}

/** Return type a roll-up stores, derived from the aggregate and the summarised field. */
export function rollupReturnType(meta: TenantMeta, f: FieldDef): FormulaReturnType {
  const r = f.options?.rollup;
  if (!r || r.aggregate === 'count') return 'number';
  const vf = meta.objects.find((o) => o.key === r.object)?.fields.find((x) => x.key === r.field);
  const t = vf ? valueType(vf) : 'number';
  if (r.aggregate === 'avg') return t === 'currency' ? 'currency' : 'number';
  if (t === 'currency' || t === 'percent') return t;
  if (t === 'date' || t === 'datetime') return 'date';
  return 'number';
}
