/**
 * Bank statement PDFs → rows of cells, for linesFromRows (statement.ts).
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

export class PdfPasswordError extends Error {
  constructor(public wrong: boolean) {
    super(wrong ? 'That password is not right' : 'This PDF is password-protected');
  }
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]/g, '');
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
  .map((p) => p.split(' ').map(norm).filter(Boolean))
  .sort((a, b) => b.length - a.length);

/** Header words → columns, recognising multi-word titles ("Closing Balance", "Withdrawal Amt."). */
function columns(header: PdfItem[]): Col[] {
  const cols: Col[] = [];
  const toks = header.map((h) => ({ ...h, n: norm(h.str) })).filter((t) => t.n);
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

/** Reads the text of every page with pdf.js (loaded only when a PDF is chosen). */
export async function pdfItems(data: ArrayBuffer, password?: string): Promise<PdfItem[][]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(data), password, isEvalSupported: false }).promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === 'PasswordException') throw new PdfPasswordError(err.code === 2);
    throw e;
  }
  const pages: PdfItem[][] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 200); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push(
      (tc.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
        .filter((i) => typeof i.str === 'string' && i.transform)
        .map((i) => ({ str: i.str!, x: i.transform![4]!, y: i.transform![5]!, w: i.width ?? 0, h: i.height ?? Math.abs(i.transform![3] ?? 8) })),
    );
  }
  await doc.destroy();
  return pages;
}
