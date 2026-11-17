/**
 * A small RFC 5322 / MIME reader for mail fetched over IMAP or from Gmail / Outlook in raw form:
 * headers (folded, RFC 2047 encoded words), multipart bodies, base64 and quoted-printable, charsets,
 * and attachments (RFC 2231 file names). Enough for business mail; not a full MUA.
 */

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  inline: boolean;
}

export interface ParsedMail {
  messageId: string | null;
  date: string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  html: string | null;
  attachments: ParsedAttachment[];
}

/** Bytes as a "binary string" (one char per byte), the form the structure is parsed in. */
export const toBinary = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const fromBinary = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

function decodeCharset(bytes: Uint8Array, charset: string | null | undefined) {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  for (const c of [cs, cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : null, 'utf-8']) {
    if (!c) continue;
    try {
      return new TextDecoder(c === 'iso-8859-1' || c === 'latin1' ? 'windows-1252' : c).decode(bytes);
    } catch {
      /* unknown charset: try the next */
    }
  }
  return toBinary(bytes);
}

function b64(s: string) {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    return fromBinary(atob(clean.replace(/=+$/, '').padEnd(Math.ceil(clean.replace(/=+$/, '').length / 4) * 4, '=')));
  } catch {
    return new Uint8Array();
  }
}

function qp(s: string, header = false) {
  const src = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

/** "=?UTF-8?B?…?= =?UTF-8?Q?…?=" → text (header values arrive as binary strings). */
export function decodeWords(v: string): string {
  const joined = v.replace(/\?=\s+=\?/g, '?==?');
  const parts = joined.split(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)/);
  return parts
    .map((p) => {
      const m = /^=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=$/.exec(p);
      if (!m) return /[\x80-\xff]/.test(p) ? decodeCharset(fromBinary(p), 'utf-8') : p;
      const bytes = m[2]!.toUpperCase() === 'B' ? b64(m[3]!) : qp(m[3]!, true);
      return decodeCharset(bytes, m[1]);
    })
    .join('');
}

export function parseHeaders(block: string): Map<string, string[]> {
  const h = new Map<string, string[]>();
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase();
    h.set(k, [...(h.get(k) ?? []), l.slice(i + 1).trim()]);
  }
  return h;
}

/** `text/plain; charset="utf-8"; name*=UTF-8''r%C3%A9sum%C3%A9.pdf` → value and parameters. */
export function headerParams(v: string | undefined): { value: string; params: Record<string, string> } {
  if (!v) return { value: '', params: {} };
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  const continued: Record<string, string[]> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let val = p.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const cont = /^(.+?)\*(\d+)\*?$/.exec(key);
    if (cont) (continued[cont[1]!] ??= [])[Number(cont[2])] = key.endsWith('*') ? val : val;
    else if (key.endsWith('*')) params[key.slice(0, -1)] = rfc2231(val);
    else params[key] = decodeWords(val);
  }
  for (const [k, xs] of Object.entries(continued)) {
    const v2 = xs.join('');
    params[k] = /^[^']*'[^']*'/.test(v2) ? rfc2231(v2) : decodeWords(v2);
  }
  return { value: parts[0]!.trim().toLowerCase(), params };
}

function rfc2231(v: string) {
  const m = /^([^']*)'[^']*'(.*)$/.exec(v);
  const enc = m ? m[2]! : v;
  const bytes = fromBinary(enc.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return decodeCharset(bytes, m?.[1] || 'utf-8');
}

/** "Name <a@b.c>, other@x.y" → addresses. */
export function parseAddresses(v: string | undefined): MailAddress[] {
  if (!v) return [];
  const s = decodeWords(v);
  const out: MailAddress[] = [];
  for (const part of s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part);
    const address = (m ? m[2]! : part).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) continue;
    out.push({ name: m && m[1]!.trim() ? m[1]!.trim() : null, address });
  }
  return out;
}

function bodyBytes(body: string, encoding: string) {
  const e = encoding.toLowerCase();
  if (e === 'base64') return b64(body);
  if (e === 'quoted-printable') return qp(body);
  return fromBinary(body);
}

interface Walk {
  text: string[];
  html: string[];
  attachments: ParsedAttachment[];
}

function walk(raw: string, out: Walk, depth = 0) {
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  const body = sep ? raw.slice(sep.index + sep[0].length) : '';
  const h = parseHeaders(head);
  const ct = headerParams(h.get('content-type')?.[0] ?? 'text/plain');
  const cd = headerParams(h.get('content-disposition')?.[0]);
  const enc = (h.get('content-transfer-encoding')?.[0] ?? '7bit').trim();
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 12) {
    const b = `--${ct.params.boundary}`;
    const chunks = body.split(b);
    for (const c of chunks.slice(1)) {
      if (c.startsWith('--')) break;
      walk(c.replace(/^\r?\n/, '').replace(/\r?\n$/, ''), out, depth + 1);
    }
    return;
  }
  if (ct.value === 'message/rfc822' && depth < 12) {
    // a forwarded mail: its parts count as this mail's
    walk(enc.toLowerCase() === 'base64' ? toBinary(b64(body)) : body, out, depth + 1);
    return;
  }
  const filename = cd.params.filename ?? ct.params.name ?? null;
  const isText = (ct.value === 'text/plain' || ct.value === 'text/html') && cd.value !== 'attachment' && !filename;
  if (isText) {
    const t = decodeCharset(bodyBytes(body, enc), ct.params.charset);
    (ct.value === 'text/html' ? out.html : out.text).push(t);
    return;
  }
  const bytes = bodyBytes(body, enc);
  if (!bytes.length) return;
  out.attachments.push({ filename: filename || `attachment-${out.attachments.length + 1}`, contentType: ct.value || 'application/octet-stream', bytes, inline: cd.value === 'inline' && !filename });
}

export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parses a whole message (bytes as received). */
export function parseMail(raw: Uint8Array | string): ParsedMail {
  const s = typeof raw === 'string' ? raw : toBinary(raw);
  const sep = /\r?\n\r?\n/.exec(s);
  const h = parseHeaders(sep ? s.slice(0, sep.index) : s);
  const out: Walk = { text: [], html: [], attachments: [] };
  walk(s, out);
  const html = out.html.length ? out.html.join('\n') : null;
  const text = out.text.length ? out.text.join('\n').trim() : html ? htmlText(html) : '';
  const d = h.get('date')?.[0];
  const when = d ? new Date(d.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  return {
    messageId: (h.get('message-id')?.[0] ?? '').replace(/^<|>$/g, '').trim() || null,
    date: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
    from: parseAddresses(h.get('from')?.[0])[0] ?? null,
    to: parseAddresses(h.get('to')?.join(', ')),
    cc: parseAddresses(h.get('cc')?.join(', ')),
    subject: decodeWords(h.get('subject')?.[0] ?? '').replace(/\s+/g, ' ').trim(),
    text,
    html,
    attachments: out.attachments.filter((a) => !a.inline),
  };
}
