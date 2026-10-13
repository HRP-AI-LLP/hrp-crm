import { describe, expect, it } from 'vitest';
import { checkFormula, coerceResult, evalCondition, evalFormula, FormulaError, compileFormula } from '../src/formula';
import { allowedChoices, checkDependencies, resolveLayout } from '../src/layout';
import type { ObjectMeta } from '../src/types';

const env = (v: Record<string, unknown>, extra = {}) => ({ get: (k: string) => v[k] as never, now: new Date('2026-10-13T10:00:00Z'), ...extra });

describe('formula language', () => {
  it('does arithmetic with precedence and blanks', () => {
    expect(evalFormula('1 + 2 * 3', env({}))).toBe(7);
    expect(evalFormula('(1 + 2) * 3', env({}))).toBe(9);
    expect(evalFormula('2 ^ 3 ^ 2', env({}))).toBe(512);
    expect(evalFormula('amount * probability / 100', env({ amount: 500000, probability: 40 }))).toBe(200000);
    expect(evalFormula('amount * 2', env({ amount: null }))).toBe(null);
    expect(evalFormula('10 / 0', env({}))).toBe(null);
  });
  it('handles text, logic and functions', () => {
    expect(evalFormula('first_name & " " & UPPER(last_name)', env({ first_name: 'Asha', last_name: 'rao' }))).toBe('Asha RAO');
    expect(evalFormula('IF(amount > 1000000, "Enterprise", "SMB")', env({ amount: 2_500_000 }))).toBe('Enterprise');
    expect(evalFormula('CASE(source, "website", 1, "referral", 2, 0)', env({ source: 'referral' }))).toBe(2);
    expect(evalCondition('ISBLANK(email) AND NOT ISBLANK(phone)', env({ email: '', phone: '98' }))).toBe(true);
    expect(evalCondition('amount >= 100 && stage = "won" || vip', env({ amount: 50, stage: 'x', vip: true }))).toBe(true);
    expect(evalFormula('ROUND(2.345, 2)', env({}))).toBe(2.35);
    expect(evalFormula('BLANKVALUE(nick, "n/a")', env({}))).toBe('n/a');
    expect(evalCondition('INCLUDES(tags, "vip")', env({ tags: ['a', 'vip'] }))).toBe(true);
    expect(evalCondition('REGEX(pan, "[A-Z]{5}[0-9]{4}[A-Z]")', env({ pan: 'ABCDE1234F' }))).toBe(true);
  });
  it('does date maths', () => {
    expect(evalFormula('DAYS_BETWEEN(TODAY(), close_date)', env({ close_date: '2026-10-20' }))).toBe(7);
    expect(evalFormula('close_date + 10', env({ close_date: '2026-10-25' }))).toBe('2026-11-04');
    expect(evalFormula('ADD_MONTHS("2026-01-31", 1)', env({}))).toBe('2026-02-28');
    expect(evalFormula('YEAR(created_at)', env({ created_at: '2026-03-04T05:06:07Z' }))).toBe(2026);
  });
  it('supports ISCHANGED / PRIORVALUE / ISNEW', () => {
    const e = env({ stage: 'won' }, { prior: (k: string) => ({ stage: 'open' })[k as 'stage'], isNew: false });
    expect(evalCondition('ISCHANGED(stage) && PRIORVALUE(stage) = "open"', e)).toBe(true);
    expect(evalCondition('ISNEW()', env({}, { isNew: true }))).toBe(true);
  });
  it('reports syntax and unknown fields', () => {
    expect(() => compileFormula('1 +')).toThrow(FormulaError);
    expect(() => compileFormula('FOO(1)')).toThrow(/Unknown function FOO/);
    expect(() => compileFormula('IF(1)')).toThrow(/IF expects/);
    expect(checkFormula('amount * rate', ['amount'])).toBe('Unknown field: rate');
    expect(checkFormula('"unclosed', [])).toMatch(/Unclosed/);
    expect(checkFormula('x'.repeat(2001), [])).toMatch(/longer/);
  });
  it('limits work and rejects dangerous regex', () => {
    const deep = '('.repeat(60) + '1' + ')'.repeat(60);
    expect(() => compileFormula(deep)).toThrow(/nested/);
    expect(evalFormula('REGEX(x, "(a+)+")', env({ x: 'aaaa' }))).toBe(null);
  });
  it('coerces results', () => {
    expect(coerceResult(1.23456, 'currency', 2)).toBe(1.23);
    expect(coerceResult('2026-01-02T10:00:00Z', 'date')).toBe('2026-01-02');
    expect(coerceResult('yes', 'boolean')).toBe(true);
    expect(coerceResult('', 'text')).toBe(null);
  });
});

const obj: ObjectMeta = {
  key: 'property', label: 'Property', plural: 'Properties', icon: null, isStandard: false, moduleKey: null,
  fields: [
    { key: 'name', label: 'Name', type: 'text', standard: true },
    { key: 'city', label: 'City', type: 'picklist', standard: false, options: { choices: [{ value: 'blr', label: 'Bengaluru' }, { value: 'mum', label: 'Mumbai' }] } },
    { key: 'area', label: 'Area', type: 'picklist', standard: false, options: { choices: [{ value: 'hsr', label: 'HSR' }, { value: 'bandra', label: 'Bandra' }], controlling: { field: 'city', map: { blr: ['hsr'], mum: ['bandra'] } } } },
    { key: 'loan_amount', label: 'Loan', type: 'currency', standard: false, options: { requiredWhen: 'financing = "loan"' } },
    { key: 'financing', label: 'Financing', type: 'text', standard: false },
  ],
  layout: { sections: [{ id: 'a', title: 'Main', columns: 2, fields: ['name', 'ghost', 'city'] }], hidden: ['financing'] },
};

describe('layouts and dependencies', () => {
  it('reconciles a saved layout with current fields', () => {
    const l = resolveLayout(obj);
    expect(l.sections[0]!.fields).toEqual(['name', 'city', 'area', 'loan_amount']);
    expect(l.hidden).toEqual(['financing']);
  });
  it('filters dependent choices and enforces conditional requirements', () => {
    expect(allowedChoices(obj.fields[2]!, { city: 'blr' }).map((c) => c.value)).toEqual(['hsr']);
    expect(allowedChoices(obj.fields[2]!, {})).toEqual([]);
    const issues = checkDependencies(obj, { city: 'blr', area: 'bandra', financing: 'loan' }, null);
    expect(issues.map((i) => i.field).sort()).toEqual(['area', 'loan_amount']);
    expect(checkDependencies(obj, { city: 'mum', area: 'bandra', financing: 'cash' }, null)).toEqual([]);
  });
});
