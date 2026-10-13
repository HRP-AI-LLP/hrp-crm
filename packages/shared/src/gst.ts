/** Indian GST helpers shared by the API and the web app. */

/** GST state codes (place of supply). */
export const GST_STATES: [code: string, name: string][] = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'],
  ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'],
  ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other Territory'], ['96', 'Other Country'],
];

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const BY_NAME = new Map(GST_STATES.map(([c, n]) => [norm(n), c]));
const ALIASES: Record<string, string> = { newdelhi: '07', nctofdelhi: '07', orissa: '21', pondicherry: '34', bombay: '27', jandk: '01', daman: '26', dadra: '26' };

/** State code for a state name (or a GSTIN), or null. */
export function stateCode(stateOrGstin: string | null | undefined): string | null {
  if (!stateOrGstin) return null;
  const s = stateOrGstin.trim();
  if (/^[0-9]{2}[A-Z0-9]{13}$/.test(s)) return s.slice(0, 2);
  if (/^[0-9]{2}$/.test(s)) return s;
  return BY_NAME.get(norm(s)) ?? ALIASES[norm(s)] ?? null;
}

export function stateName(code: string | null | undefined): string | null {
  return GST_STATES.find(([c]) => c === code)?.[1] ?? null;
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN format + check digit (mod-36 Luhn variant used by GSTN). */
export function validGstin(gstin: string | null | undefined): boolean {
  if (!gstin || !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(gstin[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

/** Indian financial year label for a date: 2026-10-14 → "2026-27" (April to March). */
export function financialYear(d: Date | string): string {
  const x = typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : d;
  const y = x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export type SupplyType = 'intra' | 'inter' | 'export';

/** CGST+SGST inside the seller's state, IGST across states, IGST (zero/LUT handled by rate) for exports. */
export function supplyType(sellerStateCode: string | null, posCode: string | null): SupplyType {
  if (posCode === '96') return 'export';
  if (!sellerStateCode || !posCode) return 'intra';
  return sellerStateCode === posCode ? 'intra' : 'inter';
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Splits a line's tax into CGST/SGST (half each, SGST takes the odd paisa) or IGST. */
export function splitTax(tax: number, type: SupplyType) {
  if (type === 'intra') {
    const c = r2(tax / 2);
    return { cgst: c, sgst: r2(tax - c), igst: 0 };
  }
  return { cgst: 0, sgst: 0, igst: r2(tax) };
}
