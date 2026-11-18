/**
 * Reading an Indian bank statement line: who paid or was paid (the name the bank printed), the masked
 * account or phone digits, the UPI id, the remark, and what kind of line it is (a fixed deposit, a UPI
 * collection settlement, a refund, a card purchase…). Formats from Yes Bank, HDFC, ICICI, SBI, Axis and
 * Kotak statements:
 *
 *   IMPS/Shalini Pathak/XXX7885/RRN:603810452909/
 *   IMPS/NA/XXXX9042/RRN:532270204198/PC211125587441487/HDFC BANK/Harsha Rani/IFB
 *   NEFT Cr-SBIN0004266-FOOD CORPORATION OF INDIA-HRP AI LLP-SBIN326314464479
 *   UPI/550012053407/From:XXXXXX7936-3@ybl/To:XXXXXX4463-7@ybl/Payment from PhonePe
 *   PCA:2640:PERFPERFE108890:PERFECTION CONSULTING DELHI IND01-OCT-25 15:19:01
 *   REFUND:250927:MICROSOFTBUS\10TH FLOOR 10
 *   NET-New FD-HRP AI LLP-119840400013083 -1-SECTOR 78 NOIDA
 *   115063600001082/763175492 UPI Collection Settlement/HRP AI LLP/CBS PAYABLE ACC
 */

export type Special = 'fd' | 'fd_closure' | 'upi_settlement' | 'refund' | 'card' | 'cash' | 'cheque' | null;

export interface Parsed {
  channel: 'imps' | 'neft' | 'rtgs' | 'upi' | 'card' | 'net' | 'refund' | 'cash' | 'cheque' | 'other';
  /** the other party as the bank printed it, tidied ("Harsha Rani", "Food Corporation of India") */
  name: string | null;
  /** the last digits of a masked account ("XXXX9042" → "9042") */
  masked: string | null;
  vpa: string | null;
  /** digits in the UPI id, usually the payer's mobile (masked: "XXXXXX7936" → "7936") */
  vpaDigits: string | null;
  remark: string | null;
  bank: string | null;
  ifsc: string | null;
  special: Special;
  /** a card purchase or refund: the merchant */
  merchant: string | null;
}

const BANKS = /^(HDFC|ICICI|SBI|STATE BANK|AXIS|KOTAK|YES|PNB|PUNJAB NATIONAL|BANK OF BARODA|BOB|CANARA|UNION BANK|INDUSIND|IDFC|IDBI|FEDERAL|RBL|AU SMALL|EQUITAS|INDIAN BANK|INDIAN OVERSEAS|CENTRAL BANK|BANK OF INDIA|UCO|FINO)\b.*|.*\bBANK$/i;
const NOISE = /^(NA|N\/A|NULL|NONE|UPI|IMPS|NEFT|RTGS|RRN|REF|TXN|PAYMENT|TRANSFER|P2P|P2M|MOB|INB|MB|NET|CR|DR)$/i;
const SMALL = new Set(['of', 'and', 'the', 'for', 'in', 'at', 'to', 'a', 'an', '&']);
const KEEP_UPPER = /^(LLP|LLC|PVT|LTD|OPC|HUF|NGO|CA|CS|GST|UPI|IT|AI|HR|HRP|HDFC|ICICI|SBI|IDFC|IDBI|RBL|NEFT|FCI|IIT|IIM|DLF|BPCL|HPCL|IOCL|ONGC|NTPC|BHEL|SAIL|LIC|EB)$/;

/** "FOOD CORPORATION OF INDIA" → "Food Corporation of India"; "HRP AI LLP" keeps its initials. */
export function tidyName(raw: string): string {
  const words = raw
    .replace(/[_*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  return words
    .map((w, i) => {
      const up = w.toUpperCase().replace(/[.,]$/, '');
      if (KEEP_UPPER.test(up)) return w.toUpperCase();
      const lw = w.toLowerCase();
      if (i > 0 && SMALL.has(lw)) return lw;
      return lw.replace(/(^|[-'(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
    })
    .join(' ')
    .slice(0, 120);
}

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** A candidate name is a person's or a business's, not a code, a bank or the company's own name. */
function nameOrNull(raw: string | undefined | null, own: string[]): string | null {
  if (!raw) return null;
  let s = raw.replace(/\b(RRN|REF|UTR)[:\s]*\w+/gi, ' ').replace(/X{2,}\d+/gi, ' ');
  for (const o of own) if (o) s = s.replace(new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\b`, 'gi'), ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 3 || NOISE.test(s) || BANKS.test(s) || /\d{4,}/.test(s) || !/[A-Za-z]{2,}/.test(s)) return null;
  // mostly letters, two characters at least, not an IFSC or reference
  if (/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(s.replace(/\s/g, ''))) return null;
  return tidyName(s);
}

/** Merchants whose card name is cut short or prefixed by the payment gateway. */
const ALIASES: [RegExp, string][] = [
  [/^(PAY)?(MICROSB|MICROSO|MSFT)/, 'Microsoft'],
  [/^(PAY)?BOOKMYS/, 'BookMyShow'],
  [/^(PAY)?(AMAZONWEB|AWS)/, 'Amazon Web Services'],
  [/^(PAY)?GOOGLE/, 'Google'],
];

/** "PERFECTION CONSULTING DELHI IND01-OCT-25 15:19:01" → "Perfection Consulting" (city, country and time dropped). */
function merchantName(raw: string): string | null {
  let s = raw.split(/\\/)[0]!;
  s = s.replace(/\b\d{1,2}[-:]\w{3}[-:]\d{2,4}\b.*$/i, '').replace(/\bIND(IA)?\d*\b.*$/i, '').replace(/\d{2}:\d{2}(:\d{2})?/g, '');
  s = s.replace(/\b(DELHI|NEW DELHI|NOIDA|GURGAON|GURUGRAM|MUMBAI|BANGALORE|BENGALURU|CHENNAI|KOLKATA|HYDERABAD|PUNE|AHMEDABAD|JAIPUR|LUCKNOW|CHANDIGARH|IN|SG|US|IE)\s*$/i, '');
  s = s.replace(/[^A-Za-z0-9&.' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  // MICROSOFTBUS → Microsoft (well-known merchants glued to a suffix)
  const known = /^(MICROSOFT|GOOGLE|AMAZON|APPLE|ADOBE|OPENAI|ANTHROPIC|ZOOM|CANVA|GODADDY|HOSTINGER|NETFLIX|SPOTIFY|LINKEDIN|FACEBOOK|META|ATLASSIAN|GITHUB|NOTION|SLACK|FIGMA|CLOUDFLARE|DIGITALOCEAN|ZOHO|AWS)/i.exec(s.replace(/\s/g, ''));
  if (known) return tidyName(known[1]!);
  // card networks cut names short: MICROSBUSEVE, PAY*BOOKMYSHOW COM, BOOK MY SHOW SMART GAT
  const flat = s.replace(/\s/g, '').toUpperCase();
  for (const [re, name] of ALIASES) if (re.test(flat)) return name;
  s = s.replace(/^(PAY|PYU|RAZ|RAZORPAY|CCAVENUE|PAYU|SP|SQ)\s+/i, '').replace(/\s+(COM|IN|CO|PVT|LTD)$/i, '').trim();
  return s.length >= 3 ? tidyName(s) : null;
}

export function parseNarration(description: string, ownNames: string[] = []): Parsed {
  const d = description.trim();
  const D = d.toUpperCase();
  const own = ownNames.filter(Boolean);
  const p: Parsed = { channel: 'other', name: null, masked: null, vpa: null, vpaDigits: null, remark: null, bank: null, ifsc: null, special: null, merchant: null };
  const masked = /X{2,}(\d{3,6})(?!\d)/i.exec(d);
  if (masked) p.masked = masked[1]!;

  if (/UPI COLLECTION SETTLEMENT|COLLECTION SETTLEMENT|UPI SETTLEMENT|MERCHANT SETTLEMENT/.test(D)) {
    p.special = 'upi_settlement';
    p.channel = 'upi';
    return p;
  }
  if (/(^|[^A-Z])(NEW FD|FD BOOK|FD OPEN|FD CREAT|FIXED DEPOSIT|TERM DEPOSIT|TD BOOK|SWEEP OUT|AUTO SWEEP)/.test(D)) {
    p.special = /CLOS|MATUR|PREMAT|REDEEM|SWEEP IN|PROCEEDS/.test(D) ? 'fd_closure' : 'fd';
    p.channel = 'net';
    return p;
  }
  if (/FD (CLOS|MATUR|PREMAT|REDEM)|SWEEP IN|DEPOSIT CLOS/.test(D)) {
    p.special = 'fd_closure';
    p.channel = 'net';
    return p;
  }
  if (/^REFUND[:/]/.test(D) || /\bREFUND\b/.test(D)) {
    p.channel = 'refund';
    p.special = 'refund';
    const rest = d.replace(/^REFUND[:/]\s*(\d{6}[:/])?/i, '');
    p.merchant = merchantName(rest);
    p.name = p.merchant;
    return p;
  }
  if (/^(PCA|POS|PCD|ECOM|VPS|VIN|MPS)[:/ ]/.test(D) || /\bPOS\s?\d|DEBIT CARD|CARD PURCHASE/.test(D)) {
    p.channel = 'card';
    p.special = 'card';
    const parts = d.split(':');
    p.merchant = merchantName(parts.length >= 4 ? parts.slice(3).join(' ') : parts[parts.length - 1]!);
    p.name = p.merchant;
    return p;
  }
  if (/^(CASH|CSH|ATM|ATW|NWD|CWDR|BY CASH|CASH DEP)/.test(D)) {
    p.channel = 'cash';
    p.special = 'cash';
    return p;
  }
  if (/^(CHQ|CHEQUE|CLG|INWARD CLG|OUTWARD CLG|BY CLG|TO CLG)/.test(D)) {
    p.channel = 'cheque';
    p.special = 'cheque';
    p.name = nameOrNull(d.replace(/^\S+\s*(NO\.?\s*\d+)?/i, ''), own);
    return p;
  }
  if (/^IMPS[/-]/.test(D)) {
    p.channel = 'imps';
    const parts = d.split('/').map((x) => x.trim());
    // IMPS/<name|NA>/XXX1234/RRN:…/[PC ref]/[bank]/[name]/[remark]
    let name = nameOrNull(parts[1], own);
    const bankAt = parts.findIndex((x, i) => i > 1 && BANKS.test(x));
    if (bankAt > 0) {
      p.bank = parts[bankAt]!;
      name ??= nameOrNull(parts[bankAt + 1], own);
      const rem = parts.slice(bankAt + 2).filter(Boolean).join(' ');
      if (rem) p.remark = rem;
    }
    p.name = name;
    return p;
  }
  const neft = /^(NEFT|RTGS)\s*(CR|DR)?[-/ ]+(.*)$/i.exec(d);
  if (neft) {
    p.channel = neft[1]!.toLowerCase() as 'neft' | 'rtgs';
    const parts = neft[3]!.split(/-|\//).map((x) => x.trim()).filter(Boolean);
    const ifscAt = parts.findIndex((x) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(x));
    if (ifscAt >= 0) p.ifsc = parts[ifscAt]!.toUpperCase();
    const names = parts.filter((x, i) => i !== ifscAt).map((x) => nameOrNull(x, own)).filter((x): x is string => !!x);
    p.name = names[0] ?? null;
    if (names.length > 1) p.remark = names.slice(1).join(' ');
    return p;
  }
  if (/^UPI[/-]/.test(D) || /@[a-z]{2,}/i.test(d)) {
    p.channel = 'upi';
    const parts = d.split('/').map((x) => x.trim());
    const from = /FROM:\s*([^/\s]+@[a-z0-9.]+)/i.exec(d);
    const to = /TO:\s*([^/\s]+@[a-z0-9.]+)/i.exec(d);
    const anyVpa = /([A-Za-z0-9._-]+@[a-z0-9.]+)/i.exec(d);
    p.vpa = (from?.[1] ?? anyVpa?.[1] ?? null)?.toLowerCase() ?? null;
    if (to && from) p.remark = parts.slice(parts.findIndex((x) => /^TO:/i.test(x)) + 1).join(' ') || null;
    const digits = p.vpa ? /(\d{4,10})(?:-\d)?@/.exec(p.vpa) : null;
    if (digits) p.vpaDigits = digits[1]!.slice(-4);
    // UPI/<name>/<ref>/<vpa>/… or UPI/<ref>/<name>/…
    for (const x of parts.slice(1)) {
      if (/@/.test(x) || /^(FROM|TO):/i.test(x)) continue;
      const n = nameOrNull(x, own);
      if (n && !/^Payment (from|to)\b/i.test(n) && !/^(Phonepe|Paytm|Gpay|Google Pay|Bhim|Cred|Amazon Pay)$/i.test(n)) {
        p.name = n;
        break;
      }
    }
    if (!p.name && p.vpa && !/^x+\d/i.test(p.vpa)) {
      const local = p.vpa.split('@')[0]!.replace(/[0-9._-]+/g, ' ').trim();
      if (local.length >= 3) p.name = tidyName(local);
    }
    return p;
  }
  const net = /^(NET|INB|MB|IB|BIL|ONL)[-/ ](.*)$/i.exec(d);
  if (net) {
    p.channel = 'net';
    const parts = net[2]!.split(/-|\//).map((x) => x.trim()).filter(Boolean);
    p.name = parts.map((x) => nameOrNull(x, own)).find(Boolean) ?? null;
    return p;
  }
  p.name = nameOrNull(d.replace(/\d+/g, ' '), own);
  return p;
}

/** Is a short credit a bank's account check (₹1 sent to confirm the account) rather than a receipt? */
export function isVerificationCredit(amount: number, description: string, parsed: Parsed) {
  if (amount <= 0 || amount > 2) return false;
  const d = `${description} ${parsed.name ?? ''}`.toUpperCase();
  return /API BANKING|VERIF|PENNY|VALIDAT|RAZORPAY|CASHFREE|PAYU|EASEBUZZ|ACCOUNT CHECK|ACC VALID|BENEFICIARY|PAYOUT/.test(d) || !parsed.name;
}

/** The same person or business, however the bank spells it: every word of the shorter name in the longer. */
export function sameName(a: string, b: string) {
  const wa = squash(a)
    .split(' ')
    .filter((w) => w.length >= 2 && !['MR', 'MRS', 'MS', 'DR', 'SHRI', 'SMT', 'M', 'S'].includes(w));
  const wb = squash(b)
    .split(' ')
    .filter((w) => w.length >= 2 && !['MR', 'MRS', 'MS', 'DR', 'SHRI', 'SMT', 'M', 'S'].includes(w));
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.join('').length < 5) return false;
  if (short.every((w) => long.includes(w))) return true;
  // banks often run the words together, surname first or last: SRIVASTAVASUNITA is Sunita Srivastava
  return joinedName(wa.join(''), wb) || joinedName(wb.join(''), wa);
}

/** Is `joined` (no spaces) these name words run together, in any order? Short words cannot match this way. */
function joinedName(joined: string, words: string[]) {
  if (words.length < 2 || words.length > 4 || joined.length < 8 || words.some((w) => w.length < 2)) return false;
  if (joined.length !== words.join('').length) return false;
  const go = (rest: string, left: string[]): boolean => !left.length ? !rest : left.some((w, i) => rest.startsWith(w) && go(rest.slice(w.length), left.filter((_, j) => j !== i)));
  return go(joined, words);
}

/** Does the text carry this person's name, spaced or run together (any word order)? */
export function nameInText(text: string, name: string) {
  const words = squash(name).split(' ').filter((w) => w.length >= 2 && !['MR', 'MRS', 'MS', 'DR', 'SHRI', 'SMT'].includes(w));
  if (words.length < 2) return false;
  const t = ` ${squash(text)} `;
  if (t.includes(` ${words.join(' ')} `) || t.includes(` ${[...words].reverse().join(' ')} `)) return true;
  return t
    .trim()
    .split(' ')
    .some((tok) => joinedName(tok, words));
}

/** Last four digits of a phone, for matching masked UPI ids and account numbers. */
export const tail4 = (s: string | null | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};
