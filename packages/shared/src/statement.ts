/**
 * Bank statement PDFs (positioned text runs) → rows of cells, for linesFromRows (statement.ts).
 *
 * Statements from net banking are text PDFs laid out as a table. The text runs (with positions) are
 * grouped into lines, the header line gives the columns, and every run lands in the column it sits
 * under: text by where it starts, amounts by where they end (they are right-aligned). A line without a
 * date continues the narration of the line above (narrations often wrap). Later pages without a header
 * reuse the columns of the last one. Password-protected statements (common in India: the password is
 * usually a mix of name and date of birth or customer id) are opened with the password the person types.
 * Scanned (image) PDFs have no text and are reported as such.
 */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Col {
  text: string;
  start: number;
  end: number;
}
const isAmount = (s: string) => /^[-(]?(?:₹|rs\.?|inr)?\s*[\d,]+\.\d{1,2}\)?\s*(?:cr|dr)?\.?$/i.test(s.trim());
const isDateLike = (s: string) => /^\d{1,2}[/\-. ](\d{1,2}|[A-Za-z]{3,9})[/\-. ,]+\d{2,4}/.test(s.trim()) || /^\d{4}-\d{2}-\d{2}/.test(s.trim());
const HEADER = (t: string) =>
  /\bdate\b/.test(t) && /(narration|description|particulars|details|remarks)/.test(t) && /(debit|withdrawal|credit|deposit|amount|\bdr\b|\bcr\b)/.test(t);

/**
 * pdf.js joins nearby runs ("Deposit Amt. Closing Balance", "01/11/26 11,800.00"), so every run is split
 * into words with positions estimated from the run's width.
 */
function words(items: PdfItem[]): PdfItem[] {
  const out: PdfItem[] = [];
  for (const it of items) {
    const s = it.str;
    if (!s.trim()) continue;
    const cw = it.w > 0 ? it.w / s.length : (it.h || 8) * 0.5;
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      // "Amt.Closing": a title glued to the next one
      let off = 0;
      for (const part of m[0].split(/(?<=[a-z]\.)(?=[A-Z][a-z])/)) {
        out.push({ str: part, x: it.x + (m.index + off) * cw, y: it.y, w: part.length * cw, h: it.h });
        off += part.length;
      }
    }
  }
  return out;
}

/** Groups a page's words into lines (top to bottom), each sorted left to right. */
function lines(items: PdfItem[]): PdfItem[][] {
  const xs = words(items).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: PdfItem[][] = [];
  for (const it of xs) {
    const last = out[out.length - 1];
    const tol = Math.max(2, Math.min(it.h || 8, 10) * 0.45);
    if (last && Math.abs(last[0]!.y - it.y) <= tol) last.push(it);
    else out.push([it]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

const normWord = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]/g, '');
// column titles banks use, longest first, as normalised words
const PHRASES = [
  'transaction date', 'txn date', 'tran date', 'value date', 'value dt', 'post date', 'posting date',
  'transaction remarks', 'transaction details', 'transaction particulars',
  'chq/ref no', 'chqrefno', 'chq / ref no', 'ref no/cheque no', 'cheque number', 'cheque no', 'chq no', 'ref no', 'instrument id',
  'withdrawal amount inr', 'withdrawal amount', 'withdrawal amt', 'deposit amount inr', 'deposit amount', 'deposit amt',
  'debit amount', 'credit amount', 'closing balance', 'balance inr', 'dr / cr', 'dr/cr', 's no', 'sl no', 'sr no',
  'date', 'narration', 'description', 'particulars', 'details', 'remarks', 'reference', 'utr', 'withdrawals', 'withdrawal',
  'deposits', 'deposit', 'debit', 'credit', 'amount', 'balance', 'type',
]
  .map((p) => p.split(' ').map(normWord).filter(Boolean))
  .sort((a, b) => b.length - a.length);

/** Header words → columns, recognising multi-word titles ("Closing Balance", "Withdrawal Amt."). */
function columns(header: PdfItem[]): Col[] {
  const cols: Col[] = [];
  const toks = header.map((h) => ({ ...h, n: normWord(h.str) })).filter((t) => t.n);
  for (let i = 0; i < toks.length; ) {
    const ph = PHRASES.find((p) => p.every((w, k) => toks[i + k]?.n === w));
    const take = ph ? ph.length : 1;
    const part = toks.slice(i, i + take);
    const start = part[0]!.x;
    const end = part[part.length - 1]!.x + part[part.length - 1]!.w;
    const text = part.map((t) => t.str).join(' ');
    const prev = cols[cols.length - 1];
    const cw = part[0]!.w / Math.max(1, part[0]!.str.length);
    // leftovers like "(INR" ")" or an unknown word right next to a column belong to it
    if (!ph && prev && start - prev.end < cw * 2.5) {
      prev.text += ` ${text}`;
      prev.end = end;
    } else cols.push({ text, start, end });
    i += take;
  }
  return cols;
}

export function rowsFromItems(pages: PdfItem[][]): string[][] {
  let cols: Col[] | null = null;
  let headerRow: string[] | null = null;
  const rows: string[][] = [];
  let dateCol = -1;
  let descCol = -1;
  for (const page of pages) {
    for (const line of lines(page)) {
      const text = line.map((i) => i.str).join(' ').toLowerCase();
      if (HEADER(text)) {
        cols = columns(line);
        if (!headerRow) headerRow = cols.map((c) => c.text);
        const lc = cols.map((c) => c.text.toLowerCase());
        dateCol = lc.findIndex((t) => /\bdate\b/.test(t) && !/value/.test(t));
        if (dateCol < 0) dateCol = lc.findIndex((t) => /\bdate\b/.test(t));
        descCol = lc.findIndex((t) => /(narration|description|particulars|details|remarks)/.test(t));
        continue;
      }
      if (!cols) continue;
      const cells = cols.map(() => '');
      for (const it of line) {
        const s = it.str.trim();
        let k: number;
        if (isAmount(s)) {
          // right-aligned: the column whose header ends nearest to where the amount ends
          const right = it.x + it.w;
          k = cols.reduce((best, c, i) => (Math.abs(c.end - right) < Math.abs(cols![best]!.end - right) ? i : best), 0);
        } else {
          k = 0;
          for (let i = 0; i < cols.length; i++) if (cols[i]!.start <= it.x + 3) k = i;
        }
        cells[k] = cells[k] ? `${cells[k]} ${s}` : s;
      }
      const hasDate = dateCol >= 0 && isDateLike(cells[dateCol] ?? '');
      if (!hasDate) {
        // a wrapped narration (no date, no amounts) belongs to the line above
        const prev = rows[rows.length - 1];
        const onlyText = cells.every((c, i) => !c || i === descCol || !isAmount(c));
        if (prev && onlyText && descCol >= 0) {
          const extra = cells.filter(Boolean).join(' ');
          if (extra && extra.length < 200) prev[descCol] = `${prev[descCol]} ${extra}`.trim();
        }
        continue;
      }
      rows.push(cells);
    }
  }
  return headerRow ? [headerRow, ...rows] : [];
}


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

const headWords = (h: unknown) =>
  String(h ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Finds the header row and reads the lines below it. */
/**
 * Card statements read the other way round: an amount with no sign is a purchase (what the card owes
 * goes up, written as a minus here as for money leaving a bank account); "Cr", a minus or brackets mark
 * a payment or refund to the card.
 */
export function linesFromRows(rows: unknown[][], opts: { card?: boolean } = {}): StatementLine[] {
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const ws = (rows[i] ?? []).map(headWords);
    const has = (...n: string[]) => ws.some((w) => n.some((x) => w.includes(x)));
    if (has('date') && (has('amount', 'debit', 'withdrawal', 'withdrawals', 'credit', 'deposit', 'deposits', 'dr', 'cr')) && has('narration', 'description', 'particulars', 'details', 'remarks', 'transaction')) {
      hi = i;
      break;
    }
  }
  if (hi < 0) return [];
  const head = (rows[hi] ?? []).map(headWords);
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
    if (cAmt >= 0 && cType >= 0) amount = /^d/i.test(String(r[cType] ?? '').trim()) ? -Math.abs(amount) : opts.card && /^c/i.test(String(r[cType] ?? '').trim()) ? Math.abs(amount) : amount;
    if (opts.card && cAmt >= 0 && cType < 0) {
      const raw = String(r[cAmt] ?? '').trim();
      const credit = typeof r[cAmt] === 'number' ? Number(r[cAmt]) < 0 : /\bcr\.?$/i.test(raw) || /^-|^\(.*\)$/.test(raw);
      amount = credit ? Math.abs(amount) : -Math.abs(amount);
    }
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
