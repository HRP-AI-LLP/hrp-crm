/** The text of a Word document (.docx), read in the browser: one line per paragraph, tabs and line breaks kept. */
import { strFromU8, unzipSync } from 'fflate';

export async function docxText(file: Blob): Promise<string> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('This is not a Word document (.docx)');
  const doc = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const lines: string[] = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    let line = '';
    const walk = (n: Element) => {
      for (const c of Array.from(n.children)) {
        if (c.namespaceURI === W && c.localName === 't') line += c.textContent ?? '';
        else if (c.namespaceURI === W && c.localName === 'tab') line += '\t';
        else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) line += '\n';
        else if (!(c.namespaceURI === W && c.localName === 'p')) walk(c);
      }
    };
    walk(p);
    lines.push(line);
  }
  // runs of empty paragraphs become one blank line
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
