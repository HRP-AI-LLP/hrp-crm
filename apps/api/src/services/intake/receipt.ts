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
  hsn?: string | null;
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
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  /** the GST rate the invoice shows (IGST, or CGST + SGST) */
  taxRate: number | null;
  total: number | null;
  amountPaid: number | null;
  appliedBalance: number | null;
  amountDue: number | null;
  reverseCharge: boolean | null;
  placeOfSupply: string | null;
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
  const n = Number(raw.replace(/Rs\.?|INR|USD|EUR|GBP/gi, '').replace(/[^\d.]/g, ''));
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

/** The value under a column heading: "INVOICE NO.<tab>INVOICE DATE" over "306/26-27<tab>17 Nov 2026". */
function column(lines: string[], re: RegExp): string | null {
  for (let i = 0; i < lines.length - 1; i++) {
    const cells = lines[i]!.split('\t').map((c) => c.trim());
    const at = cells.findIndex((c) => re.test(c) && c.replace(re, '').replace(/[\s:.#]/g, '') === '');
    if (at < 0) continue;
    const below = lines[i + 1]!.split('\t').map((c) => c.trim());
    // the same columns below, or a single label over a single value
    if (below.length === cells.length || (cells.length === 1 && below.length >= 1)) return below[at] || null;
  }
  return null;
}

/** A label inside a row of cells ("Taxable Value<tab>Rs. 199.00", "IGST @ 18%<tab>Rs. 36.00"): the amount next to it. */
function cellAmount(lines: string[], re: RegExp): number | null {
  for (const l of lines) {
    const cells = l.split('\t').map((c) => c.trim());
    for (let i = 0; i < cells.length; i++) {
      const m = re.exec(cells[i]!);
      if (!m || m.index !== 0) continue;
      const next = cells[i + 1];
      if (next && /\d/.test(next)) return amountIn(next);
      const rest = cells[i]!.slice(m[0].length).replace(/^[\s:@-]+/, '');
      if (/\d/.test(rest) && !/%/.test(rest)) return amountIn(rest);
    }
  }
  return null;
}

const MONEY = String.raw`(?:Rs\.?|₹|INR|US\$|\$|€|£)?\s?-?\d[\d,]*(?:\.\d{1,2})?`;
const LABELISH = /^(invoice|bill|tax|date|no\.?|number|receipt|original|duplicate)$/i;

export function readReceipt(text: string, ownNames: string[] = []): ReceiptRead {
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/ *\t[\t ]*/g, '\t').trim())
    .filter(Boolean);
  const all = lines.join('\n');
  const flat = lines.map((l) => l.replace(/\t/g, ' '));
  const currency = currencyOf(all);
  const own = ownNames.map((n) => n.toLowerCase()).filter(Boolean);

  const idOf = (v: string | null | undefined) => {
    const m = v ? /^[A-Z0-9][A-Z0-9\-/.]{1,40}/i.exec(v.trim()) : null;
    const x = m ? m[0].replace(/[-/.]+$/, '') : null;
    // a number has a digit; a heading word ("INVOICE") is not a number
    return x && /\d/.test(x) && !LABELISH.test(x) ? x : null;
  };
  const NUM_LABEL = /^(?:tax\s*)?(?:invoice|bill)\s*(?:number|no\.?|#)$/i;
  const number =
    idOf(column(lines, NUM_LABEL)) ??
    idOf(after(flat, /\b(?:invoice\s*(?:number|no\.?|#)|tax\s*invoice\s*(?:no\.?|number)|bill\s*(?:no\.?|number))/i)) ??
    idOf(/\b(?:invoice|bill)\s*(?:no\.?|number|#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-/]{1,40})/i.exec(all)?.[1]);
  const receiptNumber = idOf(column(lines, /^receipt\s*(?:number|no\.?|#)$/i)) ?? idOf(after(flat, /\breceipt\s*(?:number|no\.?|#)/i));
  const paidOn = anyDate(after(flat, /\b(?:date\s*paid|paid\s*on|payment\s*date)\b/i)) ?? anyDate(/\bpaid\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(all)?.[1]);
  const date =
    anyDate(column(lines, /^(?:invoice|bill)?\s*date$/i)) ??
    anyDate(after(flat, /\b(?:invoice\s*date|date\s*of\s*issue|bill\s*date|dated?)\b/i)) ??
    anyDate(column(lines, /^dated?$/i)) ??
    paidOn;

  // the supplier: under a "Supplier / Seller / From" heading, else a company name in the header that is not the buyer
  const billIdx = flat.findIndex((l) => /\bbill(?:ed)?\s+to\b/i.test(l));
  const notOwn = (n: string | null | undefined) => (n && !own.some((o) => n.toLowerCase().includes(o)) ? n.replace(/[,\s]+$/, '') : null);
  let supplierName = notOwn(column(lines, /^(?:supplier|seller|sold\s+by|vendor|service\s+provider|billed\s+by|from)(?:\s+details)?$/i));
  if (!supplierName)
    for (const l of flat.slice(0, billIdx > 0 ? billIdx + 1 : 25)) {
      const left = l.split(/\s{2,}|\bBill(?:ed)? to\b/i)[0]!.trim();
      if (COMPANY.test(left) && notOwn(left) && left.length <= 80 && !/^(invoice|receipt|bill)/i.test(left)) {
        supplierName = notOwn(left);
        break;
      }
    }
  // the signature block names the supplier too: "For Tarun Soft Consultancy"
  supplierName ??= notOwn(/(?:^|\t)For\s+([A-Z][A-Za-z0-9&.,'() -]{2,80}?)\s*$/m.exec(all)?.[1]?.trim());
  const taxId =
    /\b(\d{4}[A-Z]{3}\d{5}[A-Z]{3})\b/.exec(all)?.[1] ?? // OIDAR (foreign supplier's Indian GST) e.g. 9924USA29003OSI
    /(?:VAT|EIN|ABN|Tax)\s*(?:ID|No\.?|Registration)\s*[:#]?\s*([A-Z]{0,2}\d[\dA-Z-]{5,20})/i.exec(all)?.[1] ??
    null;
  const country = FOREIGN.exec(flat.slice(0, billIdx > 0 ? billIdx + 6 : 20).join('\n'))?.[1] ?? null;
  const foreign = currency !== 'INR' || (!!country && !/\bIndia\b/.test(flat.slice(0, billIdx > 0 ? billIdx : 10).join(' ')));

  const money = (re: RegExp) => amountIn(after(flat, re));
  const subtotal = money(/^\s*sub\s*-?\s*total\b/i) ?? cellAmount(lines, /^(?:total\s+)?taxable\s*(?:value|amount)\b/i);
  const total =
    cellAmount(lines, /^(?:grand\s+total|total\s+invoice\s+(?:value|amount)|invoice\s+total|total\s+amount(?:\s+payable)?|amount\s+payable|net\s+payable)\b/i) ??
    money(/^\s*(?:grand\s+)?total(?:\s+amount)?(?!\s*(?:excluding|tax|in\s+words))\b/i);
  const igst = cellAmount(lines, /^IGST\b[^\t]*?(?=$)/i) ?? cellAmount(lines, /^IGST\b/i);
  const cgst = cellAmount(lines, /^CGST\b[^\t]*?(?=$)/i) ?? cellAmount(lines, /^CGST\b/i);
  const sgst = cellAmount(lines, /^(?:SGST|UTGST)\b[^\t]*?(?=$)/i) ?? cellAmount(lines, /^(?:SGST|UTGST)\b/i);
  const gstSum = (igst ?? 0) + (cgst ?? 0) + (sgst ?? 0);
  const tax = gstSum ? Math.round(gstSum * 100) / 100 : money(/^\s*(?:tax|gst|igst|vat)(?:\s*\(.*?\))?\s*(?=[\d$€£₹-])/i);
  const rateM = /\b(?:IGST|GST)\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i.exec(all) ?? /\b(?:CGST)\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/i.exec(all);
  const taxRate = rateM ? (/CGST/i.test(rateM[0]) ? Number(rateM[1]) * 2 : Number(rateM[1])) : subtotal && tax ? Math.round((tax / subtotal) * 100) : null;
  const amountPaid = money(/\bamount\s+paid\b/i) ?? amountIn(/(\S*\d[\d,.]*)\s+paid\s+on\b/i.exec(all)?.[1]);
  const applied = money(/\bapplied\s+(?:balance|credit)\b/i);
  const appliedBalance = applied == null ? null : Math.abs(applied);
  const amountDue = money(/\bamount\s+due\b/i) ?? cellAmount(lines, /^(?:balance|amount)\s+due\b/i);
  const rcText = column(lines, /^reverse\s+charge$/i) ?? /reverse\s+charge\s*(?:applicable)?\s*[:-]?\s*(yes|no)\b/i.exec(all)?.[1] ?? null;
  const placeOfSupply = column(lines, /^place\s+of\s+supply$/i) ?? /place\s+of\s+supply\s*[:-]\s*([^\t\n]+)/i.exec(all)?.[1]?.trim() ?? null;

  // item lines: "Claude Max 1 $100.00 0% $100.00" (+ a period line "Nov 11–Dec 11, 2026");
  // Indian invoices: "1 250 GSTIN lookup credits 998315 1 Rs. 199.00 Rs. 199.00"
  const items: ReceiptLine[] = [];
  const head = flat.findIndex((l) => /\b(description|particulars|items?|services?)\b/i.test(l) && /\b(qty|quantity|amount|value|rate|price)\b/i.test(l));
  const hsnCol = head >= 0 && /\b(hsn|sac)\b/i.test(flat[head]!);
  if (head >= 0) {
    const indian = new RegExp(String.raw`^(?:\d{1,3}\.?\s+)?(.*?[A-Za-z].*?)\s+(?:(\d{4,8})\s+)?(\d+(?:\.\d+)?)\s*(?:[A-Za-z]{2,6}\.?\s+)?(${MONEY})\s+(?:(\d+(?:\.\d+)?)\s*%\s+)?(${MONEY})(?:\s+.*)?$`, 'i');
    for (let i = head + 1; i < flat.length; i++) {
      const l = flat[i]!;
      if (/^\s*(sub\s*-?\s*total|total|amount\s+(?:paid|due|in\s+words)|taxable\s+value|tax\b|in\s+words|rupees\b)/i.test(l) || /^\s*(amount\s+in\s+words|declaration|tax\s+summary)/i.test(l)) break;
      const m = /^(.*?[A-Za-z].*?)\s+(\d+(?:\.\d+)?)\s+(\S*\d[\d,.]*)\s+(?:(\d+(?:\.\d+)?)\s*%\S*\s+)?(\S*\d[\d,.]*)$/.exec(l);
      const period = /^[A-Z][a-z]{2}\.?\s+\d{1,2}\b.{0,20}\d{4}$/.test(l) && l.length < 60;
      const n = !period && (hsnCol || !m) ? indian.exec(l) : null;
      if (n && /\.\d{2}$|Rs|₹|\$|€|£/.test(n[6]!) && (hsnCol || !m)) {
        items.push({ description: n[1]!.trim(), period: null, qty: Number(n[3]), unitPrice: amountIn(n[4]) ?? 0, taxPct: n[5] ? Number(n[5]) : null, amount: amountIn(n[6]) ?? 0, hsn: n[2] ?? null });
        continue;
      }
      if (m && !period) {
        items.push({ description: m[1]!.trim(), period: null, qty: Number(m[2]), unitPrice: amountIn(m[3]) ?? 0, taxPct: m[4] ? Number(m[4]) : null, amount: amountIn(m[5]) ?? 0, hsn: null });
        continue;
      }
      const last = items[items.length - 1];
      if (last && !last.period && /\b(?:[A-Z][a-z]{2}\s+\d{1,2}).*\d{4}\b/.test(l) && l.length < 60) last.period = l;
    }
  }
  const card = /\b(Visa|Mastercard|MasterCard|Amex|American Express|RuPay|Diners|Discover)\b[^\d\n]{0,12}(\d{4})\b/i.exec(all);
  const hsn = /\b(?:HSN|SAC)(?:\s*\/\s*SAC)?\s*(?:code)?\s*[:#]?\s*(99\d{4}|\d{4,8})\b/i.exec(all)?.[1] ?? items.find((x) => x.hsn)?.hsn ?? null;
  // paid: a PAID stamp, "payment received", an amount paid; not when a balance is still due
  const stamp = lines.some((l) => l.split('\t').some((c) => /^(paid|payment\s+received|paid\s+in\s+full)$/i.test(c.trim())));
  const saysPaid = /\b(payment\s+(?:received|successful|completed)(?:\s+in\s+full)?|paid\s+in\s+full|fully\s+paid|thank\s+you\s+for\s+your\s+payment|payment\s+status\s*:?\s*paid)\b/i.test(all);
  const unpaid = /\bunpaid\b|\bpayment\s+(?:pending|due|failed|declined)\b|\b(?:failed|declined)\s+payment\b/i.test(all) || (amountDue != null && amountDue > 0 && !paidOn && amountPaid == null && !stamp);
  return {
    currency,
    number,
    receiptNumber,
    date,
    paidOn,
    supplier: { name: supplierName, taxId, country, foreign },
    subtotal,
    tax,
    cgst,
    sgst,
    igst,
    taxRate,
    total,
    amountPaid,
    appliedBalance,
    amountDue,
    reverseCharge: rcText ? /^y/i.test(rcText.trim()) : null,
    placeOfSupply,
    lines: items,
    hsnSac: hsn,
    card: card ? { network: card[1]!, last4: card[2]! } : null,
    paid: !unpaid && (!!paidOn || amountPaid != null || stamp || saysPaid || /\breceipt\b/i.test(flat.slice(0, 3).join(' '))),
  };
}

/**
 * Whose document is it: our own invoice to a customer (our name or GSTIN at the top, someone else under
 * "Bill to"), or a supplier's bill to us (our name or GSTIN under "Bill to" / "Buyer").
 */
export function whoseDocument(text: string, ownGstins: string[], ownNames: string[]): 'ours' | 'theirs' | null {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const names = ownNames.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).filter((n) => n.length >= 4);
  const gst = ownGstins.map((g) => g.toUpperCase());
  const isOwn = (l: string) => {
    const up = l.toUpperCase();
    const low = ` ${l.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    return gst.some((g) => up.includes(g)) || names.some((n) => low.includes(` ${n} `));
  };
  const billIdx = lines.findIndex((l) => /\b(bill(?:ed)?\s+to|buyer|customer\s*(?:name|details)?\s*:?$|recipient|consignee|invoice\s+to)\b/i.test(l));
  if (billIdx < 0) return lines.slice(0, 6).some(isOwn) ? 'ours' : null;
  // the heading line can carry the supplier's column too ("Anthropic, PBC <tab> Bill to"): only cells from the heading on count
  const head = lines[billIdx]!.split('\t');
  const at = head.findIndex((c) => /\b(bill(?:ed)?\s+to|buyer|customer|recipient|consignee|invoice\s+to)\b/i.test(c));
  const after = lines.slice(billIdx + 1, billIdx + 9).map((l) => {
    const cells = l.split('\t');
    return head.length > 1 && cells.length > 1 ? cells.slice(Math.min(at, cells.length - 1)).join(' ') : l;
  });
  const top = lines.slice(0, billIdx).concat(head.slice(0, Math.max(0, at)).join(' '));
  if (after.some(isOwn)) return 'theirs';
  if (top.some(isOwn)) return 'ours';
  return null;
}
