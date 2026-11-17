/**
 * Reads documents in the browser for the invoice import: PDF text per page (positions kept so table
 * rows stay on one line), PDF pages without text (scans) and photos as JPEG pictures for the AI model,
 * and spreadsheets as rows (one entry per sheet). Nothing here decides what a document says; the server
 * does (rules first, AI when unsure).
 */
import { pdfItems } from './statement-pdf';
export { PdfPasswordError } from './statement-pdf';

export interface ReadPart {
  /** "file.pdf", or "book.xlsx › Sheet1" */
  name: string;
  pages?: string[];
  rows?: (string | number | boolean | null)[][];
  images?: { mime: 'image/jpeg'; data: string }[];
}

const MAX_SIDE = 1600;

function toJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1]!;
}

async function imageFile(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return toJpeg(c);
}

/** Lines of a page from positioned text runs (top to bottom, left to right). */
function pageText(items: { str: string; x: number; y: number; h: number }[]) {
  const xs = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of xs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, Math.min(it.h || 8, 10) * 0.45)) last.parts.push({ x: it.x, s: it.str });
    else lines.push({ y: it.y, parts: [{ x: it.x, s: it.str }] });
  }
  return lines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join(' ')).join('\n');
}

async function pdfPages(file: File, password?: string): Promise<ReadPart[]> {
  const data = await file.arrayBuffer();
  const pages = await pdfItems(data.slice(0), password);
  const texts = pages.map((p) => pageText(p));
  const scanned = texts.map((t, i) => (t.replace(/\s+/g, '').length < 40 ? i : -1)).filter((i) => i >= 0);
  if (!scanned.length) return [{ name: file.name, pages: texts }];
  // pages without text are pictures: render them for the AI model
  const pdfjs = await import('pdfjs-dist');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), password, isEvalSupported: false }).promise;
  const images: { mime: 'image/jpeg'; data: string }[] = [];
  for (const i of scanned.slice(0, 40)) {
    const page = await doc.getPage(i + 1);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, MAX_SIDE / Math.max(v1.width, v1.height)) });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    await page.render({ canvasContext: c.getContext('2d')!, viewport, canvas: c } as never).promise;
    images.push({ mime: 'image/jpeg', data: toJpeg(c) });
  }
  await doc.destroy();
  const out: ReadPart[] = [];
  const textPages = texts.filter((_, i) => !scanned.includes(i));
  if (textPages.length) out.push({ name: file.name, pages: textPages });
  // a few pages per request: each request is one AI reading
  for (let k = 0; k < images.length; k += 6) out.push({ name: images.length > 6 ? `${file.name} (scanned pages ${k + 1}–${Math.min(k + 6, images.length)})` : `${file.name} (scanned)`, images: images.slice(k, k + 6) });
  return out;
}

export async function readDocument(file: File, opts: { password?: string } = {}): Promise<ReadPart[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return pdfPages(file, opts.password);
  if (/\.(xlsx?|xlsm|csv|tsv)$/.test(name)) {
    const XLSX = await import('xlsx');
    const wb = /\.(csv|tsv)$/.test(name) ? XLSX.read(await file.text(), { type: 'string', cellDates: false }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
    const out: ReadPart[] = [];
    for (const sheet of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(wb.Sheets[sheet]!, { header: 1, raw: true, defval: null }).filter((r) => r.some((c) => c !== null && c !== ''));
      if (rows.length > 1) out.push({ name: wb.SheetNames.length > 1 ? `${file.name} › ${sheet}` : file.name, rows: rows.slice(0, 20000).map((r) => r.slice(0, 200).map((c) => (typeof c === 'string' ? c.slice(0, 2000) : c))) });
    }
    return out;
  }
  if (/\.(jpe?g|png|webp|bmp|gif|heic)$/.test(name) || file.type.startsWith('image/')) return [{ name: file.name, images: [{ mime: 'image/jpeg', data: await imageFile(file) }] }];
  if (/\.(txt)$/.test(name)) return [{ name: file.name, pages: [await file.text()] }];
  throw new Error('Use PDF, Excel, CSV or a photo / scan (JPG, PNG)');
}
