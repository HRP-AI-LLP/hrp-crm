/**
 * Metadata engine write path: custom objects, custom fields, pipelines/stages and module install.
 * All writes are tenant scoped; meta_version is bumped by DB triggers, which rotates edge caches.
 */
import { type FieldSpec, fieldSpecSchema, KEY_PATTERN, MODULES, RESERVED_FIELD_KEYS } from '@synapse/shared';
import { z } from 'zod';
import type { Tx } from '../lib/db';
import { badRequest, conflict, notFound } from '../lib/errors';

export const objectSpecSchema = z.object({
  key: z.string().regex(KEY_PATTERN),
  label: z.string().min(1).max(60),
  plural: z.string().min(1).max(60),
  icon: z.string().max(40).optional(),
  description: z.string().max(500).optional(),
});

export const pipelineSpecSchema = z.object({
  objectKey: z.string().regex(KEY_PATTERN),
  name: z.string().min(1).max(80),
  isDefault: z.boolean().optional(),
  stages: z
    .array(
      z.object({
        key: z.string().regex(KEY_PATTERN),
        label: z.string().min(1).max(60),
        probability: z.number().int().min(0).max(100).default(0),
        category: z.enum(['open', 'won', 'lost']).default('open'),
        color: z.string().max(20).optional(),
      }),
    )
    .min(2)
    .max(30),
});

const STANDARD = new Set(['lead', 'contact', 'account', 'deal', 'task', 'activity', 'user', 'pipeline', 'stage']);

export async function createObject(tx: Tx, tenantId: string, spec: z.infer<typeof objectSpecSchema>, moduleKey: string | null = null) {
  if (STANDARD.has(spec.key)) throw conflict(`"${spec.key}" is a reserved object key`);
  const row = await tx.one<{ id: string }>(
    `insert into custom_objects (tenant_id, key, label, plural_label, icon, description, module_key)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, key) do nothing returning id`,
    [tenantId, spec.key, spec.label, spec.plural, spec.icon ?? null, spec.description ?? null, moduleKey],
  );
  return row?.id ?? null;
}

export async function upsertField(tx: Tx, tenantId: string, objectKey: string, spec: FieldSpec, moduleKey: string | null = null) {
  const f = fieldSpecSchema.parse(spec);
  if (RESERVED_FIELD_KEYS.has(f.key)) throw badRequest(`"${f.key}" is a reserved field key`);
  if ((f.type === 'picklist' || f.type === 'multipicklist') && !f.options?.choices?.length) throw badRequest('Picklist fields need at least one choice');
  if (f.type === 'lookup' && !f.options?.lookupObject) throw badRequest('Lookup fields need options.lookupObject');
  const obj = await tx.one(`select 1 from custom_objects where tenant_id = $1 and key = $2`, [tenantId, objectKey]);
  if (!obj) throw notFound(`Unknown object "${objectKey}"`);
  const prev = await tx.one<{ is_indexed: boolean; field_type: string }>(`select is_indexed, field_type from custom_fields where tenant_id = $1 and object_key = $2 and key = $3`, [tenantId, objectKey, f.key]);
  if (prev && prev.field_type !== f.type) throw conflict('Changing a field type is not supported; create a new field and migrate data');
  const row = await tx.one<{ id: string }>(
    `insert into custom_fields (tenant_id, object_key, key, label, field_type, is_required, is_indexed, is_pii, options, help_text, position, module_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (tenant_id, object_key, key) do update set
       label = excluded.label, is_required = excluded.is_required, is_indexed = excluded.is_indexed, is_pii = excluded.is_pii,
       options = excluded.options, help_text = excluded.help_text, position = excluded.position
     returning id`,
    [tenantId, objectKey, f.key, f.label, f.type, f.required ?? false, f.indexed ?? false, f.pii ?? false, JSON.stringify(f.options ?? {}), f.helpText ?? null, f.position ?? 0, moduleKey],
  );
  if (!prev || prev.is_indexed !== (f.indexed ?? false)) {
    await tx.query(`select app.reindex_custom_field($1, $2)`, [objectKey, f.key]);
  }
  return row!.id;
}

export async function createPipeline(tx: Tx, tenantId: string, spec: z.infer<typeof pipelineSpecSchema>, moduleKey: string | null = null) {
  const exists = await tx.one<{ id: string }>(`select id from pipelines where tenant_id = $1 and object_key = $2 and name = $3`, [tenantId, spec.objectKey, spec.name]);
  if (exists) return exists.id;
  if (spec.isDefault) await tx.query(`update pipelines set is_default = false where tenant_id = $1 and object_key = $2`, [tenantId, spec.objectKey]);
  const hasDefault = await tx.one(`select 1 from pipelines where tenant_id = $1 and object_key = $2 and is_default`, [tenantId, spec.objectKey]);
  const p = await tx.one<{ id: string }>(
    `insert into pipelines (tenant_id, object_key, name, is_default, module_key) values ($1,$2,$3,$4,$5) returning id`,
    [tenantId, spec.objectKey, spec.name, spec.isDefault ?? !hasDefault, moduleKey],
  );
  let pos = 1;
  for (const s of spec.stages) {
    await tx.query(
      `insert into pipeline_stages (tenant_id, pipeline_id, key, label, position, probability, category, color) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, p!.id, s.key, s.label, pos++, s.probability, s.category, s.color ?? null],
    );
  }
  return p!.id;
}

export async function installModule(tx: Tx, tenantId: string, moduleKey: string) {
  const m = MODULES[moduleKey];
  if (!m) throw notFound(`Unknown module "${moduleKey}"`);
  for (const o of m.objects) {
    await createObject(tx, tenantId, { key: o.key, label: o.label, plural: o.plural, icon: o.icon }, m.key);
    let pos = 100;
    for (const f of o.fields) await upsertField(tx, tenantId, o.key, { ...f, position: f.position ?? pos++ }, m.key);
  }
  for (const group of m.fields) {
    let pos = 200;
    for (const f of group.fields) await upsertField(tx, tenantId, group.object, { ...f, position: f.position ?? pos++ }, m.key);
  }
  for (const p of m.pipelines) {
    await createPipeline(tx, tenantId, { objectKey: p.object, name: p.name, isDefault: p.isDefault, stages: p.stages.map((s) => ({ ...s })) }, m.key);
  }
  for (const w of m.workflows) {
    const exists = await tx.one(`select 1 from workflows where tenant_id = $1 and module_key = $2 and name = $3`, [tenantId, m.key, w.name]);
    if (!exists) {
      await tx.query(
        `insert into workflows (tenant_id, name, object_key, trigger_event, conditions, actions, module_key) values ($1,$2,$3,$4,$5,$6,$7)`,
        [tenantId, w.name, w.object, w.trigger, JSON.stringify(w.conditions), JSON.stringify(w.actions), m.key],
      );
    }
  }
  await tx.query(
    `insert into tenant_modules (tenant_id, module_key, version) values ($1,$2,$3)
     on conflict (tenant_id, module_key) do update set version = excluded.version, is_enabled = true`,
    [tenantId, m.key, m.version],
  );
  return { module: m.key, version: m.version };
}
