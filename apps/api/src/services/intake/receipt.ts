/**
 * A second reading of mailed invoices and receipts, for what the Indian invoice rules miss: foreign
 * currency (US$ 100.00 is not ₹100), full invoice numbers (F13F9483-0019), dates written out
 * (November 12, 2026), "Amount paid" and "Applied balance" on receipts, the card that paid (Visa ··9814),
 * the SAC code, and whether the supplier is abroad (import of services: GST under reverse charge).
 */

export interface ReceiptLine {
  description: string;
  period: string | null;
  qty: number;
  unitPrice: number;
  taxPct: number | null;
  amount: number;
}

export interface ReceiptRead {
  currency: string;
  number: string | null;
  receiptNumber: string | null;
  date: string | null;
  paidOn: string | null;
  supplier: { name: string | null; taxId: string | null; country: string | null; foreign: boolean };
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  amountPaid: number | null;
  appliedBalance: number | null;
  amountDue: number | null;
  lines: ReceiptLine[];
  hsnSac: string | null;
  card: { network: string | null; last4: string } | null;
  paid: boolean;
}

const SYMBOLS: [RegExp, string][] = [
  [/US\$|\bUSD\b/, 'USD'],
  [/€|\bEUR\b/, 'EUR'],
  [/£|\bGBP\b/, 'GBP'],
  [/S\$|\bSGD\b/, 'SGD'],
  [/A\$|\bAUD\b/, 'AUD'],
  [/C\$|CA\$|\bCAD\b/, 'CAD'],
  [/AED|د\.إ/, 'AED'],
  [/¥|\bJPY\b/, 'JPY'],
  [/\bCHF\b/, 'CHF'],
];

/** The currency the document is in: ₹ / INR / Rs wins only when it is the one used for amounts. */
export function currencyOf(text: string): string {
  const inr = (text.match(/₹|\bINR\b|\bRs\.?\s*\d/g) ?? []).length;
  let best = { code: 'INR', n: inr };
  for (const [re, code] of SYMBOLS) {
    const n = (text.match(new RegExp(re.source, 'g')) ?? []).length;
    if (n > best.n) best = { code, n };
  }
  // a bare "$" before amounts is US dollars
  const dollars = (text.match(/(?<![A-Z])\$\s?\d/g) ?? []).length;
  if (dollars > best.n) best = { code: 'USD', n: dollars };
  return best.code;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "November 12, 2026", "12 Nov 2026", "12-11-2026", "2026-11-12" → ISO date. */
export function anyDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) return iso(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})\b/.exec(s);
  if (m && MONTHS[m[2]!.slice(0, 3).toLowerCase()]) return iso(+m[3]!, MONTHS[m[2]!.slice(0, 3).toLowerCase()]!, +m[1]!);
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(s);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  return null;
}

const AMOUNT = /-?\s?(?:US\$|S\$|A\$|C\$|\$|€|£|₹|Rs\.?|INR|USD|EUR|GBP)?\s?-?\(?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\)?|-?\d+(?:\.\d{1,2})?/g;
function amountIn(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(AMOUNT);
  if (!m) return null;
  const raw = m[0];
  const neg = /^-|^\(|-\s*\$|\$\s*-/.test(raw.trim()) || /\(\d/.test(raw);
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** The value after a label on the same line (or the next line when the label stands alone). */
function after(lines: string[], re: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const rest = lines[i]!.slice(m.index + m[0].length).replace(/^[\s:#.\-–]+/, '').trim();
    if (rest) return rest;
    const next = lines[i + 1]?.trim();
    if (next) return next;
  }
  return null;
}

const FOREIGN = /\b(United States|USA|U\.S\.A\.|California|Delaware|New York|Washington|Ireland|Dublin|Singapore|United Kingdom|London|Netherlands|Amsterdam|Germany|Australia|Canada|Luxembourg|Hong Kong|Japan|UAE|Dubai)\b/i;
const COMPANY = /\b(PBC|Inc\.?|LLC|L\.L\.C\.|Ltd\.?|Limited|GmbH|B\.V\.|Pte\.?\s?Ltd|Corp(?:oration)?\.?|LLP|Private|S\.A\.|AG|PLC)\b/i;

export function readReceipt(text: string, ownNames: string[] = []): ReceiptRead {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const all = lines.join('\n');
  const currency = currencyOf(all);
  const own = ownNames.map((n) => n.toLowerCase()).filter(Boolean);

  const num = (re: RegExp) => {
    const v = after(lines, re);
    const m = v ? /^[A-Z0-9][A-Z0-9\-/]{2,40}/i.exec(v) : null;
    return m ? m[0].replace(/[-/]+$/, '') : null;
  };
  const number = num(/\b(?:invoice\s*(?:number|no\.?|#)|tax\s*invoice\s*(?:no\.?|number)|bill\s*(?:no\.?|number))/i);
  const receiptNumber = num(/\breceipt\s*(?:number|no\.?|#)/i);
  const paidOn = anyDate(after(lines, /\b(?:date\s*paid|paid\s*on|payment\s*date)\b/i)) ?? anyDate(/\bpaid\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(all)?.[1]);
  const date = anyDate(after(lines, /\b(?:invoice\s*date|date\s*of\s*issue|bill\s*date|dated?)\b/i)) ?? paidOn;

  // the supplier: a company name in the header that is not the buyer
  const billIdx = lines.findIndex((l) => /\bbill(?:ed)?\s+to\b/i.test(l));
  let supplierName: string | null = null;
  for (const l of lines.slice(0, billIdx > 0 ? billIdx + 1 : 25)) {
    const left = l.split(/\s{2,}|\bBill(?:ed)? to\b/i)[0]!.trim();
    if (COMPANY.test(left) && !own.some((o) => left.toLowerCase().includes(o)) && left.length <= 80 && !/^(invoice|receipt|bill)/i.test(left)) {
      supplierName = left.replace(/[,\s]+$/, '');
      break;
    }
  }
  const taxId =
    /\b(\d{4}[A-Z]{3}\d{5}[A-Z]{3})\b/.exec(all)?.[1] ?? // OIDAR (foreign supplier's Indian GST) e.g. 9924USA29003OSI
    /(?:VAT|EIN|ABN|Tax)\s*(?:ID|No\.?|Registration)\s*[:#]?\s*([A-Z]{0,2}\d[\dA-Z-]{5,20})/i.exec(all)?.[1] ??
    null;
  const country = FOREIGN.exec(lines.slice(0, billIdx > 0 ? billIdx + 6 : 20).join('\n'))?.[1] ?? null;
  const foreign = currency !== 'INR' || (!!country && !/\bIndia\b/.test(lines.slice(0, billIdx > 0 ? billIdx : 10).join(' ')));

  const money = (re: RegExp) => amountIn(after(lines, re));
  const subtotal = money(/^\s*sub\s*-?\s*total\b/i);
  const total = money(/^\s*(?:grand\s+)?total(?:\s+amount)?(?!\s*(?:excluding|tax))\b/i);
  const tax = money(/^\s*(?:tax|gst|igst|vat)(?:\s*\(.*?\))?\s*(?=[\d$€£₹-])/i);
  const amountPaid = money(/\bamount\s+paid\b/i) ?? amountIn(/(\S*\d[\d,.]*)\s+paid\s+on\b/i.exec(all)?.[1]);
  const applied = money(/\bapplied\s+(?:balance|credit)\b/i);
  const appliedBalance = applied == null ? null : Math.abs(applied);
  const amountDue = money(/\bamount\s+due\b/i);

  // item lines: "Claude Max 1 $100.00 0% $100.00" (+ a period line "Nov 11–Dec 11, 2026")
  const items: ReceiptLine[] = [];
  const head = lines.findIndex((l) => /\bdescription\b/i.test(l) && /\b(qty|quantity|amount)\b/i.test(l));
  if (head >= 0) {
    for (let i = head + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(sub\s*total|total|amount\s+(?:paid|due)|tax\b)/i.test(l)) break;
      const m = /^(.*?[A-Za-z].*?)\s+(\d+(?:\.\d+)?)\s+(\S*\d[\d,.]*)\s+(?:(\d+(?:\.\d+)?)\s*%\S*\s+)?(\S*\d[\d,.]*)$/.exec(l);
      if (m) {
        items.push({ description: m[1]!.trim(), period: null, qty: Number(m[2]), unitPrice: amountIn(m[3]) ?? 0, taxPct: m[4] ? Number(m[4]) : null, amount: amountIn(m[5]) ?? 0 });
        continue;
      }
      const last = items[items.length - 1];
      if (last && !last.period && /\b(?:[A-Z][a-z]{2}\s+\d{1,2}).*\d{4}\b/.test(l) && l.length < 60) last.period = l;
    }
  }
  const card = /\b(Visa|Mastercard|MasterCard|Amex|American Express|RuPay|Diners|Discover)\b[^\d\n]{0,12}(\d{4})\b/i.exec(all);
  const hsn = /\b(?:HSN|SAC)(?:\s*\/\s*SAC)?\s*(?:code)?\s*[:#]?\s*(99\d{4}|\d{4,8})\b/i.exec(all)?.[1] ?? null;
  return {
    currency,
    number,
    receiptNumber,
    date,
    paidOn,
    supplier: { name: supplierName, taxId, country, foreign },
    subtotal,
    tax,
    total,
    amountPaid,
    appliedBalance,
    amountDue,
    lines: items,
    hsnSac: hsn,
    card: card ? { network: card[1]!, last4: card[2]! } : null,
    paid: !!paidOn || amountPaid != null || /\breceipt\b/i.test(lines.slice(0, 3).join(' ')),
  };
}
