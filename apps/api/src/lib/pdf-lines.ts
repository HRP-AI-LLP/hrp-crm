/**
 * The text of a PDF as lines (positions kept, so a label and its value on one table row stay on one
 * line), read with pdf.js built for Workers (unpdf). Works for fonts with ToUnicode maps, which the
 * quick reader in pdf-text.ts cannot decode (GeM bid documents, most generated invoices).
 */

type Item = { str: string; transform: number[]; width: number; height: number };

function pageText(items: Item[]): string {
  const xs = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({ s: i.str, x: i.transform[4]!, y: i.transform[5]!, w: i.width, h: Math.abs(i.height || i.transform[3]! || 8) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; parts: typeof xs }[] = [];
  for (const it of xs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, Math.min(it.h, 10) * 0.45)) last.parts.push(it);
    else lines.push({ y: it.y, parts: [it] });
  }
  return lines
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p, i, all) => {
          const prev = all[i - 1];
          const gap = prev ? p.x - (prev.x + prev.w) : 0;
          return `${i ? (gap > Math.max(p.h, prev!.h) * 2.2 ? '\t' : gap > 0.5 ? ' ' : '') : ''}${p.s.trim()}`;
        })
        .join(''),
    )
    .join('\n');
}

/** Pages of text, at most `maxPages`; null when the file cannot be read (protected, not a PDF). */
export async function pdfLines(bytes: Uint8Array, maxPages = 60): Promise<string[] | null> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const out: string[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      out.push(pageText(tc.items as Item[]));
    }
    await doc.destroy?.();
    return out;
  } catch {
    return null;
  }
}

/** Links in a PDF (annotations): label is the text under the link when pdf.js gives none. */
export async function pdfLinks(bytes: Uint8Array): Promise<string[]> {
  try {
    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const urls = new Set<string>();
    for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
      const page = await doc.getPage(p);
      for (const a of (await page.getAnnotations()) as { url?: string; unsafeUrl?: string }[]) {
        const u = a.url ?? a.unsafeUrl;
        if (u && /^https?:\/\//i.test(u)) urls.add(u);
      }
    }
    await doc.destroy?.();
    return [...urls];
  } catch {
    return [];
  }
}
