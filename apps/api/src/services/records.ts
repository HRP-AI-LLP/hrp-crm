/**
 * Generic, metadata-driven record service for standard objects (lead/contact/account/deal) and
 * tenant-defined custom objects. Enforces, in order:
 *   1. object-level RBAC (create/read/update/delete with own/team/all scope)
 *   2. ABAC conditions (role conditions resolved against the user's attributes)
 *   3. field-level security (hidden fields are never selected into the DTO, never filterable,
 *      never sortable, never searchable; read-only fields are rejected on write)
 *   4. value validation from field metadata
 * All SQL is parameterised; identifiers come only from the static registry / validated metadata.
 */
import {
  type Access,
  type Condition,
  type EffectivePermissions,
  type FieldDef,
  type ObjectMeta,
  type PipelineMeta,
  type RecordDto,
  type TenantMeta,
  fieldAccess,
  isEmpty,
  KEY_PATTERN,
  objectPerm,
  resolveConditionValue,
  isComputed,
  storageFor,
  valueSchema,
  valueType,
  choicesAddable,
  choiceValue,
  findChoice,
  type PicklistChoice,
} from '@synapse/shared';
import type { Principal } from '../env';
import type { Tx } from '../lib/db';
import { randomToken } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { computeFormulas, evaluateRules, hasRollupParents, recomputeRecord, refreshParents, rowValues, throwIfIssues, withStage } from './computed';
import { computeScore, notifyOwner, pickAssignee } from './routing';
import { beforeCreate, beforeUpdate } from './hooks';
import { NUMBERED, nextDocumentNumber } from './numbering';
import { releaseInvoice } from './project-links';

export { NUMBERED, nextDocumentNumber };

export interface RecordCtx {
  tx: Tx;
  meta: TenantMeta;
  principal: Principal;
  tenantId: string;
}

export type RecordEventKind = 'created' | 'updated' | 'stage_changed' | 'deleted';
export interface RecordEvent {
  objectKey: string;
  recordId: string;
  kind: RecordEventKind;
  changes?: Record<string, [unknown, unknown]>;
  /** event originated from a workflow action (prevents automation loops) */
  fromAutomation?: boolean;
}

export interface ListQuery {
  q?: string;
  filters?: { field: string; op: string; value?: unknown }[];
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string | null;
  stageId?: string;
  pipelineId?: string;
  /** also return the total number of matching rows (capped at 10 000) */
  count?: boolean;
  /** restrict to these ids (bulk actions on a selection) */
  ids?: string[];
}

/** "$me" in a filter value means the signed-in user (e.g. owner_id eq $me for "My records"). */
function resolveFilterValue(v: unknown, userId: string): unknown {
  if (v === '$me') return userId;
  if (Array.isArray(v)) return v.map((x) => (x === '$me' ? userId : x));
  return v;
}

const GENERATED_COLUMNS = new Set(['full_name']);
const SYSTEM_SORTS = new Set(['created_at', 'updated_at']);

export class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return `"${s}"`;
};

export function getObject(meta: TenantMeta, key: string): ObjectMeta {
  const o = meta.objects.find((x) => x.key === key);
  if (!o) throw notFound(`Unknown object "${key}"`);
  return o;
}

function fieldMap(obj: ObjectMeta) {
  return new Map(obj.fields.map((f) => [f.key, f]));
}

/**
 * Row-level sharing predicate for own/team access: ownership, the reporting line, teams the user
 * leads, records shared with the user or their teams, and sharing rules that apply to them.
 */
function scopeSql(level: Access, p: Params, principal: Principal, objectKey: string, obj: ObjectMeta, action: 'read' | 'update' | 'delete'): string {
  if (level === 'all') return 'true';
  if (level !== 'own' && level !== 'team') return 'false';
  const u = p.add(principal.user.id);
  const parts = [`r.owner_id = ${u}::uuid`];
  if (level === 'team') {
    parts.push(`r.owner_id in (select m.id from users m where m.tenant_id = r.tenant_id and m.manager_id = ${u}::uuid)`);
    if (principal.leads?.length) {
      parts.push(`r.owner_id in (select tm.user_id from team_members tm where tm.tenant_id = r.tenant_id and tm.team_id = any(${p.add(principal.leads)}::uuid[]))`);
    }
  }
  if (action !== 'delete') {
    const teams = principal.teams ?? [];
    parts.push(
      `exists (select 1 from record_shares rs where rs.tenant_id = r.tenant_id and rs.object_key = ${p.add(objectKey)} and rs.record_id = r.id
         and (rs.user_id = ${u}::uuid${teams.length ? ` or rs.team_id = any(${p.add(teams)}::uuid[])` : ''})${action === 'update' ? ` and rs.access = 'edit'` : ''})`,
    );
    for (const rule of principal.shares ?? []) {
      if (rule.objectKey !== objectKey || (action === 'update' && rule.access !== 'edit')) continue;
      const trial = new Params();
      trial.values = [...p.values];
      try {
        const conds = rule.criteria.map((c) => {
          const f = obj.fields.find((x) => x.key === c.field);
          return f ? `(${filterSql(f, c.op, c.value, objectKey, trial)})` : 'false';
        });
        p.values = trial.values;
        parts.push(conds.length ? `(${conds.join(' and ')})` : 'true');
      } catch {
        /* a broken rule grants nothing (and leaves no parameters behind) */
      }
    }
  }
  return `(${parts.join(' or ')})`;
}

function fieldExprText(f: FieldDef): string {
  return f.standard ? `r.${ident(f.key)}::text` : `(r.custom ->> '${f.key}')`;
}

function abacSql(perms: EffectivePermissions, objectKey: string, obj: ObjectMeta, p: Params, principal: Principal): string {
  const groups = perms.conditions[objectKey];
  if (groups === null || groups === undefined) return 'true';
  if (groups.length === 0) return 'false';
  const fm = fieldMap(obj);
  const user = { id: principal.user.id, attributes: principal.user.attributes };
  const cond = (c: Condition): string => {
    const f = fm.get(c.field);
    if (!f) return 'false';
    const v = resolveConditionValue(c.value, user);
    if (v === null || v === undefined) return 'false';
    const expr = fieldExprText(f);
    if (c.op === 'in') {
      const arr = (Array.isArray(v) ? v : [v]).map(String);
      return `${expr} = any(${p.add(arr)}::text[])`;
    }
    if (c.op === 'neq') return `${expr} is distinct from ${p.add(String(v))}`;
    return `${expr} = ${p.add(String(v))}`;
  };
  return `(${groups.map((g) => `(${g.map(cond).join(' and ')})`).join(' or ')})`;
}

const castFor = (f: FieldDef) => {
  switch (valueType(f)) {
    case 'number':
    case 'currency':
    case 'percent':
      return 'numeric';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamptz';
    case 'boolean':
      return 'boolean';
    case 'lookup':
    case 'user':
      return 'uuid';
    default:
      return 'text';
  }
};

export function filterSql(f: FieldDef, op: string, value: unknown, objectKey: string, p: Params): string {
  const cast = castFor(f);
  const ops: Record<string, string> = { eq: '=', neq: 'is distinct from', gt: '>', gte: '>=', lt: '<', lte: '<=' };

  if (!f.standard && f.indexed && f.type !== 'multipicklist' && op !== 'is_null' && op !== 'not_null') {
    // use the typed EAV index
    const col = cast === 'numeric' ? 'v_num' : cast === 'timestamptz' || cast === 'date' ? 'v_date' : cast === 'boolean' ? 'v_bool' : 'v_text';
    const valCast = col === 'v_num' ? 'numeric' : col === 'v_date' ? 'timestamptz' : col === 'v_bool' ? 'boolean' : 'text';
    const base = `select 1 from record_index ri where ri.tenant_id = r.tenant_id and ri.object_key = ${p.add(objectKey)} and ri.field_key = ${p.add(f.key)} and ri.record_id = r.id`;
    const norm = (v: unknown) => (col === 'v_text' ? String(v).toLowerCase() : v);
    if (op === 'contains') return `exists (${base} and ri.v_text like ${p.add(`%${escapeLike(String(value).toLowerCase())}%`)})`;
    if (op === 'starts_with') return `exists (${base} and ri.v_text like ${p.add(`${escapeLike(String(value).toLowerCase())}%`)})`;
    if (op === 'in') return `exists (${base} and ri.${col} = any(${p.add((Array.isArray(value) ? value : [value]).map(norm))}::${valCast}[]))`;
    const sqlOp = ops[op];
    if (!sqlOp) throw badRequest(`Unsupported operator "${op}"`);
    if (op === 'neq') return `not exists (${base} and ri.${col} = ${p.add(norm(value))}::${valCast})`;
    return `exists (${base} and ri.${col} ${sqlOp} ${p.add(norm(value))}::${valCast})`;
  }

  let expr: string;
  if (f.standard) expr = `r.${ident(f.key)}`;
  else if (cast === 'numeric') expr = `app.try_numeric(r.custom ->> '${f.key}')`;
  else if (cast === 'timestamptz' || cast === 'date') expr = `app.try_timestamptz(r.custom ->> '${f.key}')`;
  else if (cast === 'boolean') expr = `app.try_boolean(r.custom ->> '${f.key}')`;
  else expr = `(r.custom ->> '${f.key}')`;
  const valueCast = !f.standard && cast === 'date' ? 'timestamptz' : !f.standard && cast === 'uuid' ? 'text' : cast;

  switch (op) {
    case 'is_null':
      return f.standard ? `${expr} is null` : `not (r.custom ? '${f.key}') or r.custom -> '${f.key}' = 'null'::jsonb`;
    case 'not_null':
      return f.standard ? `${expr} is not null` : `(r.custom ? '${f.key}' and r.custom -> '${f.key}' <> 'null'::jsonb)`;
    case 'contains':
      if (f.type === 'multipicklist') return `r.custom -> '${f.key}' ? ${p.add(String(value))}`;
      return `${expr}::text ilike ${p.add(`%${escapeLike(String(value))}%`)}`;
    case 'starts_with':
      return `${expr}::text ilike ${p.add(`${escapeLike(String(value))}%`)}`;
    case 'in':
      return `${expr} = any(${p.add(Array.isArray(value) ? value : [value])}::${valueCast}[])`;
    default: {
      const sqlOp = ops[op];
      if (!sqlOp) throw badRequest(`Unsupported operator "${op}"`);
      return `${expr} ${sqlOp} ${p.add(value)}::${valueCast}`;
    }
  }
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function baseWhere(objectKey: string, p: Params, tenantId: string): string {
  const s = storageFor(objectKey);
  let w = `r.tenant_id = ${p.add(tenantId)}::uuid and r.deleted_at is null`;
  if (s.discriminated) w += ` and r.object_key = ${p.add(objectKey)}`;
  return w;
}

/** Shapes a DB row into the API DTO, dropping hidden fields. */
export function toDto(obj: ObjectMeta, row: Record<string, unknown>, perms: EffectivePermissions): RecordDto {
  const s = storageFor(obj.key);
  const custom = (row.custom ?? {}) as Record<string, unknown>;
  const dto: RecordDto = {
    id: row.id as string,
    object: obj.key,
    title: String(row[s.titleColumn] ?? ''),
    version: row.version as number,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    created_by: row.created_by ?? null,
  };
  for (const f of obj.fields) {
    if (fieldAccess(perms, obj.key, f.key) === 'hidden') continue;
    let v = f.standard ? row[f.key] : custom[f.key];
    if (v instanceof Date) v = f.type === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
    if (f.standard && (f.type === 'currency' || f.type === 'number' || f.type === 'percent') && typeof v === 'string') v = Number(v);
    dto[f.key] = v ?? null;
  }
  if ('ai_score_reasons' in row && fieldAccess(perms, obj.key, 'ai_score') !== 'hidden') dto.ai_insights = row.ai_score_reasons ?? null;
  if ('ai_insights' in row) dto.ai_insights = row.ai_insights ?? null;
  return dto;
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number(atob(cursor));
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
}

/** Row-visibility predicates (base + sharing scope + ABAC) for any query over an object. */
export function visibilityWhere(ctx: RecordCtx, objectKey: string, p: Params): string[] {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const perm = objectPerm(perms, objectKey);
  if (perm.read === 'none') throw forbidden();
  return [baseWhere(objectKey, p, ctx.tenantId), scopeSql(perm.read, p, ctx.principal, objectKey, obj, 'read'), abacSql(perms, objectKey, obj, p, ctx.principal)];
}

export interface AggregateQuery {
  filters?: { field: string; op: string; value?: unknown }[];
  groupBy?: string | null;
  groupBy2?: string | null;
  dateBucket?: 'day' | 'week' | 'month' | 'quarter' | 'year' | null;
  measure: { agg: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | null };
  timezone?: string;
}

const SYSTEM_DATE_FIELDS: Record<string, FieldDef> = {
  created_at: { key: 'created_at', label: 'Created', type: 'datetime', standard: true },
  updated_at: { key: 'updated_at', label: 'Last updated', type: 'datetime', standard: true },
};

/** GROUP BY one or two fields with COUNT/SUM/AVG/MIN/MAX, under the same visibility rules as lists. */
export async function aggregateRecords(ctx: RecordCtx, objectKey: string, q: AggregateQuery) {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const s = storageFor(objectKey);
  const p = new Params();
  const where = visibilityWhere(ctx, objectKey, p);
  const fm = fieldMap(obj);
  const field = (k: string, purpose: string): FieldDef => {
    const def = fm.get(k) ?? SYSTEM_DATE_FIELDS[k];
    if (!def || fieldAccess(perms, objectKey, k) === 'hidden') throw badRequest(`Cannot ${purpose} "${k}"`);
    return def;
  };
  for (const f of q.filters ?? []) where.push(`(${filterSql(field(f.field, 'filter on'), f.op, resolveFilterValue(f.value, ctx.principal.user.id), objectKey, p)})`);

  let tzParam: string | null = null;
  const tz = () => (tzParam ??= p.add(/^[A-Za-z_]+\/[A-Za-z_]+$/.test(q.timezone ?? '') ? q.timezone : 'Asia/Kolkata'));
  const groupExpr = (k: string) => {
    const def = field(k, 'group by');
    const vt = valueType(def);
    if (vt === 'multipicklist' || vt === 'textarea') throw badRequest(`Cannot group by "${k}"`);
    if (vt === 'date' || vt === 'datetime') {
      const raw = def.standard ? `r.${ident(def.key)}::timestamptz` : `app.try_timestamptz(r.custom ->> '${def.key}')`;
      const bucket = q.dateBucket ?? 'month';
      if (!['day', 'week', 'month', 'quarter', 'year'].includes(bucket)) throw badRequest('Unknown date bucket');
      return `to_char(date_trunc('${bucket}', (${raw}) at time zone ${tz()}), 'YYYY-MM-DD')`;
    }
    if (vt === 'boolean') return def.standard ? `r.${ident(def.key)}::text` : `(r.custom ->> '${def.key}')`;
    return def.standard ? `r.${ident(def.key)}::text` : `(r.custom ->> '${def.key}')`;
  };
  let measure = 'count(*)';
  if (q.measure.agg !== 'count') {
    const def = field(q.measure.field ?? '', 'summarise');
    const vt = valueType(def);
    if (!['number', 'currency', 'percent'].includes(vt)) throw badRequest('Only number fields can be summed or averaged');
    const expr = def.standard ? `r.${ident(def.key)}::numeric` : `app.try_numeric(r.custom ->> '${def.key}')`;
    measure = `${q.measure.agg}(${expr})`;
  }
  const g1 = q.groupBy ? groupExpr(q.groupBy) : null;
  const g2 = q.groupBy && q.groupBy2 ? groupExpr(q.groupBy2) : null;
  const select = [g1 ? `${g1} as g1` : `null::text as g1`, g2 ? `${g2} as g2` : `null::text as g2`, `${measure}::float8 as value`, 'count(*)::int as n'];
  const groupBy = [g1 && 'g1', g2 && 'g2'].filter(Boolean);
  const sql = `select ${select.join(', ')} from ${ident(s.table)} r where ${where.join(' and ')}${groupBy.length ? ` group by ${groupBy.join(', ')} order by ${groupBy.join(', ')} nulls last` : ''} limit 1000`;
  const rows = await ctx.tx.query<{ g1: string | null; g2: string | null; value: number | null; n: number }>(sql, p.values);

  // human labels for ids (owners, stages, lookups) and picklist values
  const labels: Record<string, Record<string, string>> = {};
  for (const [k, col] of [[q.groupBy, 'g1'], [q.groupBy2, 'g2']] as const) {
    if (!k) continue;
    const def = fm.get(k);
    const ids = [...new Set(rows.map((r) => r[col]).filter((v): v is string => !!v))];
    const map: Record<string, string> = {};
    if (def?.key === 'stage_id' || def?.key === 'pipeline_id') {
      for (const pl of ctx.meta.pipelines) {
        map[pl.id] = pl.name;
        for (const st of pl.stages) map[st.id] = st.label;
      }
    } else if (def?.type === 'user' && ids.length) {
      for (const u of await ctx.tx.query<{ id: string; full_name: string }>(`select id, full_name from users where tenant_id = $1 and id::text = any($2::text[])`, [ctx.tenantId, ids])) map[u.id] = u.full_name;
    } else if (def?.type === 'lookup' && def.options?.lookupObject && ids.length) {
      const ts = storageFor(def.options.lookupObject);
      for (const r of await ctx.tx.query<{ id: string; t: string }>(`select id, ${ident(ts.titleColumn)} as t from ${ident(ts.table)} where tenant_id = $1 and id::text = any($2::text[])`, [ctx.tenantId, ids])) map[r.id] = r.t;
    } else if (def && (def.type === 'picklist' || def.type === 'multipicklist')) {
      for (const c of def.options?.choices ?? []) map[c.value] = c.label;
    } else if (def && valueType(def) === 'boolean') {
      map.true = 'Yes';
      map.false = 'No';
    }
    labels[col] = map;
  }
  return { rows, labels };
}

export async function listRecords(ctx: RecordCtx, objectKey: string, q: ListQuery) {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const perm = objectPerm(perms, objectKey);
  if (perm.read === 'none') throw forbidden();

  const s = storageFor(objectKey);
  const fm = fieldMap(obj);
  const p = new Params();
  const where: string[] = [baseWhere(objectKey, p, ctx.tenantId), scopeSql(perm.read, p, ctx.principal, objectKey, obj, 'read'), abacSql(perms, objectKey, obj, p, ctx.principal)];

  const visible = (k: string) => fieldAccess(perms, objectKey, k) !== 'hidden';

  if (q.q && q.q.trim()) {
    const cols = s.searchColumns.filter((c) => visible(c) || c === s.titleColumn);
    const term = p.add(`%${escapeLike(q.q.trim())}%`);
    where.push(`(${cols.map((c) => `r.${ident(c)} ilike ${term}`).join(' or ')})`);
  }
  if (q.pipelineId && s.hasPipeline) where.push(`r.pipeline_id = ${p.add(q.pipelineId)}::uuid`);
  if (q.stageId && s.hasPipeline) where.push(`r.stage_id = ${p.add(q.stageId)}::uuid`);

  for (const f of q.filters ?? []) {
    const def = fm.get(f.field);
    if (!def || !visible(f.field)) throw badRequest(`Cannot filter on "${f.field}"`);
    where.push(`(${filterSql(def, f.op, resolveFilterValue(f.value, ctx.principal.user.id), objectKey, p)})`);
  }
  if (q.ids?.length) where.push(`r.id = any(${p.add(q.ids)}::uuid[])`);

  let order = 'r.updated_at desc';
  if (q.sort) {
    const dir = q.dir === 'asc' ? 'asc' : 'desc';
    if (SYSTEM_SORTS.has(q.sort)) order = `r.${ident(q.sort)} ${dir}`;
    else {
      const def = fm.get(q.sort);
      if (!def || !visible(q.sort)) throw badRequest(`Cannot sort on "${q.sort}"`);
      const vt = valueType(def);
      const numeric = ['number', 'currency', 'percent'].includes(vt);
      const expr = def.standard ? `r.${ident(def.key)}` : numeric ? `app.try_numeric(r.custom ->> '${def.key}')` : ['date', 'datetime'].includes(vt) ? `app.try_timestamptz(r.custom ->> '${def.key}')` : `(r.custom ->> '${def.key}')`;
      order = `${expr} ${dir} nulls last`;
    }
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = decodeCursor(q.cursor);
  const sql = `select r.* from ${ident(s.table)} r where ${where.join(' and ')} order by ${order}, r.id limit ${limit + 1} offset ${offset}`;
  const rows = await ctx.tx.query(sql, p.values);
  const more = rows.length > limit;
  let total: number | undefined;
  if (q.count) {
    const c = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from (select 1 from ${ident(s.table)} r where ${where.join(' and ')} limit 10000) x`, p.values);
    total = c?.n ?? 0;
  }
  return {
    items: rows.slice(0, limit).map((r) => toDto(obj, r, perms)),
    nextCursor: more ? btoa(String(offset + limit)) : null,
    ...(total !== undefined ? { total } : {}),
  };
}

export async function loadRow(ctx: RecordCtx, objectKey: string, id: string, action: 'read' | 'update' | 'delete', lock = false) {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const level = objectPerm(perms, objectKey)[action];
  if (level === 'none') throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const s = storageFor(objectKey);
  const p = new Params();
  const where = [baseWhere(objectKey, p, ctx.tenantId), `r.id = ${p.add(id)}::uuid`, scopeSql(level, p, ctx.principal, objectKey, obj, action), abacSql(perms, objectKey, obj, p, ctx.principal)];
  const row = await ctx.tx.one(`select r.* from ${ident(s.table)} r where ${where.join(' and ')}${lock ? ' for update' : ''}`, p.values);
  if (!row) throw notFound();
  return { obj, row };
}

export async function getRecord(ctx: RecordCtx, objectKey: string, id: string) {
  const { obj, row } = await loadRow(ctx, objectKey, id, 'read');
  return toDto(obj, row, ctx.principal.permissions);
}

interface Prepared {
  columns: Record<string, unknown>;
  custom: Record<string, unknown>;
}

/** A value nobody can mistake for a slug of another script: picks a stable id for labels with no a-z/0-9 (e.g. Hindi). */
function newChoiceValue(label: string, taken: Set<string>) {
  let v = choiceValue(label);
  if (!v) {
    let h = 2166136261;
    for (const ch of label.trim()) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v = `opt_${h.toString(36)}`;
  }
  let out = v;
  for (let i = 2; taken.has(out); i++) out = `${v}_${i}`;
  return out;
}

/**
 * Picklists people may extend ("Other…" and a typed value): a value that isn't one of the choices is
 * taken as the label of a new choice, added to the field for everyone, and stored as its value. A typed
 * label matching an existing choice (any case) uses that choice.
 */
async function typedChoices(ctx: RecordCtx, obj: ObjectMeta, f: FieldDef, value: unknown): Promise<unknown> {
  const choices = (f.options?.choices ?? []) as PicklistChoice[];
  const added: PicklistChoice[] = [];
  const resolve = (v: unknown) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (!t || choices.some((c) => c.value === v)) return v;
    const hit = findChoice([...choices, ...added], t);
    if (hit) return hit.value;
    if (t.length > 80) return v; // left for validation to refuse
    const c = { value: newChoiceValue(t, new Set([...choices, ...added].map((x) => x.value))), label: t.replace(/\s+/g, ' ') };
    added.push(c);
    return c.value;
  };
  const out = Array.isArray(value) ? value.map(resolve) : resolve(value);
  if (!added.length) return out;
  if (choices.length + added.length > 500) throw badRequest('Validation failed', [{ field: f.key, message: 'this list has too many choices; ask an admin to tidy it in Objects & fields' }]);
  const json = JSON.stringify(added);
  if (f.standard)
    await ctx.tx.query(
      `update custom_objects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('extraChoices',
          coalesce(settings -> 'extraChoices', '{}'::jsonb) || jsonb_build_object($3::text, coalesce(settings -> 'extraChoices' -> $3::text, '[]'::jsonb) || $4::jsonb))
        where tenant_id = $1 and key = $2`,
      [ctx.tenantId, obj.key, f.key, json],
    );
  else
    await ctx.tx.query(
      `update custom_fields set options = coalesce(options, '{}'::jsonb) || jsonb_build_object('choices', coalesce(options -> 'choices', '[]'::jsonb) || $4::jsonb)
        where tenant_id = $1 and object_key = $2 and key = $3`,
      [ctx.tenantId, obj.key, f.key, json],
    );
  // later values in this request (an import, say) see the new choices too
  f.options = { ...f.options, choices: [...choices, ...added] };
  return out;
}

async function prepareValues(ctx: RecordCtx, obj: ObjectMeta, input: Record<string, unknown>, mode: 'create' | 'update', bypassFls: boolean, fixedChoices = false): Promise<Prepared> {
  const fm = fieldMap(obj);
  const out: Prepared = { columns: {}, custom: {} };
  const errors: { field: string; message: string }[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (!KEY_PATTERN.test(key)) {
      errors.push({ field: key, message: 'unknown field' });
      continue;
    }
    const f = fm.get(key);
    if (!f) {
      errors.push({ field: key, message: 'unknown field' });
      continue;
    }
    if (f.readOnly || GENERATED_COLUMNS.has(f.key)) {
      errors.push({ field: key, message: 'field is read-only' });
      continue;
    }
    if (!bypassFls && fieldAccess(ctx.principal.permissions, obj.key, key) !== 'edit') {
      errors.push({ field: key, message: 'you cannot edit this field' });
      continue;
    }
    let value = raw === '' && f.type !== 'text' && f.type !== 'textarea' ? null : raw;
    if (!fixedChoices && choicesAddable(f) && value !== null && value !== undefined) value = await typedChoices(ctx, obj, f, value);
    const parsed = valueSchema(f).safeParse(value);
    if (!parsed.success) {
      errors.push({ field: key, message: parsed.error.issues[0]?.message ?? 'invalid value' });
      continue;
    }
    if (f.required && isEmpty(parsed.data)) {
      errors.push({ field: key, message: 'is required' });
      continue;
    }
    if (f.standard) out.columns[key] = parsed.data;
    else out.custom[key] = parsed.data;
  }
  if (mode === 'create') {
    for (const f of obj.fields) {
      if (f.required && !f.readOnly && isEmpty(input[f.key])) errors.push({ field: f.key, message: 'is required' });
    }
  }
  if (errors.length) throw badRequest('Validation failed', errors);

  // custom lookup integrity (standard lookups are enforced by composite FKs)
  for (const f of obj.fields) {
    if (f.standard || (f.type !== 'lookup' && f.type !== 'user')) continue;
    const v = out.custom[f.key];
    if (isEmpty(v)) continue;
    const target = f.type === 'user' ? 'user' : f.options?.lookupObject;
    if (!target) continue;
    const exists =
      target === 'user'
        ? await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2::uuid`, [ctx.tenantId, v])
        : await ctx.tx.one(
            `select 1 from ${ident(storageFor(target).table)} where tenant_id = $1 and id = $2::uuid and deleted_at is null${storageFor(target).discriminated ? ' and object_key = $3' : ''}`,
            storageFor(target).discriminated ? [ctx.tenantId, v, target] : [ctx.tenantId, v],
          );
    if (!exists) throw badRequest('Validation failed', [{ field: f.key, message: 'referenced record not found' }]);
  }
  return out;
}

function pipelinesFor(meta: TenantMeta, objectKey: string): PipelineMeta[] {
  return meta.pipelines.filter((p) => p.objectKey === objectKey);
}

function resolveStage(meta: TenantMeta, objectKey: string, pipelineId: unknown, stageId: unknown) {
  const pipes = pipelinesFor(meta, objectKey);
  if (!pipes.length) return null;
  if (stageId) {
    for (const p of pipes) {
      const st = p.stages.find((s) => s.id === stageId);
      if (st) {
        if (pipelineId && pipelineId !== p.id) throw badRequest('Stage does not belong to the selected pipeline');
        return { pipeline: p, stage: st };
      }
    }
    throw badRequest('Unknown stage');
  }
  const pipe = pipelineId ? pipes.find((p) => p.id === pipelineId) : (pipes.find((p) => p.isDefault) ?? pipes[0]);
  if (!pipe) throw badRequest('Unknown pipeline');
  const first = pipe.stages.find((s) => s.category === 'open') ?? pipe.stages[0];
  if (!first) throw badRequest('Pipeline has no stages');
  return { pipeline: pipe, stage: first };
}

export async function createRecord(
  ctx: RecordCtx,
  objectKey: string,
  input: Record<string, unknown>,
  /** fixedChoices: picklist values must be existing choices (public web forms: visitors don't add to your lists) */
  opts: { bypassPermissions?: boolean; fromAutomation?: boolean; autoAssign?: boolean; viaService?: boolean; fixedChoices?: boolean } = {},
): Promise<{ record: RecordDto; events: RecordEvent[] }> {
  const obj = getObject(ctx.meta, objectKey);
  // money documents that post to the ledger are created only through their own service
  if (SERVICE_ONLY.has(objectKey) && !opts.viaService) throw badRequest(`${obj.plural} are recorded from their own screen (they post to the books), not as plain records`);
  if (!opts.bypassPermissions && !objectPerm(ctx.principal.permissions, objectKey).create) throw forbidden();
  const s = storageFor(objectKey);
  const prepared = await prepareValues(ctx, obj, input, 'create', !!opts.bypassPermissions, !!opts.fixedChoices);
  const cols = prepared.columns;
  let assignedBy: string | null = null;
  if (opts.autoAssign) {
    // assignment rules see the record as entered (owner still unset)
    const pick = await pickAssignee(ctx, objectKey, withStage(ctx.meta, { ...cols, ...prepared.custom }));
    if (pick) {
      cols.owner_id = pick.userId;
      assignedBy = pick.rule;
    }
  }
  if (cols.owner_id === undefined || cols.owner_id === null && opts.autoAssign) cols.owner_id = ctx.principal.user.id;
  if (objectKey === 'lead' && cols.owner_id) cols.assigned_at = new Date().toISOString();

  if (s.hasPipeline) {
    const r = resolveStage(ctx.meta, objectKey, cols.pipeline_id, cols.stage_id);
    if (r) {
      cols.pipeline_id = r.pipeline.id;
      cols.stage_id = r.stage.id;
      if (objectKey === 'deal') {
        if (cols.probability === undefined || cols.probability === null) cols.probability = r.stage.probability;
        if (r.stage.category !== 'open') cols.closed_at = new Date().toISOString();
      }
    } else if (objectKey === 'deal') {
      throw badRequest('No pipeline configured for deals');
    }
  }

  const numbering = NUMBERED[objectKey];
  if (numbering && !cols[numbering.column]) {
    cols[numbering.column] = await nextDocumentNumber(ctx, objectKey);
    // the customer link exists from the start (so templates can include it); it only resolves once sent
    if (['quote', 'shipment', 'installation', 'ticket'].includes(objectKey)) cols.share_token = randomToken(24);
  }
  await beforeCreate(ctx, objectKey, cols);
  if (objectKey === 'expense' && cols.project_id) await (await import('./projects')).projectAccess(ctx, String(cols.project_id), 'member');
  if ((objectKey === 'sales_order' || objectKey === 'purchase_order') && cols.warehouse_id === undefined) {
    const wh = await ctx.tx.one<{ id: string }>(`select id from warehouses where tenant_id = $1 and is_default and is_active`, [ctx.tenantId]);
    if (wh) cols.warehouse_id = wh.id;
  }
  // formulas, field dependencies and validation rules see the complete new record
  const values = withStage(ctx.meta, { ...cols, ...prepared.custom });
  if (obj.fields.some(isComputed)) Object.assign(prepared.custom, computeFormulas(obj, values, ctx.principal.user.id));
  if (!opts.fromAutomation) throwIfIssues(evaluateRules(obj, values, null, null, ctx.principal.user.id));
  if (obj.fields.some((f) => f.key === 'score' && f.standard)) {
    const sc = computeScore(ctx, objectKey, values);
    if (sc) {
      cols.score = sc.score;
      cols.rating = sc.rating;
    }
  }

  const p = new Params();
  const names: string[] = [];
  const vals: string[] = [];
  const push = (name: string, v: unknown, cast = '') => {
    names.push(ident(name));
    vals.push(`${p.add(v)}${cast}`);
  };
  push('tenant_id', ctx.tenantId, '::uuid');
  if (s.discriminated) push('object_key', objectKey);
  for (const [k, v] of Object.entries(cols)) push(k, v);
  push('custom', JSON.stringify(stripNulls(prepared.custom)), '::jsonb');
  let row = await ctx.tx.one(`insert into ${ident(s.table)} (${names.join(', ')}) values (${vals.join(', ')}) returning *`, p.values);
  if (obj.fields.some((f) => f.type === 'rollup') && (await recomputeRecord(ctx, objectKey, row!.id as string))) row = await readRowSystem(ctx, objectKey, row!.id as string);
  if (hasRollupParents(ctx.meta, objectKey)) await refreshParents(ctx, objectKey, [row]);
  const record = toDto(obj, row!, ctx.principal.permissions);
  await notifyOwner(ctx, objectKey, record.id, row!.owner_id, record.title, assignedBy ? `Assignment rule: ${assignedBy}` : undefined);
  return { record, events: [{ objectKey, recordId: record.id, kind: 'created', fromAutomation: !!opts.fromAutomation }] };
}

/** Header fields frozen once a document leaves draft (stock, tax and the counterparty depend on them). */
/** Created only by their service (it posts the ledger entry); generic create, import and merge are refused. */
export const SERVICE_ONLY = new Set(['payment', 'vendor_payment']);
/** Financial documents that are never merged (merging would soft-delete posted entries). */
export const NO_MERGE = new Set(['invoice', 'payment', 'bill', 'vendor_payment', 'expense', 'work_order', 'job_work']);

const LOCKED_AFTER_DRAFT: Record<string, string[]> = {
  payment: ['account_id', 'sales_order_id', 'amount', 'payment_date', 'mode', 'tds_amount', 'bank_charges'],
  vendor_payment: ['vendor_id', 'amount', 'payment_date', 'mode'],
  sales_order: ['warehouse_id', 'account_id', 'currency'],
  purchase_order: ['vendor_id', 'warehouse_id', 'currency'],
  invoice: ['account_id', 'currency', 'place_of_supply', 'invoice_date', 'reverse_charge', 'contact_id', 'shipping_address', 'customer_ref', 'customer_ref_date'],
  work_order: ['product_id', 'bom_id', 'quantity', 'warehouse_id', 'sales_order_id'],
  job_work: ['vendor_id', 'output_product_id', 'output_qty', 'warehouse_id', 'rate'],
  bill: ['vendor_id', 'vendor_ref', 'bill_date', 'currency', 'exchange_rate', 'place_of_supply', 'reverse_charge', 'itc_eligible', 'tds_section', 'tds_rate', 'purchase_order_id'],
};
/** Documents that drive stock or customer commitments can only be deleted in these states. */
const DELETABLE_IN: Record<string, string[]> = {
  sales_order: ['draft', 'cancelled'],
  purchase_order: ['draft', 'cancelled'],
  shipment: ['planned', 'cancelled'],
  installation: ['scheduled', 'cancelled'],
  invoice: ['draft'],
  payment: ['void'],
  bill: ['draft', 'void'],
  vendor_payment: ['void'],
  expense: ['draft', 'rejected', 'void'],
  work_order: ['draft', 'cancelled'],
  job_work: ['draft', 'cancelled'],
};

function stripNulls(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

export async function updateRecord(
  ctx: RecordCtx,
  objectKey: string,
  id: string,
  patch: Record<string, unknown>,
  opts: { expectedVersion?: number; bypassPermissions?: boolean; fromAutomation?: boolean } = {},
): Promise<{ record: RecordDto; events: RecordEvent[] }> {
  const { obj, row } = opts.bypassPermissions ? await loadRowSystem(ctx, objectKey, id) : await loadRow(ctx, objectKey, id, 'update', true);
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
    throw conflict('Record was modified by someone else', { currentVersion: row.version });
  }
  const s = storageFor(objectKey);
  const prepared = await prepareValues(ctx, obj, patch, 'update', !!opts.bypassPermissions);
  const cols = prepared.columns;
  const lock = LOCKED_AFTER_DRAFT[objectKey];
  if (lock && row.status !== 'draft') {
    for (const f of lock) if (cols[f] !== undefined && String(cols[f] ?? '') !== String(row[f] ?? '')) throw badRequest(`${obj.fields.find((x) => x.key === f)?.label ?? f} cannot change once the ${obj.label.toLowerCase()} is ${String(row.status).replace(/_/g, ' ')}`);
  }

  const events: RecordEvent[] = [];
  let stageChanged: { from: unknown; to: unknown; label: string } | null = null;
  if (s.hasPipeline && (cols.stage_id !== undefined || cols.pipeline_id !== undefined)) {
    const r = resolveStage(ctx.meta, objectKey, cols.pipeline_id ?? (cols.stage_id ? undefined : row.pipeline_id), cols.stage_id);
    if (r) {
      cols.pipeline_id = r.pipeline.id;
      cols.stage_id = r.stage.id;
      if (r.stage.id !== row.stage_id) {
        stageChanged = { from: row.stage_id, to: r.stage.id, label: r.stage.label };
        if (objectKey === 'deal') {
          if (patch.probability === undefined) cols.probability = r.stage.probability;
          cols.closed_at = r.stage.category === 'open' ? null : new Date().toISOString();
        }
      }
    }
  }

  const prior = rowValues(ctx.meta, obj, row);
  const values = withStage(ctx.meta, { ...prior, ...cols, ...prepared.custom });
  if (obj.fields.some(isComputed)) Object.assign(prepared.custom, computeFormulas(obj, values, ctx.principal.user.id));
  if (!opts.fromAutomation) throwIfIssues(evaluateRules(obj, values, prior, new Set(Object.keys(patch)), ctx.principal.user.id));
  if (obj.fields.some((f) => f.key === 'score' && f.standard)) {
    const sc = computeScore(ctx, objectKey, values);
    if (sc && (sc.score !== row.score || sc.rating !== row.rating)) {
      cols.score = sc.score;
      cols.rating = sc.rating;
    }
  }
  await beforeUpdate(ctx, objectKey, row, cols);
  if (objectKey === 'expense' && cols.project_id && cols.project_id !== row.project_id) await (await import('./projects')).projectAccess(ctx, String(cols.project_id), 'member');
  const ownerChanged = cols.owner_id !== undefined && cols.owner_id !== row.owner_id;
  if (ownerChanged && objectKey === 'lead') cols.assigned_at = new Date().toISOString();
  if (objectKey === 'lead' && cols.next_follow_up_at !== undefined && String(cols.next_follow_up_at) !== String(row.next_follow_up_at ?? '')) cols.follow_up_reminded_at = null;

  const oldCustom = (row.custom ?? {}) as Record<string, unknown>;
  const newCustom = stripNulls({ ...oldCustom, ...prepared.custom });

  const changes: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(cols)) if (String(row[k] ?? '') !== String(v ?? '')) changes[k] = [row[k] ?? null, v ?? null];
  for (const k of Object.keys(prepared.custom)) if (JSON.stringify(oldCustom[k] ?? null) !== JSON.stringify(newCustom[k] ?? null)) changes[k] = [oldCustom[k] ?? null, newCustom[k] ?? null];

  if (!Object.keys(changes).length) return { record: toDto(obj, row, ctx.principal.permissions), events: [] };

  const p = new Params();
  const sets = Object.entries(cols).map(([k, v]) => `${ident(k)} = ${p.add(v)}`);
  sets.push(`custom = ${p.add(JSON.stringify(newCustom))}::jsonb`);
  const updated = await ctx.tx.one(
    `update ${ident(s.table)} r set ${sets.join(', ')} where r.tenant_id = ${p.add(ctx.tenantId)}::uuid and r.id = ${p.add(id)}::uuid returning *`,
    p.values,
  );
  if (hasRollupParents(ctx.meta, objectKey)) await refreshParents(ctx, objectKey, [row, updated]);
  if (ownerChanged) await notifyOwner(ctx, objectKey, id, cols.owner_id, String(updated![storageFor(objectKey).titleColumn] ?? ''));

  if (stageChanged) {
    await ctx.tx.query(
      `insert into activities (tenant_id, kind, subject, related_object, related_id, metadata) values ($1, 'stage_change', $2, $3, $4, $5)`,
      [ctx.tenantId, `Moved to ${stageChanged.label}`, objectKey, id, JSON.stringify({ from: stageChanged.from, to: stageChanged.to })],
    );
    events.push({ objectKey, recordId: id, kind: 'stage_changed', changes, fromAutomation: !!opts.fromAutomation });
  }
  events.push({ objectKey, recordId: id, kind: 'updated', changes, fromAutomation: !!opts.fromAutomation });
  return { record: toDto(obj, updated!, ctx.principal.permissions), events };
}

async function loadRowSystem(ctx: RecordCtx, objectKey: string, id: string) {
  const obj = getObject(ctx.meta, objectKey);
  const s = storageFor(objectKey);
  const p = new Params();
  const row = await ctx.tx.one(`select r.* from ${ident(s.table)} r where ${baseWhere(objectKey, p, ctx.tenantId)} and r.id = ${p.add(id)}::uuid for update`, p.values);
  if (!row) throw notFound();
  return { obj, row };
}

export async function deleteRecord(ctx: RecordCtx, objectKey: string, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, objectKey, id, 'delete', true);
  const s = storageFor(objectKey);
  const deletable = DELETABLE_IN[objectKey];
  if (deletable && !deletable.includes(String(row.status))) throw badRequest(`Cancel it first; only ${deletable.join(' or ')} records can be deleted`);
  if (objectKey === 'project') {
    const used = await ctx.tx.one(
      `select 1 where exists (select 1 from time_entries where tenant_id = $1 and project_id = $2 and status in ('approved','invoiced'))
                   or exists (select 1 from invoices where tenant_id = $1 and project_id = $2 and status <> 'cancelled' and deleted_at is null)`,
      [ctx.tenantId, id],
    );
    if (used) throw badRequest('This project has approved time or invoices; mark it completed or cancelled instead');
  }
  await ctx.tx.query(`update ${ident(s.table)} set deleted_at = now() where tenant_id = $1 and id = $2::uuid`, [ctx.tenantId, id]);
  if (objectKey === 'invoice') await releaseInvoice(ctx.tx, ctx.tenantId, id);
  if (hasRollupParents(ctx.meta, objectKey)) await refreshParents(ctx, objectKey, [row]);
  return [{ objectKey, recordId: id, kind: 'deleted' }];
}

/** Raw row for internal consumers (AI, workflows) — permission checks are the caller's job. */
export async function readRowSystem(ctx: RecordCtx, objectKey: string, id: string) {
  const s = storageFor(objectKey);
  const p = new Params();
  return ctx.tx.one(`select r.* from ${ident(s.table)} r where ${baseWhere(objectKey, p, ctx.tenantId)} and r.id = ${p.add(id)}::uuid`, p.values);
}

/** Lead → Contact (+ Account) (+ Deal). */
export async function convertLead(
  ctx: RecordCtx,
  leadId: string,
  opts: { createDeal: boolean; dealName?: string; amount?: number; accountId?: string },
) {
  const { row: lead } = await loadRow(ctx, 'lead', leadId, 'update', true);
  if (lead.converted_at) throw conflict('Lead is already converted');
  const events: RecordEvent[] = [];
  let accountId = opts.accountId ?? null;
  if (!accountId && lead.company) {
    const acc = await createRecord(ctx, 'account', { name: lead.company, owner_id: lead.owner_id ?? ctx.principal.user.id });
    accountId = acc.record.id;
    events.push(...acc.events);
  }
  const contact = await createRecord(ctx, 'contact', {
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email,
    phone: lead.phone,
    account_id: accountId,
    owner_id: lead.owner_id ?? ctx.principal.user.id,
  });
  events.push(...contact.events);
  await ctx.tx.query(`update contacts set consent = $1 where tenant_id = $2 and id = $3`, [JSON.stringify(lead.consent ?? {}), ctx.tenantId, contact.record.id]);

  let dealId: string | null = null;
  if (opts.createDeal) {
    const deal = await createRecord(ctx, 'deal', {
      name: opts.dealName || `${lead.company ?? lead.full_name} – opportunity`,
      account_id: accountId,
      contact_id: contact.record.id,
      amount: opts.amount ?? null,
      owner_id: lead.owner_id ?? ctx.principal.user.id,
    });
    dealId = deal.record.id;
    events.push(...deal.events);
  }

  const wonStage = pipelinesFor(ctx.meta, 'lead')
    .find((p) => p.id === lead.pipeline_id)
    ?.stages.find((s) => s.category === 'won');
  await ctx.tx.query(
    `update leads set converted_at = now(), converted_contact_id = $3, converted_account_id = $4, converted_deal_id = $5,
            stage_id = coalesce($6::uuid, stage_id)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, leadId, contact.record.id, accountId, dealId, wonStage?.id ?? null],
  );
  await ctx.tx.query(
    `insert into activities (tenant_id, kind, subject, related_object, related_id, metadata) values ($1, 'system', 'Lead converted', 'lead', $2, $3)`,
    [ctx.tenantId, leadId, JSON.stringify({ contactId: contact.record.id, accountId, dealId })],
  );
  events.push({ objectKey: 'lead', recordId: leadId, kind: 'updated', changes: { converted_at: [null, new Date().toISOString()] } });
  return { contactId: contact.record.id, accountId, dealId, events };
}

/** Permission-aware aggregates for the home dashboard. */
export async function dashboardStats(ctx: RecordCtx) {
  const perms = ctx.principal.permissions;
  const out: Record<string, unknown> = {};
  const scoped = (objectKey: string) => {
    const perm = objectPerm(perms, objectKey);
    if (perm.read === 'none' || !ctx.meta.objects.some((o) => o.key === objectKey)) return null;
    const p = new Params();
    const obj = getObject(ctx.meta, objectKey);
    const where = [baseWhere(objectKey, p, ctx.tenantId), scopeSql(perm.read, p, ctx.principal, objectKey, obj, 'read'), abacSql(perms, objectKey, obj, p, ctx.principal)].join(' and ');
    return { p, where };
  };

  const deals = scoped('deal');
  if (deals) {
    const canSeeAmount = fieldAccess(perms, 'deal', 'amount') !== 'hidden';
    out.dealsByStage = await ctx.tx.query(
      `select r.stage_id, count(*)::int as count, ${canSeeAmount ? 'coalesce(sum(r.amount),0)::float8' : 'null'} as amount
         from deals r where ${deals.where} group by r.stage_id`,
      deals.p.values,
    );
    const won = scoped('deal')!;
    out.wonThisMonth = await ctx.tx.one(
      `select count(*)::int as count, ${canSeeAmount ? 'coalesce(sum(r.amount),0)::float8' : 'null'} as amount
         from deals r join pipeline_stages s on s.tenant_id = r.tenant_id and s.id = r.stage_id
        where ${won.where} and s.category = 'won' and r.closed_at >= date_trunc('month', now())`,
      won.p.values,
    );
  }
  const leads = scoped('lead');
  if (leads) {
    out.leads = await ctx.tx.one(
      `select count(*) filter (where r.converted_at is null)::int as open,
              count(*) filter (where r.created_at > now() - interval '7 days')::int as new_7d,
              count(*) filter (where r.ai_score >= 70 and r.converted_at is null)::int as hot
         from leads r where ${leads.where}`,
      leads.p.values,
    );
    const top = scoped('lead')!;
    const rows = await ctx.tx.query(
      `select r.* from leads r where ${top.where} and r.converted_at is null and r.ai_score is not null order by r.ai_score desc limit 5`,
      top.p.values,
    );
    out.hotLeads = rows.map((r) => toDto(getObject(ctx.meta, 'lead'), r, perms));
  }
  out.tasks = await ctx.tx.one(
    `select count(*) filter (where status in ('open','in_progress') and due_at < now())::int as overdue,
            count(*) filter (where status in ('open','in_progress') and due_at::date = current_date)::int as due_today,
            count(*) filter (where status in ('open','in_progress'))::int as open
       from tasks where tenant_id = $1 and assignee_id = $2`,
    [ctx.tenantId, ctx.principal.user.id],
  );
  return out;
}
