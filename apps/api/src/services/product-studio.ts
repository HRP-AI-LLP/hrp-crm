/**
 * Idea → product. Someone describes an idea (in the assistant chat or the "New from an idea" form),
 * adds their rules and any documents or pictures, and this sets everything up in one go: an in-house
 * project of the right kind, the rules the AI must follow, the files as project documents (read and
 * summarised), the coding agent (HRP AI) switched on, and an AI delivery run of the full product pack
 * — PRD, SRS, UX, architecture, diagrams, API and data design, security, standards, backlog, test
 * cases, plans, runbook, the build by the coding agent, and the user manual.
 */
import { PRODUCT_TYPES } from '@synapse/shared';
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest } from '../lib/errors';
import { saveFile } from './files';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';
import { createRun, getRun, TEMPLATES, type StepInput } from './sdlc';

export const PLATFORMS = ['web', 'android', 'ios', 'windows', 'macos', 'linux', 'api'] as const;

const PRODUCT_LABEL: Record<string, string> = {
  web_app: 'web application',
  saas: 'multi-tenant SaaS product',
  website: 'website',
  mobile_app: 'mobile app',
  mobile_game: 'mobile game',
  desktop_app: 'desktop app',
  api_service: 'API / backend service',
  data_ai: 'data / AI product',
  iot_embedded: 'IoT / embedded product',
  erp_implementation: 'ERP implementation',
  other: 'software product',
};

export const ideaSchema = z.object({
  idea: z.string().trim().min(20, 'Describe the idea in a few sentences').max(20000),
  name: z.string().trim().max(200).nullish(),
  productType: z.enum(PRODUCT_TYPES).default('web_app'),
  platforms: z.array(z.enum(PLATFORMS)).max(PLATFORMS.length).optional(),
  audience: z.string().trim().max(2000).nullish(),
  market: z.string().trim().max(200).nullish(),
  stack: z.string().trim().max(2000).nullish(),
  /** what the AI must always follow on this product: standards, do's and don'ts, constraints */
  rules: z.string().max(20000).nullish(),
  /** files staged with POST /sdlc/studio/files */
  fileIds: z.array(z.string().uuid()).max(30).optional(),
  /** 'key': review the main documents and the backlog; 'each': every step; 'none': only the backlog and the build */
  reviewMode: z.enum(['each', 'key', 'none']).default('key'),
  /** HRP AI builds it: the backlog goes to the coding agent */
  build: z.boolean().default(true),
  /** the coding agent takes all the work in one go and then waits for review, or one item at a time */
  workMode: z.enum(['one', 'batch']).default('batch'),
  start: z.boolean().default(true),
});
export type Idea = z.infer<typeof ideaSchema>;

const DEFAULT_PLATFORMS: Record<string, string[]> = {
  mobile_app: ['android', 'ios'],
  mobile_game: ['android', 'ios'],
  desktop_app: ['windows'],
  api_service: ['api'],
};

/** Files for an idea are kept against the person until the product is created. */
export async function stageFile(ctx: RecordCtx, env: Env, name: string, bytes: Uint8Array) {
  const f = await saveFile(ctx, env, { objectKey: 'user', recordId: ctx.principal.user.id, name, bytes, kind: 'document', description: 'For a new product (idea)' }, { system: true });
  return { id: f.id, name: f.name, contentType: f.contentType, size: f.size };
}

/** The extra documents a kind of product needs beyond the standard pack. */
function extraSteps(type: string, platforms: string[]): StepInput[] {
  const out: StepInput[] = [];
  const mobile = platforms.includes('android') || platforms.includes('ios');
  if (mobile)
    out.push({
      agent: 'devops',
      kind: 'document',
      docType: 'custom',
      title: 'App store release: Play Store / App Store',
      instructions:
        'Signing (keystore / certificates), build flavours, versionCode / build numbers, store listing text and screenshots list, content rating, data-safety / privacy nutrition labels, permissions justification, internal → closed → production tracks, TestFlight, review guidelines to watch, crash reporting and staged rollout.',
    });
  if (platforms.includes('windows') || platforms.includes('macos') || platforms.includes('linux'))
    out.push({
      agent: 'devops',
      kind: 'document',
      docType: 'custom',
      title: 'Desktop packaging, signing and distribution',
      instructions: 'Installer (MSI / EXE, DMG, AppImage / deb), code signing, auto-update, versioning, and distribution by e-mail, Google Drive, OneDrive or SharePoint links with checksums; uninstall and data locations.',
    });
  if (type === 'saas')
    out.push({
      agent: 'architect',
      kind: 'document',
      docType: 'custom',
      title: 'SaaS: tenancy, plans, billing and onboarding',
      instructions: 'Tenant isolation (row-level security), sign-up and onboarding, plans and limits, subscription billing in INR with GST invoices (and other currencies), usage metering, admin console, data export and deletion (DPDP Act 2023).',
    });
  if (type === 'mobile_game')
    out.push({ agent: 'ux', kind: 'document', docType: 'custom', title: 'Game design document', instructions: 'Core loop, levels and progression, controls, art and sound direction, economy and monetisation, analytics events, fairness and age rating.' });
  return out;
}

function goalOf(input: Idea, name: string, platforms: string[]) {
  const lines = [
    `Build "${name}": a ${PRODUCT_LABEL[input.productType] ?? 'software product'}${platforms.length ? ` for ${platforms.join(', ')}` : ''}.`,
    '',
    '## The idea',
    input.idea,
  ];
  if (input.audience) lines.push('', '## Who it is for', input.audience);
  lines.push('', '## Market', input.market || 'India first (INR, GST, Indian number and date formats, English and Hindi), ready for other markets.');
  if (input.stack) lines.push('', '## Preferred technology', input.stack);
  lines.push(
    '',
    '## Quality bar',
    'Enterprise-grade and production-ready, not a prototype: a clean modular architecture; secure by design (OWASP ASVS level 2, least privilege, secrets out of code, audit trail); privacy under the DPDP Act 2023; accessible (WCAG 2.2 AA) and responsive; observable (structured logs, metrics, health checks); automated tests at unit, integration and end-to-end level in CI; reproducible builds and one-command local setup; and complete documentation — README, architecture, API reference, runbook and user manual.',
  );
  if (input.rules) lines.push('', 'Follow the project rules exactly.');
  return lines.join('\n');
}

export async function startFromIdea(ctx: RecordCtx, input: Idea) {
  const { createRecord } = await import('./records');
  const platforms = input.platforms?.length ? input.platforms : (DEFAULT_PLATFORMS[input.productType] ?? ['web']);
  const name = (input.name?.trim() || input.idea.split('\n')[0]!.replace(/[#*_`>]/g, '').trim().split(/\s+/).slice(0, 6).join(' ')).slice(0, 200) || 'New product';

  const files = input.fileIds?.length
    ? await ctx.tx.query<{ id: string; name: string }>(
        `select id, name from files where tenant_id = $1 and id = any($2::uuid[]) and object_key = 'user' and record_id = $3 and deleted_at is null`,
        [ctx.tenantId, input.fileIds, ctx.principal.user.id],
      )
    : [];
  if (input.fileIds && files.length !== new Set(input.fileIds).size) throw badRequest('Some of the files are not yours or were removed: upload them again');

  const p = await createRecord(ctx, 'project', {
    name,
    status: 'active',
    project_kind: 'in_house',
    product_type: input.productType,
    billing_method: 'non_billable',
    description: input.idea.slice(0, 5000),
  });
  const projectId = p.record.id;
  const brief = { idea: input.idea, platforms, audience: input.audience ?? null, market: input.market ?? null, stack: input.stack ?? null, startedAt: new Date().toISOString() };
  await ctx.tx.query(`update projects set ai_rules = $3, product_brief = $4, default_assignee = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId, projectId, input.rules?.trim() || null, JSON.stringify(brief), input.build ? 'agent' : 'none',
  ]);

  // the files become the project's documents, read and summarised like anything a client shares
  for (const f of files) {
    await ctx.tx.query(`update files set object_key = 'project', record_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, f.id, projectId]);
    const title = f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Document';
    await ctx.tx.query(`insert into project_documents (tenant_id, project_id, file_id, category, title, notes, auto_category) values ($1,$2,$3,'other',$4,'Shared with the idea',true)`, [
      ctx.tenantId, projectId, f.id, title,
    ]);
  }

  if (input.build) {
    const { saveSettings } = await import('./coding-agent');
    await saveSettings(ctx, projectId, {
      enabled: true,
      workTypes: ['story', 'task', 'bug', 'subtask', 'improvement'],
      onCreate: true,
      onUpdate: true,
      autoPush: false,
      instructions: input.stack ? `Technology: ${input.stack}` : null,
      workMode: input.workMode,
      batchSize: 50,
    });
  }

  const base = TEMPLATES.product!.steps;
  const codeAt = base.findIndex((s) => s.kind === 'code');
  const steps = [...base.slice(0, codeAt), ...extraSteps(input.productType, platforms), ...base.slice(codeAt)].filter((s) => input.build || s.kind !== 'code');
  const run = await createRun(ctx, {
    goal: goalOf(input, name, platforms),
    title: `${name}: from idea to product`,
    projectId,
    template: 'product',
    reviewMode: input.reviewMode,
    steps,
    autoStart: input.start,
  });
  return { projectId, runId: run.id, advance: run.advance, documents: files.length, name, readDocs: files.length > 0 };
}

/** Where a product started from an idea stands: documents, steps and the build. */
export async function studioStatus(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const p = await ctx.tx.one<Record<string, any>>(`select id, name, work_key, product_type, ai_rules, product_brief from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]);
  const runRow = await ctx.tx.one<{ id: string }>(`select id from sdlc_runs where tenant_id = $1 and project_id = $2 and template = 'product' order by created_at desc limit 1`, [ctx.tenantId, projectId]);
  const run = runRow ? await getRun(ctx, runRow.id) : null;
  const docs = await ctx.tx.one<{ n: number; read: number }>(
    `select count(*)::int as n, count(*) filter (where read_status = 'read')::int as read from project_documents where tenant_id = $1 and project_id = $2`,
    [ctx.tenantId, projectId],
  );
  const jobs = await ctx.tx.query<{ status: string; n: number }>(`select status, count(*)::int as n from coding_agent_jobs where tenant_id = $1 and project_id = $2 group by status`, [ctx.tenantId, projectId]);
  return { project: p, run, documents: docs, build: Object.fromEntries(jobs.map((j) => [j.status, j.n])) };
}

export const rulesSchema = z.object({ rules: z.string().max(20000).nullable() });

export async function getRules(ctx: RecordCtx, projectId: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const r = await ctx.tx.one<{ ai_rules: string | null }>(`select ai_rules from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]);
  return { rules: r?.ai_rules ?? null, canEdit: level === 'manage' };
}

export async function saveRules(ctx: RecordCtx, projectId: string, rules: string | null) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`update projects set ai_rules = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId, rules?.trim() || null]);
  return getRules(ctx, projectId);
}
