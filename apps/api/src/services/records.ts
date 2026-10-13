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
  storageFor,
  valueSchema,
} from '@synapse/shared';
import type { Principal } from '../env';
import type { Tx } from '../lib/db';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';

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
}

const GENERATED_COLUMNS = new Set(['full_name']);
const SYSTEM_SORTS = new Set(['created_at', 'updated_at']);

class Params {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

const ident = (s: string) => {
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

function scopeSql(level: Access, p: Params, userId: string): string {
  switch (level) {
    case 'all':
      return 'true';
    case 'own':
      return `r.owner_id = ${p.add(userId)}::uuid`;
    case 'team': {
      const u = p.add(userId);
      return `(r.owner_id = ${u}::uuid or r.owner_id in (select m.id from users m where m.tenant_id = r.tenant_id and m.manager_id = ${u}::uuid))`;
    }
    default:
      return 'false';
  }
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
  switch (f.type) {
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

function filterSql(f: FieldDef, op: string, value: unknown, objectKey: string, p: Params): string {
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
  const valueCast = !f.standard && cast === 'date' ? 'timestamptz' : cast;

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

export async function listRecords(ctx: RecordCtx, objectKey: string, q: ListQuery) {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const perm = objectPerm(perms, objectKey);
  if (perm.read === 'none') throw forbidden();

  const s = storageFor(objectKey);
  const fm = fieldMap(obj);
  const p = new Params();
  const where: string[] = [baseWhere(objectKey, p, ctx.tenantId), scopeSql(perm.read, p, ctx.principal.user.id), abacSql(perms, objectKey, obj, p, ctx.principal)];

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
    where.push(`(${filterSql(def, f.op, f.value, objectKey, p)})`);
  }

  let order = 'r.updated_at desc';
  if (q.sort) {
    const dir = q.dir === 'asc' ? 'asc' : 'desc';
    if (SYSTEM_SORTS.has(q.sort)) order = `r.${ident(q.sort)} ${dir}`;
    else {
      const def = fm.get(q.sort);
      if (!def || !visible(q.sort)) throw badRequest(`Cannot sort on "${q.sort}"`);
      const numeric = ['number', 'currency', 'percent'].includes(def.type);
      const expr = def.standard ? `r.${ident(def.key)}` : numeric ? `app.try_numeric(r.custom ->> '${def.key}')` : `(r.custom ->> '${def.key}')`;
      order = `${expr} ${dir} nulls last`;
    }
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = decodeCursor(q.cursor);
  const sql = `select r.* from ${ident(s.table)} r where ${where.join(' and ')} order by ${order}, r.id limit ${limit + 1} offset ${offset}`;
  const rows = await ctx.tx.query(sql, p.values);
  const more = rows.length > limit;
  return {
    items: rows.slice(0, limit).map((r) => toDto(obj, r, perms)),
    nextCursor: more ? btoa(String(offset + limit)) : null,
  };
}

async function loadRow(ctx: RecordCtx, objectKey: string, id: string, action: 'read' | 'update' | 'delete', lock = false) {
  const obj = getObject(ctx.meta, objectKey);
  const perms = ctx.principal.permissions;
  const level = objectPerm(perms, objectKey)[action];
  if (level === 'none') throw forbidden();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const s = storageFor(objectKey);
  const p = new Params();
  const where = [baseWhere(objectKey, p, ctx.tenantId), `r.id = ${p.add(id)}::uuid`, scopeSql(level, p, ctx.principal.user.id), abacSql(perms, objectKey, obj, p, ctx.principal)];
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

async function prepareValues(ctx: RecordCtx, obj: ObjectMeta, input: Record<string, unknown>, mode: 'create' | 'update', bypassFls: boolean): Promise<Prepared> {
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
    const value = raw === '' && f.type !== 'text' && f.type !== 'textarea' ? null : raw;
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
  opts: { bypassPermissions?: boolean; fromAutomation?: boolean } = {},
): Promise<{ record: RecordDto; events: RecordEvent[] }> {
  const obj = getObject(ctx.meta, objectKey);
  if (!opts.bypassPermissions && !objectPerm(ctx.principal.permissions, objectKey).create) throw forbidden();
  const s = storageFor(objectKey);
  const prepared = await prepareValues(ctx, obj, input, 'create', !!opts.bypassPermissions);
  const cols = prepared.columns;
  if (cols.owner_id === undefined) cols.owner_id = ctx.principal.user.id;

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
  const row = await ctx.tx.one(`insert into ${ident(s.table)} (${names.join(', ')}) values (${vals.join(', ')}) returning *`, p.values);
  const record = toDto(obj, row!, ctx.principal.permissions);
  return { record, events: [{ objectKey, recordId: record.id, kind: 'created', fromAutomation: !!opts.fromAutomation }] };
}

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
  await loadRow(ctx, objectKey, id, 'delete', true);
  const s = storageFor(objectKey);
  await ctx.tx.query(`update ${ident(s.table)} set deleted_at = now() where tenant_id = $1 and id = $2::uuid`, [ctx.tenantId, id]);
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
    const where = [baseWhere(objectKey, p, ctx.tenantId), scopeSql(perm.read, p, ctx.principal.user.id), abacSql(perms, objectKey, obj, p, ctx.principal)].join(' and ');
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
