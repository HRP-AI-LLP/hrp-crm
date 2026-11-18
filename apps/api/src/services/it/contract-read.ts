/**
 * Reading a signed contract (NDA, MSA, SoW, AMC, service agreement, PO): its text from PDF, Word
 * (.docx) or text, then what it says — the kind of document, the parties (which one is the client),
 * dates and term, value and currency, how it is billed (fixed, monthly fee, hourly rate, milestones),
 * payment terms, notice, renewal, governing law, the reference number and the project. Rules first;
 * an AI model, when one is set up, reads it again and fills what the rules missed.
 */
import { z } from 'zod';
import { cleanText } from '../../lib/json-safe';
import { pdfLines } from '../../lib/pdf-lines';
import { type AiCtx, guardedChat } from '../ai/features';
import { extractJson } from '../ai/router';

/* ───────────── text of the file ───────────── */

async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(ds)).arrayBuffer());
}

/** One file out of a zip (a .docx is one): found through the central directory. */
async function unzipEntry(zip: Uint8Array, name: string): Promise<Uint8Array | null> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) (eocd = i), (i = -1);
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= zip.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const n = dec.decode(zip.subarray(p + 46, p + 46 + nlen));
    if (n === name) {
      const lnlen = dv.getUint16(off + 26, true);
      const lelen = dv.getUint16(off + 28, true);
      const data = zip.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + size);
      return method === 0 ? data : method === 8 ? inflateRaw(data) : null;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const xmlText = (s: string) =>
  s
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>|<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));

/** The text of an uploaded contract; null when it cannot be read (a scan, an old .doc). */
export async function docText(name: string, bytes: Uint8Array): Promise<string | null> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf') || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
    const pages = await pdfLines(bytes, 120);
    const t = pages?.join('\n') ?? '';
    return t.replace(/\s+/g, '').length > 80 ? cleanText(t) : null;
  }
  if (lower.endsWith('.docx') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const xml = await unzipEntry(bytes, 'word/document.xml').catch(() => null);
    return xml ? cleanText(xmlText(new TextDecoder().decode(xml))) : null;
  }
  if (/\.(txt|md|rtf)$/.test(lower)) return cleanText(new TextDecoder().decode(bytes));
  return null;
}

/* ───────────── what it says ───────────── */

export type DocType = 'nda' | 'msa' | 'sow' | 'agreement' | 'amendment' | 'purchase_order' | 'other';
export type Kind = 'retainer' | 'amc' | 'time_materials' | 'fixed_bid' | 'support' | 'enterprise_licence' | 'nda' | 'msa' | 'other';
export type Frequency = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'milestone' | 'one_time' | 'none';

export interface ContractRead {
  docType: DocType;
  kind: Kind;
  title: string | null;
  parties: string[];
  client: string | null;
  clientRef: string | null;
  effectiveDate: string | null;
  endDate: string | null;
  termMonths: number | null;
  signedOn: string | null;
  currency: string;
  value: number | null;
  billingFrequency: Frequency;
  periodFee: number | null;
  hourlyRate: number | null;
  hoursPerPeriod: number | null;
  paymentTermsDays: number | null;
  noticeDays: number | null;
  autoRenew: boolean | null;
  governingLaw: string | null;
  projectName: string | null;
  parentRef: string | null;
  milestones: { name: string; amount: number | null; due: string | null }[];
  summary: string | null;
  engine: 'rules' | 'ai';
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoOf(s: string | null | undefined): string | null {
  if (!s) return null;
  const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2100 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /(\d{1,2})(?:st|nd|rd|th)?(?:\s+day\s+of)?\s+([A-Za-z]{3,9}),?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2]!.slice(0, 3).toLowerCase()]) return iso(+m[3]!, MONTHS[m[2]!.slice(0, 3).toLowerCase()]!, +m[1]!);
  m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) return iso(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!);
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  return null;
}
const DATE = String.raw`(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?(?:\s+day\s+of)?\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})`;

const CUR: [RegExp, string][] = [
  [/₹|\bINR\b|\bRs\.?\s*\d|\bRupees\b/gi, 'INR'],
  [/US\$|\bUSD\b|\$\s?\d/g, 'USD'],
  [/€|\bEUR\b/g, 'EUR'],
  [/£|\bGBP\b/g, 'GBP'],
  [/\bAED\b/g, 'AED'],
  [/\bSGD\b|S\$/g, 'SGD'],
  [/\bAUD\b|A\$/g, 'AUD'],
  [/\bCAD\b|C\$/g, 'CAD'],
];
const MONEY = String.raw`(?:₹|Rs\.?|INR|USD|US\$|\$|€|EUR|£|GBP|AED|SGD|AUD|CAD)\s?([\d,]+(?:\.\d{1,2})?)\s*(lakhs?|lacs?|crores?|k|million|mn)?|([\d,]+(?:\.\d{1,2})?)\s*(?:₹|INR|USD|EUR|GBP|AED|rupees|dollars)`;
function amountOf(m: RegExpExecArray | null): number | null {
  if (!m) return null;
  const raw = m[1] ?? m[3];
  if (!raw) return null;
  let n = Number(raw.replace(/,/g, ''));
  const u = (m[2] ?? '').toLowerCase();
  if (u.startsWith('lakh') || u.startsWith('lac')) n *= 1e5;
  else if (u.startsWith('crore')) n *= 1e7;
  else if (u === 'k') n *= 1e3;
  else if (u === 'million' || u === 'mn') n *= 1e6;
  return Number.isFinite(n) && n > 0 ? n : null;
}
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, twenty: 20, thirty: 30, sixty: 60, ninety: 90, fifteen: 15, fortyfive: 45, 'forty-five': 45, 'twenty-four': 24, thirtysix: 36, 'thirty-six': 36 };
const numOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORD_NUM[s.toLowerCase()] ?? null);
const NUM = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|eighteen|twenty|twenty-four|thirty|thirty-six|forty-five|sixty|ninety)`;

const addMonthsIso = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  const t = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, x.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

/** The two parties of "between X … and Y …": the one that is not us is the client. */
function partiesOf(text: string, own: string[]): { parties: string[]; client: string | null } {
  const flat = text.replace(/\s+/g, ' ');
  const names: string[] = [];
  const cut = (s: string) =>
    s
      .replace(/^(?:M\/s\.?|Messrs\.?)\s+/i, '')
      .split(/,\s*(?:a|an|having|incorporated|registered|with|whose|located|represented)\b|\s+\((?:hereinafter|the\s+["“]|"|“)|\s+having\s+its|\s+a\s+(?:company|limited|private|partnership|llp)\b/i)[0]!
      .replace(/[,;\s]+$/, '')
      .replace(/(?<!\b(?:Inc|Ltd|Co|Corp|Pvt|Bros|Pte|Pty|Ltda|S\.A|L\.L\.C|L\.L\.P))\.+$/, '')
      .trim();
  const m = /\bbetween\s*:?\s+(.{3,200}?)\s+(?:\(.*?\)\s+)?and\s+(.{3,200}?)(?:\s+\(|,\s*(?:a|an|having|incorporated|registered|whose|with|located|represented)\b|\.\s+[A-Z]|\s+hereinafter|\s+on\s+the\s+other|$)/i.exec(flat);
  if (m) names.push(cut(m[1]!), cut(m[2]!));
  for (const r of flat.matchAll(/\b(?:Client|Customer|Company|Service Provider|Vendor|Consultant|Supplier|Disclosing Party|Receiving Party)\s*[:\-]\s*([A-Z][A-Za-z0-9&.,'() -]{2,80}?)(?=\s{2,}|\s+(?:Address|having|located|GSTIN|PAN|$))/g)) names.push(cut(r[1]!));
  const uniq = [...new Set(names.filter((n) => n.length >= 3 && n.length <= 120 && /[A-Za-z]{3}/.test(n)))];
  const ours = (n: string) => own.some((o) => o && n.toLowerCase().includes(o.toLowerCase().replace(/\s+(llp|pvt\.?|private|ltd\.?|limited)\b.*$/i, '')));
  return { parties: uniq.slice(0, 4), client: uniq.find((n) => !ours(n)) ?? null };
}

export function readContract(text: string, ownNames: string[] = []): ContractRead {
  const t = text.replace(/\r/g, '');
  const flat = t.replace(/[ \t]+/g, ' ');
  const head = flat.slice(0, 1500);
  const docType: DocType = /non[-\s]?disclosure|confidentiality\s+agreement|\bNDA\b/i.test(head)
    ? 'nda'
    : /statement\s+of\s+work|\bSOW\b|work\s+order/i.test(head)
      ? 'sow'
      : /master\s+(?:services?\s+)?agreement|\bMSA\b/i.test(head)
        ? 'msa'
        : /\bamendment\b|\baddendum\b/i.test(head)
          ? 'amendment'
          : /purchase\s+order|\bP\.?O\.?\s*(?:No|Number)/i.test(head)
            ? 'purchase_order'
            : /agreement|contract/i.test(head)
              ? 'agreement'
              : 'other';
  const title =
    flat
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length >= 6 && l.length <= 140 && /agreement|statement of work|contract|order|addendum|amendment|NDA/i.test(l)) ?? null;
  const { parties, client } = partiesOf(t, ownNames);
  const effectiveDate =
    isoOf(new RegExp(`(?:effective\\s+(?:date|from|as\\s+of)|commencement\\s+date|start\\s+date|dated|entered\\s+into\\s+(?:on|as\\s+of)|made\\s+(?:on|this))\\s*[:\\-]?\\s*(?:this\\s+)?${DATE}`, 'i').exec(flat)?.[1]) ??
    isoOf(new RegExp(DATE, 'i').exec(head)?.[1]);
  const endExplicit = isoOf(new RegExp(`(?:end\\s+date|expiry\\s+date|expires?\\s+on|valid\\s+(?:till|until|up\\s*to)|until|till)\\s*[:\\-]?\\s*${DATE}`, 'i').exec(flat)?.[1]);
  const term = new RegExp(`(?:term|period|duration|valid(?:ity)?)\\s+(?:of\\s+)?(?:this\\s+\\w+\\s+)?(?:shall\\s+be\\s+)?(?:for\\s+)?(?:a\\s+period\\s+of\\s+)?${NUM}\\s*(?:\\(\\d+\\)\\s*)?(months?|years?)`, 'i').exec(flat);
  const termMonths = term ? (numOf(term[1]!) ?? 0) * (/year/i.test(term[2]!) ? 12 : 1) || null : null;
  const endDate = endExplicit ?? (effectiveDate && termMonths ? addMonthsIso(effectiveDate, termMonths) : null);
  const signedOn = isoOf(new RegExp(`(?:signed|executed)\\s+(?:on|at\\s+[A-Za-z ]+\\s+on)\\s*[:\\-]?\\s*${DATE}`, 'i').exec(flat)?.[1]);
  // currency: the one its amounts are in
  let currency = 'INR';
  let best = 0;
  for (const [re, c] of CUR) {
    const n = (flat.match(re) ?? []).length;
    if (n > best) [best, currency] = [n, c];
  }
  const near = (re: RegExp) => {
    const m = re.exec(flat);
    if (!m) return null;
    const window = flat.slice(m.index, m.index + 220);
    return amountOf(new RegExp(MONEY, 'i').exec(window));
  };
  const hourlyRate =
    amountOf(new RegExp(`(?:${MONEY})\\s*(?:\\/|per)\\s*(?:man[-\\s]?)?h(?:ou)?r`, 'i').exec(flat)) ?? near(/\b(?:hourly\s+rate|rate\s+per\s+hour|per\s+hour\s+rate)\b/i);
  const monthly = amountOf(new RegExp(`(?:${MONEY})\\s*(?:\\/|per|a|each)\\s*month|(?:monthly\\s+(?:fee|charges?|retainer|amount))\\s*(?:of|:|-|is|shall\\s+be)?\\s*(?:${MONEY})`, 'i').exec(flat));
  const quarterly = amountOf(new RegExp(`(?:${MONEY})\\s*(?:\\/|per|a|each)\\s*quarter`, 'i').exec(flat));
  const yearly = amountOf(new RegExp(`(?:${MONEY})\\s*(?:\\/|per|a|each)\\s*(?:year|annum)|annual\\s+(?:fee|charges?|maintenance)\\s*(?:of|:|-|is)?\\s*(?:${MONEY})`, 'i').exec(flat));
  const total =
    near(/\b(?:total\s+(?:contract\s+)?(?:value|fees?|price|amount|cost)|contract\s+(?:value|price|amount)|project\s+(?:cost|fee|value)|fixed\s+(?:fee|price|cost)|lump\s*sum|consideration)\b/i) ?? null;
  // milestones: "Milestone 1: Design – ₹50,000 (20%) – 15 Dec 2026"
  const milestones: ContractRead['milestones'] = [];
  for (const m of t.matchAll(/^\s*(?:milestone|phase|stage|deliverable)\s*[\d.:)-]*\s*[:\-–]?\s*(.{3,120}?)\s*[\t:\-–|]+\s*(.*)$/gim)) {
    const rest = m[2] ?? '';
    const amount = amountOf(new RegExp(MONEY, 'i').exec(rest));
    if (!amount && !/\d{1,3}\s*%/.test(rest)) continue;
    milestones.push({ name: m[1]!.replace(/[\s:–-]+$/, '').slice(0, 200), amount, due: isoOf(new RegExp(DATE, 'i').exec(rest)?.[1]) });
  }
  const hoursPerPeriod = (() => {
    const m = /(\d{1,4})\s*(?:man[-\s]?)?hours?\s*(?:per|a|each|\/)\s*month|(?:up\s+to|include[sd]?)\s*(\d{1,4})\s*hours/i.exec(flat);
    return m ? Number(m[1] ?? m[2]) : null;
  })();
  const kind: Kind =
    docType === 'nda'
      ? 'nda'
      : docType === 'msa' && !monthly && !total && !hourlyRate
        ? 'msa'
        : /annual\s+maintenance|\bAMC\b/i.test(flat)
          ? 'amc'
          : /retainer/i.test(flat) || (monthly && !hourlyRate)
            ? 'retainer'
            : /support\s+(?:services|agreement)|service\s+level/i.test(head)
              ? 'support'
              : /licen[cs]e/i.test(head)
                ? 'enterprise_licence'
                : hourlyRate && !total
                  ? 'time_materials'
                  : total || milestones.length || docType === 'sow'
                    ? 'fixed_bid'
                    : 'other';
  const billingFrequency: Frequency =
    kind === 'nda' || kind === 'msa' || kind === 'other'
      ? 'none'
      : monthly
        ? 'monthly'
        : quarterly
          ? 'quarterly'
          : yearly
            ? 'yearly'
            : milestones.length
              ? 'milestone'
              : kind === 'time_materials'
                ? 'monthly'
                : 'one_time';
  const periodFee = billingFrequency === 'monthly' ? monthly : billingFrequency === 'quarterly' ? quarterly : billingFrequency === 'yearly' ? yearly : null;
  const value =
    total ??
    (milestones.length && milestones.every((m) => m.amount) ? milestones.reduce((a, m) => a + (m.amount ?? 0), 0) : null) ??
    (periodFee && termMonths ? periodFee * (termMonths / ({ monthly: 1, quarterly: 3, yearly: 12 } as Record<string, number>)[billingFrequency]!) : null);
  const pay = new RegExp(`(?:within|in)\\s+${NUM}\\s*(?:\\(\\d+\\)\\s*)?(?:calendar\\s+|business\\s+|working\\s+)?days\\s+(?:of|from|after)\\s+(?:the\\s+)?(?:receipt|date|invoice|submission)`, 'i').exec(flat) ?? /\bnet\s*(\d{1,3})\b/i.exec(flat);
  const notice = new RegExp(`${NUM}\\s*(?:\\(\\d+\\)\\s*)?days['’]?\\s*(?:prior\\s+)?(?:written\\s+)?notice`, 'i').exec(flat);
  const law = /governed\s+by\s+(?:and\s+construed\s+in\s+accordance\s+with\s+)?the\s+laws\s+of\s+([A-Za-z ,]{3,60}?)(?:\.|,|\s+and\b|\s+without)/i.exec(flat)?.[1]?.trim() ?? null;
  const ref =
    /\b(?:agreement|contract|SOW|PO|work\s+order|reference|ref)\s*(?:no\.?|number|#|ref\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.-]{2,40})/i.exec(flat)?.[1]?.replace(/[.,]+$/, '') ?? null;
  const parentRef = docType === 'sow' ? (/(?:under|pursuant\s+to|governed\s+by)\s+(?:the\s+)?(?:master\s+services?\s+agreement|MSA)\s*(?:no\.?|number|dated|ref\.?)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.-]{2,40})?/i.exec(flat)?.[1] ?? null) : null;
  const projectName = /\b(?:project\s*(?:name|title)?|engagement)\s*[:\-]\s*([^\n\t]{3,120})/i.exec(t)?.[1]?.trim() ?? null;
  const scope = /\b(?:scope\s+of\s+(?:work|services)|purpose|services)\s*[:\-.]?\s*\n?([^\n]{20,600})/i.exec(t)?.[1]?.trim() ?? null;
  return {
    docType,
    kind,
    title,
    parties,
    client,
    clientRef: ref,
    effectiveDate,
    endDate,
    termMonths,
    signedOn,
    currency,
    value: value ? Math.round(value * 100) / 100 : null,
    billingFrequency,
    periodFee,
    hourlyRate,
    hoursPerPeriod,
    paymentTermsDays: pay ? numOf(pay[1]!) : null,
    noticeDays: notice ? numOf(notice[1]!) : null,
    autoRenew: /automatic(?:ally)?\s+renew|auto[-\s]?renew/i.test(flat) ? true : /shall\s+not\s+(?:be\s+)?(?:automatically\s+)?renew/i.test(flat) ? false : null,
    governingLaw: law,
    projectName,
    parentRef,
    milestones: milestones.slice(0, 30),
    summary: scope,
    engine: 'rules',
  };
}

/* ───────────── a second reading by the AI model ───────────── */

const aiSchema = z.object({
  docType: z.enum(['nda', 'msa', 'sow', 'agreement', 'amendment', 'purchase_order', 'other']).nullish(),
  kind: z.enum(['retainer', 'amc', 'time_materials', 'fixed_bid', 'support', 'enterprise_licence', 'nda', 'msa', 'other']).nullish(),
  title: z.string().nullish(),
  parties: z.array(z.string()).nullish(),
  client: z.string().nullish(),
  clientRef: z.string().nullish(),
  effectiveDate: z.string().nullish(),
  endDate: z.string().nullish(),
  termMonths: z.number().nullish(),
  signedOn: z.string().nullish(),
  currency: z.string().nullish(),
  value: z.number().nullish(),
  billingFrequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly', 'milestone', 'one_time', 'none']).nullish(),
  periodFee: z.number().nullish(),
  hourlyRate: z.number().nullish(),
  hoursPerPeriod: z.number().nullish(),
  paymentTermsDays: z.number().nullish(),
  noticeDays: z.number().nullish(),
  autoRenew: z.boolean().nullish(),
  governingLaw: z.string().nullish(),
  projectName: z.string().nullish(),
  parentRef: z.string().nullish(),
  milestones: z.array(z.object({ name: z.string(), amount: z.number().nullish(), due: z.string().nullish() })).nullish(),
  summary: z.string().nullish(),
});

const PROMPT = `You read a signed business contract for the company named below and return JSON only, with these keys (null when the contract does not say):
docType (nda|msa|sow|agreement|amendment|purchase_order|other), kind (retainer|amc|time_materials|fixed_bid|support|enterprise_licence|nda|msa|other),
title, parties (array of the legal names), client (the party that is NOT the company), clientRef (the agreement / SOW / PO number),
effectiveDate, endDate, signedOn (YYYY-MM-DD), termMonths, currency (ISO code), value (total contract value), billingFrequency (monthly|quarterly|half_yearly|yearly|milestone|one_time|none),
periodFee (the fee per billing period), hourlyRate, hoursPerPeriod, paymentTermsDays, noticeDays, autoRenew, governingLaw, projectName, parentRef (the MSA a SOW falls under),
milestones (array of {name, amount, due}), summary (two sentences: what is delivered and how it is paid). Never invent numbers.`;

export async function aiReadContract(ai: AiCtx, text: string, ownNames: string[], rules: ContractRead): Promise<ContractRead> {
  const res = await guardedChat(ai, {
    task: 'document',
    containsPii: true,
    json: true,
    maxTokens: 2500,
    temperature: 0,
    timeoutMs: 60_000,
    messages: [
      { role: 'system', content: `${PROMPT} The company: ${ownNames.join(' / ') || 'unknown'}.` },
      { role: 'user', content: `<contract>\n${text.slice(0, 40000)}\n</contract>` },
    ],
  });
  const p = aiSchema.safeParse(extractJson(res.text));
  if (!p.success) return rules;
  const a = p.data;
  const pick = <T,>(x: T | null | undefined, y: T) => (x === null || x === undefined || (Array.isArray(x) && !x.length) ? y : x);
  return {
    docType: pick(a.docType, rules.docType),
    kind: pick(a.kind, rules.kind),
    title: pick(a.title, rules.title),
    parties: pick(a.parties, rules.parties),
    client: pick(a.client, rules.client),
    clientRef: pick(a.clientRef, rules.clientRef),
    effectiveDate: isoOf(a.effectiveDate) ?? rules.effectiveDate,
    endDate: isoOf(a.endDate) ?? rules.endDate,
    termMonths: pick(a.termMonths, rules.termMonths),
    signedOn: isoOf(a.signedOn) ?? rules.signedOn,
    currency: a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : rules.currency,
    value: pick(a.value, rules.value),
    billingFrequency: pick(a.billingFrequency, rules.billingFrequency),
    periodFee: pick(a.periodFee, rules.periodFee),
    hourlyRate: pick(a.hourlyRate, rules.hourlyRate),
    hoursPerPeriod: pick(a.hoursPerPeriod, rules.hoursPerPeriod),
    paymentTermsDays: pick(a.paymentTermsDays, rules.paymentTermsDays),
    noticeDays: pick(a.noticeDays, rules.noticeDays),
    autoRenew: pick(a.autoRenew, rules.autoRenew),
    governingLaw: pick(a.governingLaw, rules.governingLaw),
    projectName: pick(a.projectName, rules.projectName),
    parentRef: pick(a.parentRef, rules.parentRef),
    milestones: a.milestones?.length ? a.milestones.map((m) => ({ name: m.name.slice(0, 200), amount: m.amount ?? null, due: isoOf(m.due) })) : rules.milestones,
    summary: pick(a.summary, rules.summary),
    engine: 'ai',
  };
}
