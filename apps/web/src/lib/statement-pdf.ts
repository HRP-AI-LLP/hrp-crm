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
import type { PdfItem } from '@synapse/shared';
export { rowsFromItems, type PdfItem } from '@synapse/shared';

export class PdfPasswordError extends Error {
  constructor(public wrong: boolean) {
    super(wrong ? 'That password is not right' : 'This PDF is password-protected');
  }
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
