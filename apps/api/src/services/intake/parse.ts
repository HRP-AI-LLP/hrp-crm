/**
 * Reading business mail by rules: which mail matters (GeM alerts, bills, invoices, statements), the bids
 * in a GeM alert, a GeM corrigendum, and the eligibility and document list of a GeM bid document.
 */

export type IntakeKind = 'gem_new_bids' | 'gem_corrigendum' | 'gem_update' | 'bill' | 'invoice' | 'statement' | 'payment';

export const BID_RE = /GEM\/\d{4}\/[A-Z]\/\d{4,}/g;

const DOCISH = /\.(pdf|jpe?g|png|webp|xlsx?|csv)$/i;
const BILL_WORDS = /\b(tax\s*invoice|invoice|bill|receipt|payment\s*receipt|proforma|credit\s*note|debit\s*note|purchase\s*order\s*acknowledg|e-?invoice|subscription\s*renew)/i;
const STATEMENT_WORDS = /\b(statement\s+of\s+account|account\s+statement|e-?statement|ledger\s+statement)/i;
const PAYMENT_WORDS = /(payment\s+(?:received|successful|success|confirmation|confirmed|receipt|done|of\s+rs)|receipt\s+for\s+(?:your\s+)?payment|paid\s+successfully|transaction\s+(?:successful|receipt)|payment\s+advice|remittance\s+advice)/i;
const NOT_BILLS = /\b(otp|one\s*time\s*password|password|verify|verification|newsletter|webinar|unsubscribe)\b/i;

/** Decides whether a mail matters, from its headers (before the body is downloaded). */
export function classify(h: { from: string | null; subject: string; contentType: string; ownDomains?: string[] }, read: { gem: boolean; bills: boolean }): IntakeKind | null {
  const from = (h.from ?? '').toLowerCase();
  const subject = h.subject ?? '';
  if (read.gem && /@([a-z0-9-]+\.)*gem\.gov\.in$/.test(from)) {
    if (/new\s+bid\(?s?\)?\s+published/i.test(subject)) return 'gem_new_bids';
    if (/corrigendum/i.test(subject)) return 'gem_corrigendum';
    if (BID_RE.test(subject)) return (BID_RE.lastIndex = 0), 'gem_update';
    BID_RE.lastIndex = 0;
    return null;
  }
  if (!read.bills) return null;
  if (NOT_BILLS.test(subject)) return null;
  // payment receipts and remittance advices: kept with or without a file
  if (PAYMENT_WORDS.test(subject)) return 'payment';
  const withFiles = /multipart\/(mixed|related|report)/i.test(h.contentType);
  if (!withFiles) return null;
  if (STATEMENT_WORDS.test(subject)) return 'statement';
  if (BILL_WORDS.test(subject)) return (h.ownDomains ?? []).some((d) => from.endsWith(`@${d}`)) ? 'invoice' : 'bill';
  return null;
}

/** A second look once the attachments are known: a bill mail must carry a document. */
export function hasDocument(attachments: { filename: string; contentType: string; size: number }[]) {
  return attachments.some((a) => (a.contentType === 'application/pdf' || a.contentType.startsWith('image/') || DOCISH.test(a.filename)) && a.size > 500);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "21-October-2026", "28-11-2026 15:00:00", "2026-11-17 15:51:20" → ISO (IST). */
export function gemDate(s: string | null | undefined): { date: string; at: string | null } | null {
  if (!s) return null;
  let m = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  let y: number, mo: number, d: number, hh: string | undefined, mm: string | undefined, ss: string | undefined;
  if (m) [y, mo, d, hh, mm, ss] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5], m[6]];
  else {
    m = /(\d{1,2})[-/ ]([A-Za-z]{3,9}|\d{1,2})[-/ ,]+(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(s);
    if (!m) return null;
    d = Number(m[1]);
    mo = /^\d+$/.test(m[2]!) ? Number(m[2]) : MONTHS[m[2]!.slice(0, 3).toLowerCase()] ?? 0;
    y = Number(m[3]);
    hh = m[4];
    mm = m[5];
    ss = m[6];
    if (m[7] && hh) hh = String((Number(hh) % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0));
  }
  if (!mo || mo > 12 || d < 1 || d > 31) return null;
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const at = hh ? new Date(`${date}T${hh.padStart(2, '0')}:${mm}:${ss ?? '00'}+05:30`).toISOString() : null;
  return { date, at };
}

export interface AlertBid {
  bidNumber: string;
  title: string | null;
  quantity: number | null;
  startAt: string | null;
  endAt: string | null;
  organisation: string | null;
}

const DATE_IN = /(\d{1,2}[-/][A-Za-z0-9]{2,9}[-/]\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/gi;

/** The bids listed in a "New bid(s) published on GeM portal" mail. */
export function parseNewBids(text: string): AlertBid[] {
  const t = text.replace(/\r/g, '');
  const found: AlertBid[] = [];
  const hits = [...t.matchAll(BID_RE)];
  for (const [i, h] of hits.entries()) {
    const num = h[0];
    if (found.some((b) => b.bidNumber === num)) continue;
    // what belongs to this bid: from its number to the next one (a table row, or a block of lines)
    const end = hits.slice(i + 1).find((x) => x[0] !== num)?.index ?? Math.min(t.length, h.index! + 1200);
    const block = t.slice(h.index! + num.length, end);
    const label = (re: RegExp) => re.exec(block)?.[1]?.trim() || null;
    const dates = [...block.matchAll(DATE_IN)].map((m) => gemDate(m[1]));
    const endLabel = gemDate(label(/(?:end\s*date|closing\s*date|bid\s*end)[^:\d]*[:\-]?\s*([^\n\t]+)/i));
    const startLabel = gemDate(label(/(?:start\s*date|published\s*on|bid\s*start)[^:\d]*[:\-]?\s*([^\n\t]+)/i));
    const qty = label(/(?:quantity|qty)[^:\d]*[:\-]?\s*([\d,]+(?:\.\d+)?)/i);
    let title =
      label(/(?:items?|category|item\s*category|description|title)\s*[:\-]\s*([^\n\t]+)/i) ??
      block
        .split(/[\n\t]+/)
        .map((x) => x.replace(DATE_IN, '').replace(/^[\s:|\-–]+|[\s:|\-–]+$/g, ''))
        .find((x) => x.length > 3 && /[A-Za-z]{3}/.test(x) && !/^(bid|end|start|date|quantity|qty|department|ministry|organi[sz]ation|view|click|dear|regards)/i.test(x)) ??
      null;
    if (title && title.length > 300) title = `${title.slice(0, 297)}…`;
    const org = label(/(?:organi[sz]ation|department|ministry|buyer)[^:\n]*[:\-]\s*([^\n\t]+)/i);
    const all = dates.filter((x): x is NonNullable<typeof x> => !!x);
    found.push({
      bidNumber: num,
      title,
      quantity: qty ? Number(qty.replace(/,/g, '')) : null,
      startAt: startLabel?.at ?? (all.length > 1 ? all[0]!.at ?? `${all[0]!.date}T00:00:00+05:30` : null),
      endAt: endLabel?.at ?? (all.length ? all[all.length - 1]!.at ?? `${all[all.length - 1]!.date}T23:59:00+05:30` : null),
      organisation: org,
    });
  }
  return found.map((b) => ({ ...b, startAt: b.startAt ? new Date(b.startAt).toISOString() : null, endAt: b.endAt ? new Date(b.endAt).toISOString() : null }));
}

/** "A corrigendum dated 2026-11-17 15:51:20 has been issued for Bid number GEM/2026/B/8166366 dated 21-October-2026." */
export function parseCorrigendum(subject: string, text: string) {
  const all = `${subject}\n${text}`;
  const bid = (all.match(BID_RE) ?? [])[0] ?? null;
  const when = gemDate(/corrigendum\s+dated\s+([^\n]+?)\s+has\s+been/i.exec(all)?.[1]);
  const bidDate = gemDate(/GEM\/\d{4}\/[A-Z]\/\d+\s+dated\s+([^\n.]+)/i.exec(all)?.[1]);
  return { bidNumber: bid, corrigendumAt: when?.at ?? (when ? `${when.date}T00:00:00.000Z` : null), bidDate: bidDate?.date ?? null };
}

/** Any other GeM mail about a bid: its number and what happened (from the subject). */
export function parseGemUpdate(subject: string, text: string) {
  const bid = (`${subject}\n${text}`.match(BID_RE) ?? [])[0] ?? null;
  const what = subject.replace(/^.*?GEM\/\d{4}\/[A-Z]\/\d+\s*[:\-–]?\s*/i, '').trim() || subject;
  const status = /cancel/i.test(what)
    ? 'cancelled'
    : /award|won|L1|successful/i.test(what) && !/not\s+(been\s+)?(award|success)/i.test(what)
      ? 'won'
      : /disqualif|reject|not\s+qualif|unsuccessful/i.test(what)
        ? 'lost'
        : /technically\s+qualif|qualified/i.test(what)
          ? 'technically_qualified'
          : /participat|submitted|bid\s+received/i.test(what)
            ? 'submitted'
            : null;
  return { bidNumber: bid, what, status };
}

/* ───────────── the bid document ───────────── */

export interface BidDocument {
  bidNumber: string | null;
  bidDate: string | null;
  endAt: string | null;
  openingAt: string | null;
  ministry: string | null;
  department: string | null;
  organisation: string | null;
  category: string | null;
  quantity: number | null;
  minTurnover: number | null;
  experienceYears: number | null;
  mseExempt: boolean | null;
  startupExempt: boolean | null;
  documentsRequired: string[];
  emdAmount: number | null;
  epbgPercent: number | null;
  bidType: string | null;
  /** Other facts worth showing (office, contract period, offer validity, evaluation, estimated value…). */
  extra: Record<string, string>;
  /** "Scope of Work:1793699147.pdf" → { '1793699147.pdf': 'Scope of Work' } (names of linked buyer files). */
  fileLabels: Record<string, string>;
}

/** Amounts as GeM prints them: "50 Lakh (s)", "1.5 Crore", "₹ 2,50,000". */
export function inr(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /([\d,]+(?:\.\d+)?)\s*(lakh|lac|crore|cr)?/i.exec(v.replace(/₹|INR|Rs\.?/gi, ''));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] ?? '').toLowerCase();
  return u.startsWith('lakh') || u === 'lac' ? n * 1e5 : u.startsWith('cr') ? n * 1e7 : n;
}

/** Reads a GeM bid document (its text, page by page joined). Labels are matched in English. */
export function parseBidDocument(text: string): BidDocument {
  const t = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  // the value after an English label (the Hindi label before it is ignored)
  const after = (re: RegExp, stop = /\n/) => {
    const m = re.exec(t);
    if (!m) return null;
    const rest = t.slice(m.index + m[0].length).replace(/^[\s:/\-]+/, '');
    const v = rest.split(stop)[0]!.trim();
    return v || rest.split('\n').find((x) => x.trim())?.trim() || null;
  };
  const lines = t.split('\n').map((x) => x.trim());
  // value written before its label (a long value wraps above a short label in GeM's table)
  const docsBefore = () => {
    const i = lines.findIndex((x) => /Document required/i.test(x));
    if (i < 0) return null;
    const got: string[] = [];
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const x = lines[j]!.replace(/^.*\t/, '');
      if (!/,|\(Requested|in ATC\)/i.test(x) || /\b(the|must|bidder|seeking|eligibility|supporting|uploaded|evaluation|buyer|relaxation)\b/.test(x)) break;
      got.unshift(x);
    }
    return got.length ? got.join(' ') : null;
  };
  const yes = (v: string | null) => (v == null ? null : /^\s*(yes|हाँ|हां)/i.test(v) ? true : /^\s*(no|नहीं)/i.test(v) ? false : null);
  const docs0 = after(/Document required from seller/i, /\n\s*\*|\n\s*(?:Do you want|Bid to RA|Type of Bid|Primary product|Time allowed|Inspection|Evaluation)/i);
  const docs = docsBefore() ?? (docs0 && /^\*|^In case/i.test(docs0) ? null : docs0);
  const docList = (docs ?? '')
    .split(/,|\n/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 2 && x.length < 200 && !/^in case any bidder/i.test(x));
  return {
    bidNumber: (t.match(BID_RE) ?? [])[0] ?? null,
    bidDate: gemDate(after(/\bDated\b/i))?.date ?? null,
    endAt: gemDate(after(/Bid End Date\s*\/\s*Time/i))?.at ?? null,
    openingAt: gemDate(after(/Bid Opening Date\s*\/\s*Time/i))?.at ?? gemDate(/Bid Opening[^\n]*\n\s*(\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i.exec(t)?.[1])?.at ?? null,
    ministry: after(/Ministry\s*\/\s*State Name/i),
    department: after(/Department Name/i),
    organisation: after(/Organi[sz]ation Name/i),
    category: after(/Item Category/i),
    quantity: (() => {
      const v = after(/Total Quantity/i);
      return v && /^[\d,.]+/.test(v) ? Number(v.replace(/,/g, '').match(/^[\d.]+/)![0]) : null;
    })(),
    minTurnover: inr(/Minimum Average Annual Turnover of the bidder(?:\s*\(For \d+ Years?\))?[\s:/-]*([^\n]+)/i.exec(t)?.[1] ?? null),
    experienceYears: (() => {
      const v = /Years of Past Experience Required(?: for same\/similar (?:service|product)s?)?[\s:/-]*([^\n]+)/i.exec(t)?.[1] ?? null;
      const n = v ? /([\d.]+)/.exec(v) : null;
      return n ? Number(n[1]) : null;
    })(),
    mseExempt: yes(after(/MSE (?:Exemption|Relaxation) for Years Of Experience(?: and Turnover)?/i)),
    startupExempt: yes(after(/Startup (?:Exemption|Relaxation) for Years Of(?:\s+Experience(?: and Turnover)?)?/i)),
    documentsRequired: [...new Set(docList)],
    emdAmount: (() => {
      const v = after(/EMD Amount/i);
      return v ? inr(v) : /EMD Detail[\s\S]{0,200}?Required\s*[:\-]?\s*No/i.test(t) ? 0 : null;
    })(),
    epbgPercent: (() => {
      const v = after(/ePBG Percentage\s*\(%\)/i);
      const n = v ? /([\d.]+)/.exec(v) : null;
      return n ? Number(n[1]) : null;
    })(),
    bidType: after(/Type of Bid/i),
    extra: (() => {
      const e: Record<string, string> = {};
      const put = (k: string, v: string | null | undefined) => {
        const x = v?.replace(/\s+/g, ' ').trim();
        if (x && x.length < 400) e[k] = x;
      };
      put('Office', after(/Office Name/i));
      put('Contract period', after(/Contract Period/i));
      put('Offer validity', /Bid Offer[^\n]*\n\s*(\d+\s*\(Days\))/i.exec(t)?.[1] ?? after(/Validity \(From End Date\)/i));
      put('Evaluation method', after(/Evaluation Method/i));
      put('Estimated bid value', after(/Estimated Bid Value(?!\s+indicated)/i));
      put('Bid to RA', after(/Bid to RA enabled/i));
      put('EMD bank', after(/Advisory Bank/i));
      put('ePBG duration (months)', /Duration of ePBG[^\n]*\n?\s*(\d+)/i.exec(t)?.[1]);
      put('Contract type', after(/Type of Contract/i));
      put('Inspection', after(/Inspection Required/i));
      put('Buyer email', /Buyer Email id\s*:\s*(\S+@\S+)/i.exec(t)?.[1]);
      put('Grievance email', /HOD Email id\s*:\s*(\S+@\S+)/i.exec(t)?.[1]);
      put('Pre-bid', /Pre[- ]?Bid Date and Time[\s:/-]*([^\n]+)/i.exec(t)?.[1]);
      put('Payment timelines', /Payment Timelines/i.test(t) ? /(Payments? shall be made[^]*?)(?:\n[^\n]*\/|\n\S*\s*Evaluation)/i.exec(t)?.[1]?.replace(/Payment Timelines/i, '') : null);
      return e;
    })(),
    fileLabels: Object.fromEntries([...t.matchAll(/^\s*([A-Za-z][A-Za-z /&()-]{2,60}?)\s*:\s*(\d{6,}\.(?:pdf|docx?|xlsx?|zip))\s*$/gim)].map((m) => [m[2]!, m[1]!.trim()])),
  };
}

/** Which organisation documents answer a document the bid asks for. */
export const DOC_MAP: [RegExp, string[], string][] = [
  [/experience|past\s*performance|work\s*order|completion/i, ['experience_certificate'], 'Work orders / completion certificates for similar work'],
  [/turnover|financial/i, ['turnover_certificate', 'audited_financials', 'itr'], 'CA turnover certificate / audited accounts / ITRs'],
  [/oem|authori[sz]ation/i, ['oem_authorization'], 'OEM authorisation'],
  [/iso|quality|bis/i, ['iso'], 'ISO / quality certificates'],
  [/gst/i, ['gst'], 'GST registration'],
  [/pan\b/i, ['pan'], 'PAN'],
  [/msme|mse|udyam|udyog/i, ['udyam'], 'Udyam (MSME) certificate'],
  [/startup|dpiit/i, ['startup_india'], 'Startup India recognition'],
  [/epf|esic|pf\b/i, ['epf_esic'], 'EPF / ESIC registration'],
  [/incorporation|registration\s*certificate|partnership|llp/i, ['incorporation', 'llp_agreement'], 'Registration documents'],
];

/* ───────────── does a mail name the business? (personal mailboxes) ───────────── */

export interface BusinessTerms {
  gstins: string[];
  names: string[];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const LEGAL = /\b(llp|pvt|private|ltd|limited|opc|inc|co|company|india)\b/g;

/** The words that say a mail is the business's: GSTINs and PAN, its names, and its partners' names. */
export function businessTerms(input: { gstins: (string | null | undefined)[]; pan?: string | null; names: (string | null | undefined)[]; partners: (string | null | undefined)[] }): BusinessTerms {
  const names = new Set<string>();
  for (const n of [...input.names, ...input.partners]) {
    if (!n) continue;
    const full = norm(n).trim();
    if (full.length >= 4) names.add(full);
    // "HRP AI LLP" is also written "HRP AI"
    const core = full.replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
    if (core.length >= 4) names.add(core);
  }
  return {
    gstins: [...new Set([...input.gstins, input.pan].filter((g): g is string => !!g && g.length >= 10).map((g) => g.toUpperCase()))],
    names: [...names],
  };
}

/** What in the text names the business, or null. */
export function namesBusiness(text: string, t: BusinessTerms): string | null {
  const up = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (const g of t.gstins) if (up.includes(g)) return g;
  const n = norm(text);
  for (const name of t.names) if (n.includes(` ${name} `)) return name;
  return null;
}
