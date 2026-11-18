/**
 * The public help centre: knowledge-base articles marked public are listed by category, searched
 * and read by customers behind one link (no sign-in). Drafting stays in the knowledge base.
 */
import { hasAdmin } from '@synapse/shared';
import { randomToken } from '../../lib/crypto';
import type { Tx } from '../../lib/db';
import { forbidden, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';

function assertKbAdmin(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'ai') || hasAdmin(p, 'operations') || hasAdmin(p, 'quality')) return;
  throw forbidden('Publishing help articles needs the AI, operations or quality permission');
}

export async function kbSite(ctx: RecordCtx) {
  const s = await ctx.tx.one<{ title: string; public_token: string | null }>(`select title, public_token from kb_sites where tenant_id = $1`, [ctx.tenantId]);
  const docs = await ctx.tx.query(
    `select id, title, category, is_public, status, updated_at, length(coalesce(content, '')) as size from kb_documents where tenant_id = $1 order by is_public desc, category nulls last, title limit 1000`,
    [ctx.tenantId],
  );
  return { title: s?.title ?? 'Help centre', token: s?.public_token ?? null, docs };
}

export async function saveKbSite(ctx: RecordCtx, input: { title?: string; on?: boolean }) {
  assertKbAdmin(ctx);
  const cur = await ctx.tx.one<{ public_token: string | null }>(`select public_token from kb_sites where tenant_id = $1`, [ctx.tenantId]);
  const token = input.on === undefined ? (cur?.public_token ?? null) : input.on ? (cur?.public_token ?? randomToken(20)) : null;
  await ctx.tx.query(
    `insert into kb_sites (tenant_id, title, public_token) values ($1, coalesce($2, 'Help centre'), $3)
     on conflict (tenant_id) do update set title = coalesce($2, kb_sites.title), public_token = $3`,
    [ctx.tenantId, input.title ?? null, token],
  );
  return { token };
}

export async function publishArticle(ctx: RecordCtx, id: string, input: { isPublic?: boolean; category?: string | null }) {
  assertKbAdmin(ctx);
  const r = await ctx.tx.one(
    `update kb_documents set is_public = coalesce($3, is_public), category = case when $4::boolean then $5 else category end, updated_at = now() where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, id, input.isPublic ?? null, input.category !== undefined, input.category ?? null],
  );
  if (!r) throw notFound('Article not found');
  return { ok: true };
}

/** What a customer sees: categories with article titles, or search results, or one article. */
export async function publicKb(tx: Tx, tenantId: string, q: { search?: string | null; articleId?: string | null }) {
  const site = await tx.one<{ title: string; company: string }>(`select k.title, t.name as company from kb_sites k join tenants t on t.id = k.tenant_id where k.tenant_id = $1`, [tenantId]);
  if (!site) throw notFound();
  if (q.articleId) {
    const a = await tx.one(`select id, title, category, content, updated_at from kb_documents where tenant_id = $1 and id = $2 and is_public`, [tenantId, q.articleId]);
    if (!a) throw notFound();
    return { ...site, article: a };
  }
  const term = q.search?.trim() || null;
  const articles = await tx.query<{ id: string; title: string; category: string | null; excerpt: string }>(
    `select id, title, category, left(regexp_replace(coalesce(content, ''), '\\s+', ' ', 'g'), 220) as excerpt from kb_documents
      where tenant_id = $1 and is_public and ($2::text is null or title ilike '%' || $2 || '%' or content ilike '%' || $2 || '%')
      order by ($2::text is not null and title ilike '%' || $2 || '%') desc, category nulls last, title limit 300`,
    [tenantId, term],
  );
  const cats = new Map<string, typeof articles>();
  for (const a of articles) cats.set(a.category ?? 'General', [...(cats.get(a.category ?? 'General') ?? []), a]);
  return { ...site, search: term, categories: [...cats.entries()].map(([name, items]) => ({ name, items })) };
}
