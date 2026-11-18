/**
 * Statement files in the browser: the reading itself lives in @synapse/shared (the server reads mailed
 * statements the same way); this adds Excel and PDF opening.
 */
import { csvRows, linesFromRows, type StatementLine } from '@synapse/shared';
import { pdfItems } from './statement-pdf';
import { rowsFromItems } from '@synapse/shared';
export { combineStatements, csvRows, linesFromRows, toIsoDate, type StatementLine } from '@synapse/shared';
export { PdfPasswordError } from './statement-pdf';

/** Reads a statement file (CSV, TSV, TXT, XLS, XLSX or PDF; a protected PDF needs its password). */
export async function readStatementFile(file: File, opts: { password?: string; card?: boolean } = {}): Promise<StatementLine[]> {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const pages = await pdfItems(await file.arrayBuffer(), opts.password);
    if (!pages.some((p) => p.some((i) => i.str.trim()))) throw new Error('This PDF has no text (a scanned statement); download the PDF, Excel or CSV statement from net banking instead');
    return linesFromRows(rowsFromItems(pages), opts);
  }
  if (/\.(xlsx?|xlsm)$/i.test(file.name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: true, defval: '' });
      const lines = linesFromRows(rows, opts);
      if (lines.length) return lines;
    }
    return [];
  }
  return linesFromRows(csvRows(await file.text()), opts);
}

