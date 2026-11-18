/**
 * Bank and card statements that arrive by mail: the attachment (PDF, usually password-protected, or a
 * CSV / Excel file) is opened with the password saved on the account, read into statement lines (cards
 * the other way round: purchases owed, "Cr" paid), imported into that account and handed to the
 * accounts desk, which matches them with bills, invoices, payments and the GST and project records.
 *
 * Which account: the last four digits named in the mail or the statement, the senders saved on the
 * account, or the account whose password opens the file.
 */
import { jsonSafe } from '../../lib/json-safe';
import { linesFromRows, rowsFromItems } from '@synapse/shared';
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { PdfPasswordNeeded, pdfItemsOf } from '../../lib/pdf-lines';
import { csvRows } from '@synapse/shared';
import { readSecret, sealSecret } from '../integrations';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { importStatement, type StatementRow } from './banking';
import { type DeskDeps, runBookkeeper } from './desk';

interface Acc {
  id: string;
  name: string;
  kind: string;
  account_last4: string | null;
  bank_name: string | null;
  statement_password_ciphertext: string | null;
  statement_senders: string | null;
}

/** Saves (or clears) the password the account's statement PDFs are protected with. */
export async function setStatementPassword(ctx: RecordCtx, env: Env, id: string, input: { password?: string | null; senders?: string | null }) {
  const ct = input.password === undefined ? undefined : input.password ? await sealSecret(env, ctx.tenantId, { password: input.password }) : null;
  const r = await ctx.tx.one(
    `update bank_accounts set statement_password_ciphertext = case when $3::boolean then $4 else statement_password_ciphertext end,
            statement_senders = case when $5::boolean then $6 else statement_senders end where tenant_id = $1 and id = $2 returning id`,
    [ctx.tenantId, id, ct !== undefined, ct ?? null, input.senders !== undefined, input.senders?.trim() || null],
  );
  if (!r) throw notFound('Account not found');
}

async function accounts(ctx: RecordCtx) {
  return ctx.tx.query<Acc>(
    `select b.id, a.name, b.kind, b.account_last4, b.bank_name, b.statement_password_ciphertext, b.statement_senders
       from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where b.tenant_id = $1 and b.is_active and b.kind in ('bank','credit_card','wallet')`,
    [ctx.tenantId],
  );
}

async function passwordOf(env: Env, tenantId: string, a: Acc): Promise<string | null> {
  if (!a.statement_password_ciphertext) return null;
  try {
    return (await readSecret<{ password?: string }>(env, { secret_ciphertext: a.statement_password_ciphertext, tenant_id: tenantId })).password ?? null;
  } catch {
    return null;
  }
}

/** The accounts this mail is likely about, best first: last four digits, then sender, then bank name. */
function rank(list: Acc[], hay: string, from: string) {
  const digits = new Set([...hay.matchAll(/(?:x{2,}|\*{2,}|ending\s*(?:with|in)?|a\/c\s*(?:no\.?)?|card\s*(?:no\.?)?)[\s:-]*(\d{4})\b/gi)].map((m) => m[1]!));
  const score = (a: Acc) =>
    (a.account_last4 && (digits.has(a.account_last4) || new RegExp(`\\b${a.account_last4}\\b`).test(hay)) ? 10 : 0) +
    (a.statement_senders && a.statement_senders.split(/[\s,;]+/).filter(Boolean).some((s) => from.toLowerCase().includes(s.toLowerCase())) ? 6 : 0) +
    (a.bank_name && hay.toLowerCase().includes(a.bank_name.toLowerCase().split(' ')[0]!) ? 2 : 0) +
    (/credit\s*card|card\s*statement/i.test(hay) ? (a.kind === 'credit_card' ? 1 : 0) : a.kind === 'bank' ? 1 : 0);
  return list.map((a) => ({ a, s: score(a) })).sort((x, y) => y.s - x.s);
}

export interface StatementResult {
  status: 'imported' | 'needs_password' | 'no_account' | 'no_lines' | 'unreadable';
  message: string;
  bankAccountId?: string;
  added?: number;
  skipped?: number;
}

/** Reads one mailed statement and imports it (the desk runs afterwards, outside this transaction). */
export async function readMailedStatement(ctx: RecordCtx, env: Env, itemId: string, opts: { password?: string | null; bankAccountId?: string | null; remember?: boolean } = {}): Promise<StatementResult> {
  const it = await ctx.tx.one<{ subject: string; from_address: string | null; body: string | null; attachments: { fileId: string; name: string; contentType: string }[]; data: Record<string, any> }>(
    `select subject, from_address, body, attachments, data from intake_items where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, itemId],
  );
  if (!it) throw notFound('Mail not found');
  const list = await accounts(ctx);
  if (!list.length) return save(ctx, itemId, it.data, { status: 'no_account', message: 'Add the bank account or card under Books → Banking first' });
  const files = it.attachments.filter((a) => /pdf|csv|text|excel|spreadsheet|officedocument/i.test(a.contentType) || /\.(pdf|csv|xlsx?)$/i.test(a.name));
  if (!files.length || !env.FILES) return save(ctx, itemId, it.data, { status: 'unreadable', message: 'No statement file on this mail' });
  const hay = `${it.subject}\n${it.body ?? ''}\n${files.map((f) => f.name).join(' ')}`;
  let order = rank(list, hay, it.from_address ?? '').map((x) => x.a);
  if (opts.bankAccountId) order = [list.find((a) => a.id === opts.bankAccountId) ?? notFoundAcc(), ...order.filter((a) => a.id !== opts.bankAccountId)];
  let lastError: StatementResult | null = null;
  for (const f of files) {
    const obj = await ctx.tx.one<{ storage_key: string }>(`select storage_key from files where tenant_id = $1 and id = $2`, [ctx.tenantId, f.fileId]);
    const body = obj && (await env.FILES.get(obj.storage_key));
    if (!body) continue;
    const bytes = new Uint8Array(await body.arrayBuffer());
    let rows: unknown[][] = [];
    let opened: Acc | null = null;
    let pdfText = '';
    if (/pdf/i.test(f.contentType) || /\.pdf$/i.test(f.name)) {
      // the typed password first, then each account's saved one (best-matching account first)
      const tries: { pw: string | undefined; acc: Acc | null }[] = [{ pw: undefined, acc: null }];
      if (opts.password) tries.unshift({ pw: opts.password, acc: opts.bankAccountId ? order[0]! : null });
      for (const a of order) {
        const pw = await passwordOf(env, ctx.tenantId, a);
        if (pw) tries.push({ pw, acc: a });
      }
      let pages: Awaited<ReturnType<typeof pdfItemsOf>> | null = null;
      let needs = false;
      for (const t of tries) {
        try {
          pages = await pdfItemsOf(bytes, t.pw);
          opened = t.acc;
          if (t.pw && opts.password === t.pw && opts.remember && opts.bankAccountId) {
            await setStatementPassword(ctx, env, opts.bankAccountId, { password: t.pw });
          }
          break;
        } catch (e) {
          if (e instanceof PdfPasswordNeeded) needs = true;
          else break;
        }
      }
      if (!pages) {
        lastError = needs
          ? { status: 'needs_password', message: `${f.name} is password-protected and none of the saved passwords opens it: enter it (and save it on the account)` }
          : { status: 'unreadable', message: `${f.name} could not be read` };
        continue;
      }
      pdfText = pages.map((p) => p.map((i) => i.str).join(' ')).join('\n');
      rows = rowsFromItems(pages);
    } else if (/csv|text/i.test(f.contentType) || /\.csv$/i.test(f.name)) {
      rows = csvRows(new TextDecoder().decode(bytes));
    } else {
      lastError = { status: 'unreadable', message: `${f.name}: Excel statements are read when uploaded on the accounts desk` };
      continue;
    }
    // the account: the one whose password opened it, else by the digits now readable in the statement
    const acc = opts.bankAccountId ? order[0]! : (opened ?? rank(list, `${hay}\n${pdfText.slice(0, 4000)}`, it.from_address ?? '')[0]?.a ?? null);
    const best = rank(list, `${hay}\n${pdfText.slice(0, 4000)}`, it.from_address ?? '')[0];
    if (!acc || (!opened && !opts.bankAccountId && (best?.s ?? 0) < 6)) {
      lastError = { status: 'no_account', message: 'Could not tell which account or card this statement is for: choose it' };
      continue;
    }
    const lines = linesFromRows(rows, { card: acc.kind === 'credit_card' });
    if (!lines.length) {
      lastError = { status: 'no_lines', message: `${f.name}: no transactions found (no header row with Date, Narration and Debit / Credit or Amount)`, bankAccountId: acc.id };
      continue;
    }
    const r = await importStatement(
      ctx,
      acc.id,
      lines.map((l): StatementRow => ({ date: l.date, description: l.description, reference: l.reference, amount: l.amount, balance: l.balance })),
      { source: 'statement', auto: false },
    );
    const res: StatementResult = { status: 'imported', message: `${r.added} line(s) added to ${acc.name}${r.skipped ? `, ${r.skipped} already there` : ''}`, bankAccountId: acc.id, added: r.added, skipped: r.skipped };
    await ctx.tx.query(`update intake_items set status = 'done', link_object = 'bank_account', link_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, itemId, acc.id]);
    return save(ctx, itemId, it.data, res);
  }
  return save(ctx, itemId, it.data, lastError ?? { status: 'unreadable', message: 'The statement could not be read' });
}

function notFoundAcc(): never {
  throw badRequest('Choose one of your bank accounts or cards');
}

async function save(ctx: RecordCtx, id: string, data: Record<string, any>, res: StatementResult) {
  await ctx.tx.query(`update intake_items set data = $3::jsonb where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, jsonSafe({ ...data, statement: { ...res, at: new Date().toISOString(), tries: Number(data.statement?.tries ?? 0) + 1 } }),
  ]);
  return res;
}

/** Every 5 minutes: mailed statements not read yet (a few tries each), then the desk for the accounts that got lines. */
export async function statementSweep(env: Env, db: Db) {
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  for (const t of tenants) {
    const run = <T>(fn: (ctx: RecordCtx) => Promise<T>, readOnly = false) =>
      db.tx({ tenantId: t.tenant_id, readOnly }, async (tx) => {
        const ctx = await systemCtxFor(env, tx, t.tenant_id);
        if (!ctx) throw new Error('workspace not found');
        return fn(ctx);
      });
    const due = await run(
      (ctx) =>
        ctx.tx.query<{ id: string }>(
          `select id from intake_items where tenant_id = $1 and kind = 'statement' and status = 'new' and coalesce((data -> 'statement' ->> 'tries')::int, 0) < 3
              and coalesce(data -> 'statement' ->> 'status', '') not in ('needs_password','no_account') order by received_at limit 5`,
          [t.tenant_id],
        ),
      true,
    ).catch(() => []);
    const touched = new Set<string>();
    for (const d of due) {
      const r = await run((ctx) => readMailedStatement(ctx, env, d.id)).catch(() => null);
      if (r?.status === 'imported' && r.bankAccountId && r.added) touched.add(r.bankAccountId);
    }
    for (const bankAccountId of touched) await runBookkeeper(systemDeps(env, db, t.tenant_id), { trigger: 'import', bankAccountId }).catch(() => undefined);
  }
}

export function systemDeps(env: Env, db: Db, tenantId: string): DeskDeps {
  return {
    env,
    db,
    tenantId,
    run: (fn, readOnly = false) =>
      db.tx({ tenantId, readOnly }, async (tx) => {
        const ctx = await systemCtxFor(env, tx, tenantId);
        if (!ctx) throw new Error('workspace not found');
        return fn(ctx);
      }),
    ai: null,
  };
}
