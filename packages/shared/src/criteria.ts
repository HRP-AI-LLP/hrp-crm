/**
 * Record criteria shared by assignment, scoring and approval rules (evaluated in memory on a
 * flattened record: standard columns + custom fields).
 */
import type { RuleCriterion } from './types';

export const CRITERIA_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'in', 'is_empty', 'not_empty', 'is_null', 'not_null'] as const;
export type CriteriaOp = (typeof CRITERIA_OPS)[number];

const str = (x: unknown) => (x === null || x === undefined ? '' : x instanceof Date ? x.toISOString() : String(x));
const empty = (v: unknown) => str(v) === '' || (Array.isArray(v) && !v.length);

export function criterionMatches(c: RuleCriterion, rec: Record<string, unknown>): boolean {
  const v = rec[c.field];
  switch (c.op) {
    case 'eq':
      return Array.isArray(v) ? v.map(str).includes(str(c.value)) : str(v).toLowerCase() === str(c.value).toLowerCase();
    case 'neq':
      return Array.isArray(v) ? !v.map(str).includes(str(c.value)) : str(v).toLowerCase() !== str(c.value).toLowerCase();
    case 'gt':
      return !empty(v) && Number(v) > Number(c.value);
    case 'gte':
      return !empty(v) && Number(v) >= Number(c.value);
    case 'lt':
      return !empty(v) && Number(v) < Number(c.value);
    case 'lte':
      return !empty(v) && Number(v) <= Number(c.value);
    case 'contains':
      return Array.isArray(v) ? v.map(str).includes(str(c.value)) : str(v).toLowerCase().includes(str(c.value).toLowerCase());
    case 'starts_with':
      return str(v).toLowerCase().startsWith(str(c.value).toLowerCase());
    case 'in': {
      const list = Array.isArray(c.value) ? c.value.map(str) : str(c.value).split(',').map((x) => x.trim());
      return list.map((x) => x.toLowerCase()).includes(str(v).toLowerCase());
    }
    case 'is_empty':
    case 'is_null':
      return empty(v);
    case 'not_empty':
    case 'not_null':
      return !empty(v);
    default:
      return false;
  }
}

/** Every criterion must match; an empty list always matches. */
export function matchCriteria(criteria: RuleCriterion[], rec: Record<string, unknown>): boolean {
  return criteria.every((c) => criterionMatches(c, rec));
}

/** Sum of points from matching scoring rules, clamped to 0–100, and the hot/warm/cold band. */
export function scoreRecord(rules: { criteria: RuleCriterion[]; points: number }[], rec: Record<string, unknown>, bands: { hot: number; warm: number }) {
  if (!rules.length) return null;
  let score = 0;
  const reasons: string[] = [];
  for (const r of rules) {
    if (matchCriteria(r.criteria, rec)) {
      score += r.points;
      reasons.push(String((r as { name?: string }).name ?? ''));
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const rating: 'hot' | 'warm' | 'cold' = score >= bands.hot ? 'hot' : score >= bands.warm ? 'warm' : 'cold';
  return { score, rating, reasons: reasons.filter(Boolean) };
}
