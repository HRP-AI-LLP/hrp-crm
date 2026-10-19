/**
 * OpenAPI 3.1 description of a workspace's API: the generic record endpoints plus one schema per
 * object with that workspace's own custom fields, so Postman, Zapier-style tools and code
 * generators see the real shape of the data.
 */
import { type FieldDef, objectPerm, type TenantMeta, type EffectivePermissions } from '@synapse/shared';

const TYPE: Record<string, Record<string, unknown>> = {
  text: { type: 'string' },
  textarea: { type: 'string' },
  email: { type: 'string', format: 'email' },
  phone: { type: 'string' },
  url: { type: 'string', format: 'uri' },
  number: { type: 'number' },
  currency: { type: 'number' },
  percent: { type: 'number' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  boolean: { type: 'boolean' },
  picklist: { type: 'string' },
  multipicklist: { type: 'array', items: { type: 'string' } },
  lookup: { type: 'string', format: 'uuid' },
  user: { type: 'string', format: 'uuid' },
  formula: {},
  rollup: { type: 'number' },
};

function fieldSchema(f: FieldDef) {
  const base: Record<string, unknown> = { ...(TYPE[f.type] ?? { type: 'string' }), title: f.label };
  if (f.helpText) base.description = f.helpText;
  if ((f.type === 'picklist' || f.type === 'multipicklist') && f.options?.choices?.length) {
    const vals = f.options.choices.map((c) => c.value);
    if (f.type === 'picklist') base.enum = vals;
    else base.items = { type: 'string', enum: vals };
  }
  if (f.readOnly || f.type === 'formula' || f.type === 'rollup') base.readOnly = true;
  return { ...base, nullable: true };
}

export const EVENT_KINDS = ['created', 'updated', 'stage_changed', 'deleted'] as const;

export function eventCatalog(meta: TenantMeta) {
  return meta.objects.flatMap((o) => EVENT_KINDS.filter((k) => k !== 'stage_changed' || meta.pipelines.some((p) => p.objectKey === o.key)).map((k) => ({ event: `${o.key}.${k}`, object: o.key, label: `${o.label} ${k.replace('_', ' ')}` })));
}

export function openApi(meta: TenantMeta, perms: EffectivePermissions, origin: string) {
  const schemas: Record<string, unknown> = {
    Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' } } } } },
    Filter: { type: 'object', required: ['field', 'op'], properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'neq', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'not_null'] }, value: {} } },
    WebhookEvent: {
      type: 'object',
      properties: { event: { type: 'string', example: 'lead.created' }, tenantId: { type: 'string', format: 'uuid' }, sentAt: { type: 'string', format: 'date-time' }, data: { type: 'object', properties: { object: { type: 'string' }, recordId: { type: 'string', format: 'uuid' }, changes: { type: 'object' }, record: { type: 'object' } } } },
    },
  };
  const paths: Record<string, unknown> = {};
  const err = (d: string) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  for (const o of meta.objects) {
    const p = objectPerm(perms, o.key);
    if (p.read === 'none') continue;
    const name = o.key.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());
    const props: Record<string, unknown> = { id: { type: 'string', format: 'uuid', readOnly: true }, title: { type: 'string', readOnly: true }, version: { type: 'integer', readOnly: true }, created_at: { type: 'string', format: 'date-time', readOnly: true }, updated_at: { type: 'string', format: 'date-time', readOnly: true } };
    for (const f of o.fields) props[f.key] = fieldSchema(f);
    schemas[name] = { type: 'object', title: o.label, properties: props, required: o.fields.filter((f) => f.required).map((f) => f.key) };
    const ref = { $ref: `#/components/schemas/${name}` };
    const tag = o.plural;
    paths[`/records/${o.key}`] = {
      get: {
        tags: [tag],
        summary: `List ${o.plural.toLowerCase()}`,
        operationId: `list_${o.key}`,
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search text' },
          { name: 'filters', in: 'query', schema: { type: 'string' }, description: 'JSON array of filters, e.g. [{"field":"source","op":"eq","value":"website"}]' },
          { name: 'sort', in: 'query', schema: { type: 'string' } },
          { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'nextCursor from the previous page' },
        ],
        responses: { 200: { description: 'A page of records', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: ref }, nextCursor: { type: 'string', nullable: true } } } } } }, 403: err('Not allowed') },
      },
      ...(p.create ? { post: { tags: [tag], summary: `Create a ${o.label.toLowerCase()}`, operationId: `create_${o.key}`, requestBody: { required: true, content: { 'application/json': { schema: ref } } }, responses: { 201: { description: 'Created', content: { 'application/json': { schema: ref } } }, 400: err('Validation failed') } } } : {}),
    };
    paths[`/records/${o.key}/{id}`] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { tags: [tag], summary: `Get a ${o.label.toLowerCase()}`, operationId: `get_${o.key}`, responses: { 200: { description: 'The record', content: { 'application/json': { schema: ref } } }, 404: err('Not found or not visible') } },
      ...(p.update !== 'none'
        ? { patch: { tags: [tag], summary: `Update a ${o.label.toLowerCase()}`, operationId: `update_${o.key}`, parameters: [{ name: 'if-match', in: 'header', schema: { type: 'string' }, description: 'The record version, to refuse lost updates' }], requestBody: { required: true, content: { 'application/json': { schema: ref } } }, responses: { 200: { description: 'Updated', content: { 'application/json': { schema: ref } } }, 409: err('Changed by someone else') } } }
        : {}),
      ...(p.delete !== 'none' ? { delete: { tags: [tag], summary: `Delete a ${o.label.toLowerCase()}`, operationId: `delete_${o.key}`, responses: { 200: { description: 'Deleted' } } } } : {}),
    };
    paths[`/records/${o.key}/{id}/activities`] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { tags: [tag], summary: 'Log a call, note, email or meeting on the timeline', operationId: `log_${o.key}`, requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['kind', 'subject'], properties: { kind: { type: 'string', enum: ['note', 'call', 'email', 'meeting', 'whatsapp', 'sms'] }, subject: { type: 'string' }, body: { type: 'string' }, direction: { type: 'string', enum: ['in', 'out'] } } } } } }, responses: { 201: { description: 'Logged' } } },
    };
  }
  paths['/search'] = { get: { tags: ['Search'], summary: 'Search across records', operationId: 'search', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Matches' } } } };
  paths['/hooks'] = {
    get: { tags: ['Webhooks'], summary: 'List webhook subscriptions', operationId: 'list_hooks', responses: { 200: { description: 'Subscriptions' } } },
    post: {
      tags: ['Webhooks'],
      summary: 'Subscribe a URL to events (REST hooks)',
      operationId: 'subscribe',
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['url', 'events'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', example: 'lead.created' } }, name: { type: 'string' } } } } } },
      responses: { 201: { description: 'Subscribed; the signing secret is returned once' } },
      callbacks: { event: { '{$request.body#/url}': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEvent' } } } }, responses: { 200: { description: 'Received' } } } } } },
    },
  };
  paths['/hooks/{id}'] = { delete: { tags: ['Webhooks'], summary: 'Unsubscribe', operationId: 'unsubscribe', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Removed' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: `${meta.tenant.name} · HRP Synapse API`,
      version: '1',
      description:
        'Authenticate with an API key from Settings → API keys: `Authorization: Bearer syn_…`. Keys act as a person and see what that person sees. Each key allows a number of requests a minute (see the X-RateLimit-* headers); 429 means wait for Retry-After seconds. Webhooks are signed: `X-Synapse-Signature-V2: t=<unix>,v1=<hex HMAC-SHA256 of "t.body" with your secret>`.',
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ apiKey: [] }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'syn_<workspace>_<secret>' } }, schemas },
    paths,
  };
}
