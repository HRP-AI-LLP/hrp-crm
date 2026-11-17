/**
 * A minimal IMAP4rev1 client over TLS (Cloudflare Workers TCP sockets): log in, open a folder, find
 * messages by UID or date, read headers, read whole messages. Read-only — it never changes flags
 * (BODY.PEEK) or deletes anything.
 */
import { connect } from 'cloudflare:sockets';

export class ImapError extends Error {
  constructor(
    message: string,
    public auth = false,
  ) {
    super(message);
  }
}

interface Response {
  /** untagged lines with the literals that followed each */
  untagged: { line: string; literals: Uint8Array[] }[];
  status: 'OK' | 'NO' | 'BAD';
  text: string;
}

const enc = new TextEncoder();
const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ImapOptions {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
  timeoutMs?: number;
}

export class ImapClient {
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private socket!: ReturnType<typeof connect>;
  private buf = new Uint8Array(0);
  private n = 0;
  private deadline = 0;

  constructor(private o: ImapOptions) {}

  private async fill() {
    if (Date.now() > this.deadline) throw new ImapError('The mail server is taking too long to answer');
    const t = this.deadline - Date.now();
    const r = await Promise.race([
      this.reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new ImapError('The mail server is taking too long to answer')), Math.max(1, t))),
    ]);
    if (r.done || !r.value) throw new ImapError('The mail server closed the connection');
    const next = new Uint8Array(this.buf.length + r.value.length);
    next.set(this.buf);
    next.set(r.value, this.buf.length);
    this.buf = next;
  }

  private async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const l = latin1(this.buf.subarray(0, i)).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        return l;
      }
      if (this.buf.length > 1_000_000) throw new ImapError('The mail server sent a line that is too long');
      await this.fill();
    }
  }

  private async bytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  private async write(s: string) {
    await this.writer.write(enc.encode(s));
  }

  /** Sends a command and reads everything up to its tagged completion. */
  private async cmd(c: string, opts: { maxLiteral?: number } = {}): Promise<Response> {
    const tag = `S${++this.n}`;
    await this.write(`${tag} ${c}\r\n`);
    const untagged: Response['untagged'] = [];
    for (;;) {
      let l = await this.line();
      if (l.startsWith(`${tag} `)) {
        const m = /^\S+ (OK|NO|BAD)\s*(.*)$/.exec(l);
        return { untagged, status: (m?.[1] as Response['status']) ?? 'BAD', text: m?.[2] ?? l };
      }
      if (l.startsWith('+')) continue;
      const item = { line: l, literals: [] as Uint8Array[] };
      // a line ending in {n} is followed by n bytes, then the rest of the response
      for (let m = /\{(\d+)\}$/.exec(l); m; m = /\{(\d+)\}$/.exec(l)) {
        const size = Number(m[1]);
        if (opts.maxLiteral && size > opts.maxLiteral) {
          await this.bytes(size); // read and drop
          item.literals.push(new Uint8Array());
        } else item.literals.push(await this.bytes(size));
        l = await this.line();
        item.line += ` ${l}`;
      }
      untagged.push(item);
    }
  }

  private ok(r: Response, what: string) {
    if (r.status !== 'OK') throw new ImapError(`${what}: ${r.text || r.status}`, what === 'Sign-in');
    return r;
  }

  async open() {
    this.deadline = Date.now() + (this.o.timeoutMs ?? 25_000);
    this.socket = connect({ hostname: this.o.host, port: this.o.port }, { secureTransport: this.o.tls ? 'on' : 'off', allowHalfOpen: false });
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    const hello = await this.line();
    if (!/^\* (OK|PREAUTH)/i.test(hello)) throw new ImapError(`Unexpected greeting from the mail server: ${hello.slice(0, 120)}`);
    if (/^\* OK/i.test(hello)) this.ok(await this.cmd(`LOGIN ${quote(this.o.user)} ${quote(this.o.pass)}`), 'Sign-in');
  }

  /** Opens a folder read-only. */
  async examine(folder = 'INBOX') {
    const r = this.ok(await this.cmd(`EXAMINE ${quote(folder)}`), `Opening ${folder}`);
    let uidValidity = 0;
    let uidNext = 0;
    let exists = 0;
    for (const u of r.untagged) {
      const v = /UIDVALIDITY (\d+)/i.exec(u.line);
      if (v) uidValidity = Number(v[1]);
      const n = /UIDNEXT (\d+)/i.exec(u.line);
      if (n) uidNext = Number(n[1]);
      const e = /^\* (\d+) EXISTS/i.exec(u.line);
      if (e) exists = Number(e[1]);
    }
    return { uidValidity, uidNext, exists };
  }

  /** UIDs above `after`, or (first time) since a date. */
  async search(q: { afterUid?: number; since?: string }) {
    const crit = q.afterUid !== undefined ? `UID ${q.afterUid + 1}:*` : (() => {
      const d = new Date(`${q.since}T00:00:00Z`);
      return `SINCE ${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
    })();
    const r = this.ok(await this.cmd(`UID SEARCH ${crit}`), 'Searching');
    const ids = r.untagged.flatMap((u) => (/^\* SEARCH/i.test(u.line) ? u.line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number) : []));
    // "n:*" always returns the last message even when it is below n
    return ids.filter((x) => Number.isFinite(x) && (q.afterUid === undefined || x > q.afterUid)).sort((a, b) => a - b);
  }

  /** Header block and size of each UID (without marking anything read). */
  async headers(uids: number[]): Promise<{ uid: number; size: number; header: Uint8Array }[]> {
    if (!uids.length) return [];
    const out: { uid: number; size: number; header: Uint8Array }[] = [];
    for (let i = 0; i < uids.length; i += 100) {
      const set = uids.slice(i, i + 100).join(',');
      const r = this.ok(await this.cmd(`UID FETCH ${set} (UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`), 'Reading headers');
      for (const u of r.untagged) {
        const uid = /UID (\d+)/i.exec(u.line);
        if (!uid || !/FETCH/i.test(u.line)) continue;
        out.push({ uid: Number(uid[1]), size: Number(/RFC822\.SIZE (\d+)/i.exec(u.line)?.[1] ?? 0), header: u.literals[0] ?? new Uint8Array() });
      }
    }
    return out;
  }

  /** The whole message. */
  async message(uid: number, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array | null> {
    this.deadline = Math.max(this.deadline, Date.now() + 20_000);
    const r = this.ok(await this.cmd(`UID FETCH ${uid} (UID BODY.PEEK[])`, { maxLiteral: maxBytes }), 'Reading a message');
    const f = r.untagged.find((u) => /FETCH/i.test(u.line) && u.literals.length);
    const b = f?.literals[0];
    return b && b.length ? b : null;
  }

  async close() {
    try {
      await Promise.race([this.cmd('LOGOUT'), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* closing anyway */
    }
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      await this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Opens, runs `fn`, and always closes. */
export async function withImap<T>(o: ImapOptions, fn: (c: ImapClient) => Promise<T>): Promise<T> {
  const c = new ImapClient(o);
  try {
    await c.open();
    return await fn(c);
  } finally {
    await c.close();
  }
}
