/**
 * Data & views: related records, duplicate detection and merge, bulk actions, CSV import/export.
 * Everything goes through the record service, so RBAC, ABAC, field-level security and validation
 * apply exactly as they do for single-record edits.
 */
import { type FieldDef, type ObjectMeta, fieldAccess, objectPerm, storageFor } from '@synapse/shared';
import { badRequest, forbidden } from '../lib/errors';
import { hasRollupParents, recomputeRecord, refreshParents } from './computed';
import { createRecord, deleteRecord, getObject, listRecords, loadRow, NO_MERGE, type RecordCtx, type RecordEvent, updateRecord } from './records';

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return `"${s}"`;
};

/** Runs fn inside a savepoint so one bad row doesn't abort the surrounding transaction. */
export async function savepoint<T>(ctx: RecordCtx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; details?: unknown }> {
  await ctx.tx.query('savepoint row_sp');
  try {
    const value = await fn();
    await ctx.tx.query('release savepoint row_sp');
    return { ok: true, value };
  } catch (e) {
    await ctx.tx.query('rollback to savepoint row_sp');
    const err = e as Error & { details?: unknown };
    return { ok: false, error: err.message, details: err.details };
  }
}

// ------------------------------------------------------------------------------------- related
export interface RelatedGroup {
  object: string;
  label: string;
  field: string;
  fieldLabel: string;
  total: number;
  items: { id: string; title: string; [k: string]: unknown }[];
}

/** Every object with a lookup field pointing at this object becomes a related list. */
export async function relatedRecords(ctx: RecordCtx, objectKey: string, id: string): Promise<RelatedGroup[]> {
  await loadRow(ctx, objectKey, id, 'read');
  const groups: RelatedGroup[] = [];
  for (const o of ctx.meta.objects) {
    if (objectPerm(ctx.principal.permissions, o.key).read === 'none') continue;
    for (const f of o.fields) {
      if (f.type !== 'lookup' || f.options?.lookupObject !== objectKey) continue;
      if (fieldAccess(ctx.principal.permissions, o.key, f.key) === 'hidden') continue;
      const r = await listRecords(ctx, o.key, { filters: [{ field: f.key, op: 'eq', value: id }], limit: 10, count: true });
      if (!r.items.length) continue;
      groups.push({ object: o.key, label: o.plural, field: f.key, fieldLabel: f.label, total: r.total ?? r.items.length, items: r.items });
    }
  }
  return groups;
}

// ------------------------------------------------------------------------------------ duplicates
export interface DuplicateMatch {
  id: string;
  title: string;
  reasons: string[];
  score: number;
}

const digits = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '').slice(-10);

/** Finds likely duplicates for a saved record (exclude its id) or for unsaved values. */
export async function findDuplicates(ctx: RecordCtx, objectKey: string, values: Record<string, unknown>, excludeId?: string): Promise<DuplicateMatch[]> {
  const obj = getObject(ctx.meta, objectKey);
  if (objectPerm(ctx.principal.permissions, objectKey).read === 'none') throw forbidden();
  const s = storageFor(objectKey);
  const params: unknown[] = [ctx.tenantId];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  const reasonSql: string[] = [];
  const has = (k: string) => obj.fields.some((f) => f.key === k && f.standard);

  const title = String(values[s.titleColumn] ?? (objectKey === 'lead' || objectKey === 'contact' ? `${values.first_name ?? ''} ${values.last_name ?? ''}` : '')).trim();
  if (has('email') && values.email) {
    const e = add(String(values.email).toLowerCase());
    conds.push(`lower(r.email) = ${e}`);
    reasonSql.push(`case when lower(r.email) = ${e} then 'Same email' end`);
  }
  if (has('phone') && digits(values.phone).length >= 8) {
    const ph = add(digits(values.phone));
    conds.push(`right(regexp_replace(coalesce(r.phone, ''), '[^0-9]', '', 'g'), 10) = ${ph}`);
    reasonSql.push(`case when right(regexp_replace(coalesce(r.phone, ''), '[^0-9]', '', 'g'), 10) = ${ph} then 'Same phone' end`);
  }
  if (has('domain') && values.domain) {
    const d = add(String(values.domain).toLowerCase().replace(/^www\./, ''));
    conds.push(`lower(r.domain) = ${d}`);
    reasonSql.push(`case when lower(r.domain) = ${d} then 'Same domain' end`);
  }
  if (title.length >= 3) {
    const t = add(title);
    const threshold = objectKey === 'lead' || objectKey === 'contact' ? 0.55 : 0.6;
    conds.push(`similarity(r.${ident(s.titleColumn)}, ${t}) > ${threshold}`);
    reasonSql.push(`case when similarity(r.${ident(s.titleColumn)}, ${t}) > ${threshold} then 'Similar name' end`);
  }
  if (!conds.length) return [];
  const where = [`r.tenant_id = $1`, `r.deleted_at is null`];
  if (s.discriminated) where.push(`r.object_key = ${add(objectKey)}`);
  if (excludeId) where.push(`r.id <> ${add(excludeId)}::uuid`);
  // product variants share their parent's name on purpose: never flag a variant family
  if (objectKey === 'product') {
    const fam = values.variant_of ? add(String(values.variant_of)) : excludeId ? add(excludeId) : null;
    if (fam) where.push(`r.id <> ${fam}::uuid and coalesce(r.variant_of, '00000000-0000-0000-0000-000000000000'::uuid) <> ${fam}::uuid`);
    if (values.variant_of) where.push(`r.id <> ${add(String(values.variant_of))}::uuid`);
  }
  const rows = await ctx.tx.query<{ id: string; title: string; reasons: (string | null)[] }>(
    `select r.id, r.${ident(s.titleColumn)}::text as title, array[${reasonSql.join(', ')}] as reasons
       from ${ident(s.table)} r where ${where.join(' and ')} and (${conds.join(' or ')}) limit 25`,
    params,
  );
  const out: DuplicateMatch[] = [];
  for (const r of rows) {
    // only show matches the user is allowed to read
    try {
      await loadRow(ctx, objectKey, r.id, 'read');
    } catch {
      continue;
    }
    const reasons = r.reasons.filter((x): x is string => !!x);
    const score = reasons.reduce((acc, x) => acc + (x === 'Similar name' ? 1 : 3), 0);
    out.push({ id: r.id, title: r.title, reasons, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

/**
 * Merges duplicates into a master record:
 *  - field values: explicit choices win; otherwise the master keeps its value and empty master
 *    fields are filled from the duplicates (first non-empty)
 *  - children (tasks, timeline, messages, lookups from any object) are re-pointed to the master
 *  - duplicates are soft-deleted with merged_into = master
 */
export async function mergeRecords(
  ctx: RecordCtx,
  objectKey: string,
  masterId: string,
  duplicateIds: string[],
  choices: Record<string, string> = {},
): Promise<{ events: RecordEvent[] }> {
  const ids = [...new Set(duplicateIds)].filter((d) => d !== masterId);
  if (!ids.length) throw badRequest('Choose at least one duplicate to merge');
  if (ids.length > 10) throw badRequest('Merge at most 10 records at a time');
  if (NO_MERGE.has(objectKey)) throw badRequest('Financial documents cannot be merged; cancel or void the duplicate instead');
  const obj = getObject(ctx.meta, objectKey);
  const { row: master } = await loadRow(ctx, objectKey, masterId, 'update', true);
  const dups = [];
  for (const id of ids) dups.push((await loadRow(ctx, objectKey, id, 'delete', true)).row);

  const value = (row: Record<string, unknown>, f: FieldDef) => (f.standard ? row[f.key] : ((row.custom ?? {}) as Record<string, unknown>)[f.key]);
  const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  const patch: Record<string, unknown> = {};
  for (const f of obj.fields) {
    if (f.readOnly || f.key === 'pipeline_id' || fieldAccess(ctx.principal.permissions, objectKey, f.key) !== 'edit') continue;
    const chosen = choices[f.key];
    if (chosen && chosen !== masterId) {
      const src = dups.find((d) => d.id === chosen);
      if (src) patch[f.key] = value(src, f) ?? null;
      continue;
    }
    if (!chosen && empty(value(master, f))) {
      const src = dups.find((d) => !empty(value(d, f)));
      if (src) patch[f.key] = value(src, f);
    }
  }
  const events: RecordEvent[] = [];
  if (Object.keys(patch).length) {
    const r = await updateRecord(ctx, objectKey, masterId, patch);
    events.push(...r.events);
  }

  const t = ctx.tenantId;
  // generic children
  for (const table of ['tasks', 'activities', 'messages']) {
    await ctx.tx.query(`update ${table} set related_id = $3 where tenant_id = $1 and related_object = $2 and related_id = any($4::uuid[])`, [t, objectKey, masterId, ids]);
  }
  // lookups from every object that point at this one (standard columns and custom json)
  for (const o of ctx.meta.objects) {
    const st = storageFor(o.key);
    for (const f of o.fields) {
      if (f.type !== 'lookup' || f.options?.lookupObject !== objectKey) continue;
      if (f.standard) {
        await ctx.tx.query(`update ${ident(st.table)} set ${ident(f.key)} = $2 where tenant_id = $1 and ${ident(f.key)} = any($3::uuid[])`, [t, masterId, ids]);
      } else {
        await ctx.tx.query(
          `update ${ident(st.table)} set custom = jsonb_set(custom, $2::text[], to_jsonb($3::text))
            where tenant_id = $1 and custom ->> $4 = any($5::text[])${st.discriminated ? ' and object_key = $6' : ''}`,
          st.discriminated ? [t, `{${f.key}}`, masterId, f.key, ids, o.key] : [t, `{${f.key}}`, masterId, f.key, ids],
        );
      }
    }
  }
  if (objectKey === 'contact' || objectKey === 'account') {
    const col = objectKey === 'contact' ? 'converted_contact_id' : 'converted_account_id';
    await ctx.tx.query(`update leads set ${col} = $2 where tenant_id = $1 and ${col} = any($3::uuid[])`, [t, masterId, ids]);
  }

  const s = storageFor(objectKey);
  await ctx.tx.query(`update ${ident(s.table)} set deleted_at = now(), merged_into = $2 where tenant_id = $1 and id = any($3::uuid[])`, [t, masterId, ids]);
  // children moved to the master: its roll-ups grow; parents of the merged rows shrink
  await recomputeRecord(ctx, objectKey, masterId);
  if (hasRollupParents(ctx.meta, objectKey)) await refreshParents(ctx, objectKey, dups);
  await ctx.tx.query(
    `insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1, 'system', $2, $3, $4, $5, $6)`,
    [t, `Merged ${ids.length} duplicate${ids.length > 1 ? 's' : ''}`, dups.map((d) => String(d[s.titleColumn] ?? '')).join(', '), objectKey, masterId, JSON.stringify({ merged: ids })],
  );
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'merge', $2, $3, $4)`, [t, objectKey, masterId, JSON.stringify({ merged: ids, fields: Object.keys(patch) })]);
  for (const id of ids) events.push({ objectKey, recordId: id, kind: 'deleted' });
  return { events };
}

// ------------------------------------------------------------------------------------------ bulk
export async function bulkAction(
  ctx: RecordCtx,
  objectKey: string,
  ids: string[],
  action: 'update' | 'delete',
  patch: Record<string, unknown> = {},
) {
  if (!ids.length) throw badRequest('Select at least one record');
  if (ids.length > 500) throw badRequest('At most 500 records per bulk action');
  if (action === 'update' && !Object.keys(patch).length) throw badRequest('Nothing to change');
  const events: RecordEvent[] = [];
  const failed: { id: string; error: string }[] = [];
  let succeeded = 0;
  const s = storageFor(objectKey);
  for (const id of ids) {
    const r = await savepoint(ctx, async () => {
      if (action === 'update') return (await updateRecord(ctx, objectKey, id, patch)).events;
      return deleteRecord(ctx, objectKey, id);
    });
    if (r.ok) {
      succeeded++;
      events.push(...r.value);
    } else failed.push({ id, error: r.error });
  }
  return { succeeded, failed, events };
}

// ---------------------------------------------------------------------------------------- import
const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'haan', 'ha']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'nahi']);

/** dd/mm/yyyy (Indian), dd-mm-yyyy, yyyy-mm-dd, or anything Date can parse → yyyy-mm-dd */
export function normaliseDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function coerce(ctx: RecordCtx, f: FieldDef, raw: unknown, lookupCache: Map<string, string | null>): Promise<unknown> {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = Number(v.replace(/[₹$,\s%]/g, ''));
      return Number.isFinite(n) ? n : v;
    }
    case 'boolean':
      if (TRUE_WORDS.has(v.toLowerCase())) return true;
      if (FALSE_WORDS.has(v.toLowerCase())) return false;
      return v;
    case 'date':
      return normaliseDate(v) ?? v;
    case 'datetime': {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toISOString();
    }
    case 'picklist': {
      const c = f.options?.choices?.find((x) => x.value.toLowerCase() === v.toLowerCase() || x.label.toLowerCase() === v.toLowerCase());
      return c?.value ?? v;
    }
    case 'multipicklist':
      return v
        .split(/[;,|]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => f.options?.choices?.find((c) => c.value.toLowerCase() === x.toLowerCase() || c.label.toLowerCase() === x.toLowerCase())?.value ?? x);
    case 'user': {
      if (/^[0-9a-f-]{36}$/i.test(v)) return v;
      const key = `user:${v.toLowerCase()}`;
      if (!lookupCache.has(key)) {
        const u = await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and (lower(email) = $2 or lower(full_name) = $2) limit 1`, [ctx.tenantId, v.toLowerCase()]);
        lookupCache.set(key, u?.id ?? null);
      }
      return lookupCache.get(key) ?? v;
    }
    case 'lookup': {
      const target = f.options?.lookupObject;
      if (!target || /^[0-9a-f-]{36}$/i.test(v)) return v;
      const key = `${target}:${v.toLowerCase()}`;
      if (!lookupCache.has(key)) {
        const st = storageFor(target);
        const r = await ctx.tx.one<{ id: string }>(
          `select id from ${ident(st.table)} where tenant_id = $1 and deleted_at is null and lower(${ident(st.titleColumn)}) = $2${st.discriminated ? ' and object_key = $3' : ''} limit 1`,
          st.discriminated ? [ctx.tenantId, v.toLowerCase(), target] : [ctx.tenantId, v.toLowerCase()],
        );
        lookupCache.set(key, r?.id ?? null);
      }
      return lookupCache.get(key) ?? v;
    }
    case 'stage' as never:
      return v;
    default:
      return v;
  }
}

/** Stage given as a label ("Qualified") is resolved to its id. */
function resolveStage(ctx: RecordCtx, objectKey: string, v: unknown): unknown {
  if (typeof v !== 'string' || /^[0-9a-f-]{36}$/i.test(v)) return v;
  for (const p of ctx.meta.pipelines.filter((x) => x.objectKey === objectKey)) {
    const s = p.stages.find((x) => x.label.toLowerCase() === v.toLowerCase() || x.key === v.toLowerCase());
    if (s) return s.id;
  }
  return v;
}

export interface ImportBatchResult {
  created: number;
  updated: number;
  failed: { row: number; error: string; details?: unknown }[];
  events: RecordEvent[];
}

export async function importBatch(
  ctx: RecordCtx,
  objectKey: string,
  rows: Record<string, unknown>[],
  startRow: number,
  mode: 'create' | 'upsert',
  matchField: string | null,
): Promise<ImportBatchResult> {
  const obj: ObjectMeta = getObject(ctx.meta, objectKey);
  const perm = objectPerm(ctx.principal.permissions, objectKey);
  if (!perm.create && (mode === 'create' || perm.update === 'none')) throw forbidden();
  const fm = new Map(obj.fields.map((f) => [f.key, f]));
  if (matchField && !fm.has(matchField)) throw badRequest(`Unknown match field "${matchField}"`);
  const cache = new Map<string, string | null>();
  const out: ImportBatchResult = { created: 0, updated: 0, failed: [], events: [] };

  for (let i = 0; i < rows.length; i++) {
    const src = rows[i] ?? {};
    const r = await savepoint(ctx, async () => {
      const values: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(src)) {
        const f = fm.get(k);
        if (!f) throw badRequest(`Unknown field "${k}"`);
        values[k] = k === 'stage_id' ? resolveStage(ctx, objectKey, raw) : await coerce(ctx, f, raw, cache);
        if (values[k] === null) delete values[k];
      }
      if (mode === 'upsert' && matchField && values[matchField] !== undefined) {
        const found = await listRecords(ctx, objectKey, { filters: [{ field: matchField, op: 'eq', value: values[matchField] }], limit: 1 });
        if (found.items[0]) {
          const u = await updateRecord(ctx, objectKey, found.items[0].id, values);
          return { kind: 'updated' as const, events: u.events };
        }
      }
      const c = await createRecord(ctx, objectKey, values, { autoAssign: values.owner_id === undefined });
      return { kind: 'created' as const, events: c.events };
    });
    if (r.ok) {
      out[r.value.kind]++;
      out.events.push(...r.value.events);
    } else out.failed.push({ row: startRow + i, error: r.error, details: r.details });
  }
  return out;
}

// ---------------------------------------------------------------------------------------- export
const EXPORT_LIMIT = 5000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** How a value reads to a person: names, labels, Indian money and dates. */
function displayValue(f: FieldDef, v: unknown, names: Map<string, string>): unknown {
  if (v === null || v === undefined || v === '') return '';
  const t = f.type === 'formula' ? (f.options?.returnType ?? 'text') : f.type;
  const choice = (x: unknown) => f.options?.choices?.find((c) => c.value === x)?.label ?? x;
  switch (t) {
    case 'picklist':
      return choice(v);
    case 'multipicklist':
      return (Array.isArray(v) ? v : [v]).map(choice).join(', ');
    case 'lookup':
    case 'user':
      return names.get(String(v)) ?? '';
    case 'boolean':
      return v === true || v === 'true' ? 'Yes' : 'No';
    case 'currency':
      return `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'percent':
      return `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
    case 'number':
    case 'rollup':
      return typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 }) : v;
    case 'date':
      return new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    case 'datetime':
      return new Date(String(v)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    default:
      return v;
  }
}

/**
 * Records as CSV: every match of the list's search, filters and sort (up to 5,000). `display` gives the
 * text a person reads (for PDF reports): no IDs, names for lookups and people, labels for choices, ₹ and
 * Indian dates. Otherwise raw values that import back.
 */
export async function exportCsv(ctx: RecordCtx, objectKey: string, query: Parameters<typeof listRecords>[2], columns?: string[], opts: { display?: boolean } = {}) {
  const obj = getObject(ctx.meta, objectKey);
  const visible = obj.fields.filter((f) => fieldAccess(ctx.principal.permissions, objectKey, f.key) !== 'hidden');
  const titleCol = storageFor(objectKey).titleColumn;
  const titleField = obj.fields.find((f) => f.key === titleCol);
  // the list asks for its name column as "title"
  const wantTitle = !columns?.length || columns.includes('title') || columns.includes(titleCol);
  // in the order the list shows them
  const cols = (columns?.length ? columns.map((k) => visible.find((f) => f.key === k)).filter((f): f is FieldDef => !!f) : visible).filter((f) => f.key !== titleCol);
  const users = new Map((await ctx.tx.query<{ id: string; full_name: string }>(`select id, full_name from users where tenant_id = $1`, [ctx.tenantId])).map((u) => [u.id, u.full_name]));
  const stages = new Map(ctx.meta.pipelines.flatMap((p) => p.stages).map((s) => [s.id, s.label]));
  const pipes = new Map(ctx.meta.pipelines.map((p) => [p.id, p.name]));
  const display = !!opts.display;
  const head = [...(display ? [] : ['ID']), ...(wantTitle ? [titleField?.label ?? 'Name'] : []), ...cols.map((c) => c.label), 'Created', 'Updated'];
  const lines = [head.map(csvCell).join(',')];
  const when = (v: unknown) => (display ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : v);
  let cursor: string | null = null;
  let n = 0;
  do {
    const page: Awaited<ReturnType<typeof listRecords>> = await listRecords(ctx, objectKey, { ...query, limit: 200, cursor });
    // names of the records that lookups on this page point at
    const names = new Map<string, string>([...users, ...stages, ...pipes]);
    if (display) {
      for (const c of cols.filter((f) => f.type === 'lookup' && f.options?.lookupObject)) {
        const ids = [...new Set(page.items.map((r) => r[c.key]).filter((x): x is string => typeof x === 'string' && !!x))];
        if (!ids.length) continue;
        const ts = storageFor(c.options!.lookupObject!);
        for (const r of await ctx.tx.query<{ id: string; t: string }>(`select id, "${ts.titleColumn}" as t from "${ts.table}" where tenant_id = $1 and id::text = any($2::text[])`, [ctx.tenantId, ids])) names.set(r.id, r.t);
      }
    }
    for (const r of page.items) {
      const cells = cols.map((c) => {
        const v = r[c.key];
        if (c.key === 'stage_id') return stages.get(String(v)) ?? v;
        if (c.key === 'pipeline_id') return pipes.get(String(v)) ?? v;
        if (display) return displayValue(c, v, names);
        if (c.type === 'user') return users.get(String(v)) ?? v;
        return v;
      });
      lines.push([...(display ? [] : [r.id]), ...(wantTitle ? [r.title] : []), ...cells, when(r.created_at), when(r.updated_at)].map(csvCell).join(','));
      if (++n >= EXPORT_LIMIT) break;
    }
    cursor = n >= EXPORT_LIMIT ? null : page.nextCursor;
  } while (cursor);
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'export', $2, $3)`, [ctx.tenantId, objectKey, JSON.stringify({ rows: n, columns: cols.map((c) => c.key), format: display ? 'report' : 'csv' })]);
  return { csv: '\uFEFF' + lines.join('\r\n'), rows: n, truncated: n >= EXPORT_LIMIT };
}
