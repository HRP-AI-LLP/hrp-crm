/**
 * The files imported invoices were read from: kept with each read invoice (only its own pages when one
 * PDF held several), and attached to the invoice when it is approved into the books.
 */
import { PDFDocument } from 'pdf-lib';
import type { Env } from '../../env';
import type { RecordCtx } from '../records';
import { saveFile } from '../files';

const b64bytes = (s: string) => {
  const bin = atob(s.replace(/^data:[^,]+,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** "3" or "3-4" → zero-based page indexes */
function pageRange(p: string | null, count: number): number[] | null {
  const m = p?.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]) - 1;
  const b = Number(m[2] ?? m[1]) - 1;
  if (a < 0 || b >= count || b < a) return null;
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export async function keepSourceFiles(ctx: RecordCtx, env: Env, ids: string[], f: { fileName: string; pdf?: string; images?: { mime: string; data: string }[] }) {
  if (!env.FILES || !ids.length) return;
  const items = await ctx.tx.query<{ id: string; pages: string | null; number: string | null }>(
    `select id, pages, data ->> 'number' as number from doc_import_items where tenant_id = $1 and id = any($2::uuid[])`,
    [ctx.tenantId, ids],
  );
  if (f.pdf) {
    const bytes = b64bytes(f.pdf);
    let doc: PDFDocument | null = null;
    if (items.length > 1) doc = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch(() => null);
    for (const it of items) {
      let out: Uint8Array = bytes;
      let name = f.fileName;
      const range = doc ? pageRange(it.pages, doc.getPageCount()) : null;
      if (doc && range) {
        const one = await PDFDocument.create();
        for (const pg of await one.copyPages(doc, range)) one.addPage(pg);
        out = await one.save();
        name = `${(it.number ?? f.fileName.replace(/\.pdf$/i, '')).replace(/[^\w.\-]+/g, '-')}.pdf`;
      }
      const saved = await saveFile(ctx, env, { objectKey: 'doc_import', recordId: it.id, name, bytes: out, kind: 'document', description: `Read from ${f.fileName}` }, { system: true }).catch(() => null);
      if (saved) await ctx.tx.query(`update doc_import_items set source_file_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, it.id, saved.id]);
      // an invoice imported before files were kept gets its file now, when the same PDF is uploaded again
      const existing = it.number
        ? await ctx.tx.one<{ id: string }>(
            `select i.id from invoices i where i.tenant_id = $1 and lower(i.invoice_number) = lower($2) and i.deleted_at is null and i.status <> 'void'
                and not exists (select 1 from files f where f.tenant_id = i.tenant_id and f.object_key = 'invoice' and f.record_id = i.id and f.deleted_at is null) limit 1`,
            [ctx.tenantId, it.number],
          )
        : null;
      if (existing) await saveFile(ctx, env, { objectKey: 'invoice', recordId: existing.id, name, bytes: out, kind: 'document', description: 'The imported invoice' }, { system: true }).catch(() => null);
    }
  } else if (f.images?.length === 1 && items.length === 1) {
    const ext = f.images[0]!.mime.split('/')[1];
    const saved = await saveFile(ctx, env, { objectKey: 'doc_import', recordId: items[0]!.id, name: f.fileName.includes('.') ? f.fileName : `${f.fileName}.${ext}`, bytes: b64bytes(f.images[0]!.data), kind: 'document' }, { system: true }).catch(() => null);
    if (saved) await ctx.tx.query(`update doc_import_items set source_file_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, items[0]!.id, saved.id]);
  }
}

/** Copies the source file of each approved item to the invoice it became. */
export async function attachSourceFiles(ctx: RecordCtx, env: Env, results: { id: string; ok: boolean; created?: Record<string, any> }[]) {
  if (!env.FILES) return;
  for (const r of results) {
    const inv = r.ok ? r.created?.invoice?.id : null;
    if (!inv) continue;
    const f = await ctx.tx.one<{ storage_key: string; name: string }>(
      `select f.storage_key, f.name from doc_import_items d join files f on f.tenant_id = d.tenant_id and f.id = d.source_file_id and f.deleted_at is null where d.tenant_id = $1 and d.id = $2`,
      [ctx.tenantId, r.id],
    );
    const body = f && (await env.FILES.get(f.storage_key));
    if (body) await saveFile(ctx, env, { objectKey: 'invoice', recordId: String(inv), name: f!.name, bytes: new Uint8Array(await body.arrayBuffer()), kind: 'document', description: 'The imported invoice' }, { system: true }).catch(() => null);
  }
}
