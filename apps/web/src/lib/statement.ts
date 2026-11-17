/**
 * Bank statement files → statement lines.
 *
 * Indian banks export statements with a few lines of account details before the real header
 * (ICICI, HDFC, SBI, Axis, Kotak…), dates as 01/04/2026, 01-Apr-26 or Excel serials, and amounts
 * either signed, in Debit / Credit (Withdrawal / Deposit) columns, or with a Dr / Cr marker. This finds
 * the header row, maps the columns and reads every line. Excel files (.xls / .xlsx) are read with
 * SheetJS, loaded only when such a file is chosen.
 */
export interface StatementLine {
  date: string;
  description: string;
  reference: string | null;
  amount: number;
  balance: number | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toIsoDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial day (1900 system)
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10);
  }
  const t = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})[/\-. ](\d{1,2}|[A-Za-z]{3,9})[/\-. ,]+(\d{2,4})(?:\s.*)?$/.exec(t);
  if (!m) return '';
  const mon = /^\d+$/.test(m[2]!) ? Number(m[2]) : MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
  const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = Number(m[1]);
  if (!mon || mon > 12 || !d || d > 31 || y < 1990 || y > 2100) return '';
  return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (!s || s === '-') return 0;
  const neg = /^\(.*\)$/.test(s) || /\bdr\.?$/i.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[₹,\s()]|INR|Rs\.?|cr\.?$|dr\.?$/gi, '').replace(/^-/, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

/** Splits CSV / TSV text into rows (quoted cells understood). */
export function csvRows(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',';
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (ch === sep && !q) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

const words = (h: unknown) =>
  String(h ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Finds the header row and reads the lines below it. */
export function linesFromRows(rows: unknown[][]): StatementLine[] {
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const ws = (rows[i] ?? []).map(words);
    const has = (...n: string[]) => ws.some((w) => n.some((x) => w.includes(x)));
    if (has('date') && (has('amount', 'debit', 'withdrawal', 'withdrawals', 'credit', 'deposit', 'deposits', 'dr', 'cr')) && has('narration', 'description', 'particulars', 'details', 'remarks', 'transaction')) {
      hi = i;
      break;
    }
  }
  if (hi < 0) return [];
  const head = (rows[hi] ?? []).map(words);
  // a "Dr / Cr" or "Type" column says the direction of an Amount column; it holds no amounts itself
  const isType = (ws: string[]) => (ws.includes('dr') && ws.includes('cr')) || (ws.length <= 2 && ws.includes('type'));
  const col = (...names: string[]) => head.findIndex((ws) => !isType(ws) && names.some((n) => ws.includes(n)));
  // the transaction date, not the value date, when both are there
  let cDate = head.findIndex((ws) => ws.includes('date') && (ws.includes('txn') || ws.includes('transaction') || ws.includes('tran') || ws.length === 1));
  if (cDate < 0) cDate = col('date');
  const cDesc = col('narration', 'description', 'particulars', 'details', 'remarks');
  const cRef = head.findIndex((ws) => ws.some((w) => ['ref', 'reference', 'cheque', 'chq', 'utr', 'instrument'].includes(w)) && !ws.includes('date'));
  const cDr = col('debit', 'withdrawal', 'withdrawals', 'dr');
  const cCr = col('credit', 'deposit', 'deposits', 'cr');
  const cAmt = cDr < 0 && cCr < 0 ? head.findIndex((ws) => ws.includes('amount')) : -1;
  const cType = head.findIndex(isType);
  const cBal = col('balance');
  const out: StatementLine[] = [];
  for (const r of rows.slice(hi + 1)) {
    const date = toIsoDate(r[cDate]);
    if (!date) continue;
    let amount = cAmt >= 0 ? num(r[cAmt]) : num(r[cCr]) - Math.abs(num(r[cDr]));
    if (cAmt >= 0 && cType >= 0 && /^d/i.test(String(r[cType] ?? '').trim())) amount = -Math.abs(amount);
    if (!amount) continue;
    out.push({
      date,
      description: String(r[cDesc] ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || '(no description)',
      reference: cRef >= 0 && r[cRef] != null && String(r[cRef]).trim() ? String(r[cRef]).trim().slice(0, 120) : null,
      amount: Math.round(amount * 100) / 100,
      balance: cBal >= 0 && r[cBal] != null && String(r[cBal]).trim() !== '' ? num(r[cBal]) : null,
    });
  }
  return out;
}

import { pdfItems, rowsFromItems } from './statement-pdf';
export { PdfPasswordError } from './statement-pdf';

/** Reads a statement file (CSV, TSV, TXT, XLS, XLSX or PDF; a protected PDF needs its password). */
export async function readStatementFile(file: File, opts: { password?: string } = {}): Promise<StatementLine[]> {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pages = await pdfItems(await file.arrayBuffer(), opts.password);
    if (!pages.some((p) => p.some((i) => i.str.trim()))) throw new Error('This PDF has no text (a scanned statement); download the PDF, Excel or CSV statement from net banking instead');
    return linesFromRows(rowsFromItems(pages));
  }
  if (/\.(xlsx?|xlsm)$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: '' });
      const lines = linesFromRows(rows);
      if (lines.length) return lines;
    }
    return [];
  }
  return linesFromRows(csvRows(await file.text()));
}

/**
 * Several statement files → one set of lines. Statements that overlap (last month's and a
 * year-to-date download) repeat lines; a line already in an earlier file is dropped, while the same
 * line twice within one file (two equal payments on a day) is kept.
 */
export function combineStatements(files: { name: string; lines: StatementLine[] }[]) {
  const seen = new Map<string, number>();
  const out: StatementLine[] = [];
  let duplicates = 0;
  for (const f of files) {
    const mine = new Map<string, number>();
    for (const l of f.lines) {
      const k = `${l.date}|${l.amount.toFixed(2)}|${l.description.trim().toLowerCase()}|${(l.reference ?? '').trim()}|${l.balance ?? ''}`;
      const before = seen.get(k) ?? 0;
      const used = mine.get(k) ?? 0;
      mine.set(k, used + 1);
      if (used < before) {
        duplicates++;
        continue;
      }
      out.push(l);
    }
    for (const [k, n] of mine) seen.set(k, Math.max(seen.get(k) ?? 0, n));
  }
  return { lines: out.sort((a, b) => a.date.localeCompare(b.date)), duplicates };
}
