import { cleanText } from './json-safe';
/**
 * Rough text of a PDF, good enough to look for a GSTIN or a name in it: content streams are inflated
 * (FlateDecode) and the strings shown on the page (Tj / TJ, literal and hex) are collected. Fonts with
 * custom encodings come out as noise; that only means "not found", never a wrong match.
 */

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  for (const fmt of ['deflate', 'deflate-raw'] as const) {
    try {
      const ds = new DecompressionStream(fmt);
      const out = new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(await out);
    } catch {
      /* try the other framing */
    }
  }
  return null;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

function shownText(content: string): string {
  const out: string[] = [];
  // (literal strings) and <hex strings> inside text objects
  for (const m of content.matchAll(/\((?:\\.|[^\\)])*\)|<([0-9A-Fa-f\s]+)>/g)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, '');
      if (hex.length % 2) continue;
      let t = '';
      // two-byte (CID) or one-byte codes: keep printable characters only
      const two = hex.length % 4 === 0 && /^(00[0-9A-Fa-f]{2})+$/.test(hex);
      for (let i = 0; i < hex.length; i += two ? 4 : 2) t += String.fromCharCode(parseInt(hex.slice(i, i + (two ? 4 : 2)), 16));
      out.push(t);
    } else {
      out.push(
        m[0]
          .slice(1, -1)
          .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => (/^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '', f: '' } as Record<string, string>)[e] ?? e)),
      );
    }
  }
  return out.join('');
}

/** The text a PDF shows (best effort, at most ~2 MB of streams). */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const s = latin1(bytes);
  const parts: string[] = [];
  let budget = 2_000_000;
  for (const m of s.matchAll(/<<([^]*?)>>\s*stream\r?\n/g)) {
    if (budget <= 0) break;
    const start = m.index! + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const dict = m[1]!;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dict)) continue;
    // exactly /Length bytes when it is a number (a stray newline before "endstream" breaks inflating)
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let stop = len ? Math.min(end, start + Number(len[1])) : end;
    while (!len && stop > start && (bytes[stop - 1] === 10 || bytes[stop - 1] === 13)) stop--;
    const raw = bytes.subarray(start, stop);
    const body = /FlateDecode/.test(dict) ? await inflate(raw) : /\/Filter/.test(dict) ? null : raw;
    if (!body) continue;
    budget -= body.length;
    const text = latin1(body);
    if (/\bT[Jj]\b|\bTf\b/.test(text)) parts.push(shownText(text));
  }
  // plain-text strings outside streams (metadata, uncompressed files)
  parts.push(shownText(s.slice(0, 200_000)));
  return cleanText(parts.join('\n'));
}
