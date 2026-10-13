/**
 * Synapse formula language — a small, safe, side-effect-free expression evaluator shared by the
 * API (formula fields, validation rules, conditional visibility/required, automation branches)
 * and the SPA (live preview, client-side visibility). No eval, no property access, no loops:
 * only literals, field references, operators and a fixed function library, with size and step
 * limits so a tenant-authored expression can never hog a Worker isolate.
 *
 *   IF(amount > 1000000, "Enterprise", "SMB")
 *   DAYS_BETWEEN(TODAY(), close_date) < 7 && ISBLANK(contact_id)
 *   ROUND(amount * probability / 100, 0)
 */

export type FValue = number | string | boolean | null | FValue[];

export class FormulaError extends Error {
  constructor(
    message: string,
    public pos = -1,
  ) {
    super(pos >= 0 ? `${message} (at character ${pos + 1})` : message);
  }
}

type Node =
  | { k: 'lit'; v: FValue }
  | { k: 'ref'; name: string; pos: number }
  | { k: 'un'; op: string; x: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[]; pos: number };

interface Tok {
  t: 'num' | 'str' | 'id' | 'op' | '(' | ')' | ',' | 'eof';
  v: string;
  pos: number;
}

const MAX_LEN = 2000;
const MAX_DEPTH = 40;
const MAX_STEPS = 20_000;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9_]/.test(src[i]!)) i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && /[0-9]/.test(src[i]!)) i++;
      }
      out.push({ t: 'num', v: src.slice(start, i).replace(/_/g, ''), pos: start });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let s = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1]!;
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else s += src[i++];
      }
      if (src[i] !== c) throw new FormulaError('Unclosed text value', start);
      i++;
      out.push({ t: 'str', v: s, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      out.push({ t: 'id', v: src.slice(start, i), pos: start });
      continue;
    }
    if (c === '{') {
      // {field_key} form, handy when a key collides with a function name
      const end = src.indexOf('}', i);
      if (end < 0) throw new FormulaError('Unclosed {field}', start);
      out.push({ t: 'id', v: `{${src.slice(i + 1, end).trim()}}`, pos: start });
      i = end + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>', '==', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%<>=!&^'.includes(c)) {
      out.push({ t: 'op', v: c, pos: start });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, v: c, pos: start });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`, start);
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

// precedence climbing
const BINARY: Record<string, number> = { '||': 1, OR: 1, '&&': 2, AND: 2, '=': 3, '==': 3, '!=': 3, '<>': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 8 };

function parse(src: string): Node {
  if (src.length > MAX_LEN) throw new FormulaError(`Formula is longer than ${MAX_LEN} characters`);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const opOf = (t: Tok) => (t.t === 'op' ? t.v : t.t === 'id' && /^(and|or)$/i.test(t.v) ? t.v.toUpperCase() : null);

  function primary(depth: number): Node {
    if (depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply');
    const t = next();
    switch (t.t) {
      case 'num':
        return { k: 'lit', v: Number(t.v) };
      case 'str':
        return { k: 'lit', v: t.v };
      case '(': {
        const e = expr(0, depth + 1);
        if (next().t !== ')') throw new FormulaError('Missing ")"', t.pos);
        return e;
      }
      case 'op':
        if (t.v === '-' || t.v === '!' || t.v === '+') return { k: 'un', op: t.v === '!' ? 'NOT' : t.v, x: primary(depth + 1) };
        break;
      case 'id': {
        const up = t.v.toUpperCase();
        if (up === 'TRUE') return { k: 'lit', v: true };
        if (up === 'FALSE') return { k: 'lit', v: false };
        if (up === 'NULL' || up === 'BLANK') return { k: 'lit', v: null };
        if (up === 'NOT' && peek().t !== '(') return { k: 'un', op: 'NOT', x: primary(depth + 1) };
        if (t.v.startsWith('{')) return { k: 'ref', name: t.v.slice(1, -1), pos: t.pos };
        if (peek().t === '(') {
          next();
          const args: Node[] = [];
          if (peek().t !== ')') {
            for (;;) {
              args.push(expr(0, depth + 1));
              if (peek().t === ',') {
                next();
                continue;
              }
              break;
            }
          }
          if (next().t !== ')') throw new FormulaError(`Missing ")" after ${up}(`, t.pos);
          if (!FUNCTIONS[up]) throw new FormulaError(`Unknown function ${up}`, t.pos);
          const [min, max] = FUNCTIONS[up]!.arity;
          if (args.length < min || args.length > max) throw new FormulaError(`${up} expects ${min === max ? min : `${min}–${max === Infinity ? 'any' : max}`} argument${max === 1 ? '' : 's'}`, t.pos);
          return { k: 'call', fn: up, args, pos: t.pos };
        }
        return { k: 'ref', name: t.v, pos: t.pos };
      }
    }
    throw new FormulaError(t.t === 'eof' ? 'Formula ends unexpectedly' : `Unexpected "${t.v}"`, t.pos);
  }

  function expr(minPrec: number, depth: number): Node {
    let left = primary(depth);
    for (;;) {
      const op = opOf(peek());
      const prec = op ? BINARY[op] : undefined;
      if (!op || prec === undefined || prec < minPrec) break;
      next();
      // ^ is right-associative, everything else left
      const right = expr(op === '^' ? prec : prec + 1, depth + 1);
      left = { k: 'bin', op: op === 'AND' ? '&&' : op === 'OR' ? '||' : op === '==' ? '=' : op === '<>' ? '!=' : op, a: left, b: right };
    }
    return left;
  }

  const ast = expr(0, 0);
  const t = peek();
  if (t.t !== 'eof') throw new FormulaError(`Unexpected "${t.v}"`, t.pos);
  return ast;
}

// ------------------------------------------------------------------------------------- values
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isBlank = (v: FValue | undefined): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function num(v: FValue): number | null {
  if (v === null || v === '' || Array.isArray(v)) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function str(v: FValue): string {
  if (v === null) return '';
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}
function truthy(v: FValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && !/^(false|no|0)$/i.test(v);
  if (Array.isArray(v)) return v.length > 0;
  return false;
}
/** days since epoch for a YYYY-MM-DD or ISO date-time */
function toDay(v: FValue): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(DATE_RE.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}
const fromDay = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
const isDateLike = (v: FValue) => typeof v === 'string' && (DATE_RE.test(v) || /^\d{4}-\d{2}-\d{2}T/.test(v));

function eq(a: FValue, b: FValue): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = num(a);
    const y = num(b);
    return x !== null && y !== null && x === y;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return str(a).toLowerCase() === str(b).toLowerCase();
}
function cmp(a: FValue, b: FValue): number | null {
  if (isBlank(a) || isBlank(b)) return null;
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null && !(isDateLike(a) || isDateLike(b))) return x - y;
  return str(a) < str(b) ? -1 : str(a) > str(b) ? 1 : 0;
}

// ------------------------------------------------------------------------------------ library
export interface FormulaEnv {
  /** current value of a field (custom and standard merged) */
  get: (field: string) => FValue | undefined;
  /** value before this change (validation rules); undefined when creating */
  prior?: (field: string) => FValue | undefined;
  isNew?: boolean;
  now?: Date;
  /** user running the action (USER_ID()) */
  userId?: string;
}

type Fn = { arity: [number, number]; lazy?: boolean; doc: string; run: (args: FValue[], env: FormulaEnv, raw: Node[], ev: (n: Node) => FValue) => FValue };

const FUNCTIONS: Record<string, Fn> = {
  IF: { arity: [2, 3], lazy: true, doc: 'IF(condition, then, else)', run: (_a, _e, raw, ev) => (truthy(ev(raw[0]!)) ? ev(raw[1]!) : raw[2] ? ev(raw[2]) : null) },
  CASE: {
    arity: [3, 61],
    lazy: true,
    doc: 'CASE(value, match1, result1, …, default)',
    run: (_a, _e, raw, ev) => {
      const v = ev(raw[0]!);
      let i = 1;
      for (; i + 1 < raw.length; i += 2) if (eq(v, ev(raw[i]!))) return ev(raw[i + 1]!);
      return i < raw.length ? ev(raw[i]!) : null;
    },
  },
  AND: { arity: [1, 50], lazy: true, doc: 'AND(a, b, …)', run: (_a, _e, raw, ev) => raw.every((n) => truthy(ev(n))) },
  OR: { arity: [1, 50], lazy: true, doc: 'OR(a, b, …)', run: (_a, _e, raw, ev) => raw.some((n) => truthy(ev(n))) },
  NOT: { arity: [1, 1], doc: 'NOT(x)', run: ([x]) => !truthy(x!) },
  ISBLANK: { arity: [1, 1], doc: 'ISBLANK(field)', run: ([x]) => isBlank(x) },
  BLANKVALUE: { arity: [2, 2], doc: 'BLANKVALUE(value, fallback)', run: ([x, d]) => (isBlank(x) ? d! : x!) },
  COALESCE: { arity: [1, 20], doc: 'COALESCE(a, b, …) — first non-blank', run: (a) => a.find((x) => !isBlank(x)) ?? null },
  ROUND: { arity: [1, 2], doc: 'ROUND(number, digits)', run: ([x, d]) => { const n = num(x!); const p = 10 ** (num(d ?? 0) ?? 0); return n === null ? null : Math.round(n * p) / p; } },
  FLOOR: { arity: [1, 1], doc: 'FLOOR(number)', run: ([x]) => { const n = num(x!); return n === null ? null : Math.floor(n); } },
  CEILING: { arity: [1, 1], doc: 'CEILING(number)', run: ([x]) => { const n = num(x!); return n === null ? null : Math.ceil(n); } },
  ABS: { arity: [1, 1], doc: 'ABS(number)', run: ([x]) => { const n = num(x!); return n === null ? null : Math.abs(n); } },
  MIN: { arity: [1, 50], doc: 'MIN(a, b, …)', run: (a) => { const ns = a.map(num).filter((n): n is number => n !== null); return ns.length ? Math.min(...ns) : null; } },
  MAX: { arity: [1, 50], doc: 'MAX(a, b, …)', run: (a) => { const ns = a.map(num).filter((n): n is number => n !== null); return ns.length ? Math.max(...ns) : null; } },
  CONCAT: { arity: [1, 50], doc: 'CONCAT(a, b, …)', run: (a) => a.map(str).join('') },
  UPPER: { arity: [1, 1], doc: 'UPPER(text)', run: ([x]) => str(x!).toUpperCase() },
  LOWER: { arity: [1, 1], doc: 'LOWER(text)', run: ([x]) => str(x!).toLowerCase() },
  TRIM: { arity: [1, 1], doc: 'TRIM(text)', run: ([x]) => str(x!).trim() },
  LEN: { arity: [1, 1], doc: 'LEN(text)', run: ([x]) => str(x!).length },
  LEFT: { arity: [2, 2], doc: 'LEFT(text, n)', run: ([x, n]) => str(x!).slice(0, Math.max(0, num(n!) ?? 0)) },
  RIGHT: { arity: [2, 2], doc: 'RIGHT(text, n)', run: ([x, n]) => { const s = str(x!); const k = Math.max(0, num(n!) ?? 0); return k ? s.slice(-k) : ''; } },
  CONTAINS: { arity: [2, 2], doc: 'CONTAINS(text, part)', run: ([x, y]) => str(x!).toLowerCase().includes(str(y!).toLowerCase()) },
  BEGINS: { arity: [2, 2], doc: 'BEGINS(text, prefix)', run: ([x, y]) => str(x!).toLowerCase().startsWith(str(y!).toLowerCase()) },
  SUBSTITUTE: { arity: [3, 3], doc: 'SUBSTITUTE(text, find, replace)', run: ([x, f, r]) => (str(f!) ? str(x!).split(str(f!)).join(str(r!)) : str(x!)) },
  REGEX: {
    arity: [2, 2],
    doc: 'REGEX(text, pattern) — true when the whole text matches',
    run: ([x, p]) => {
      const pat = str(p!);
      // guard against catastrophic patterns: short patterns, no nested quantifiers
      if (pat.length > 200 || /\([^)]*[+*][^)]*\)[+*{]/.test(pat)) throw new FormulaError('REGEX pattern is too complex');
      try {
        return new RegExp(`^(?:${pat})$`).test(str(x!).slice(0, 1000));
      } catch {
        throw new FormulaError('REGEX pattern is not valid');
      }
    },
  },
  INCLUDES: { arity: [2, 2], doc: 'INCLUDES(multi_picklist, value)', run: ([x, v]) => (Array.isArray(x) ? x.some((i) => eq(i, v!)) : eq(x!, v!)) },
  TEXT: { arity: [1, 1], doc: 'TEXT(value)', run: ([x]) => str(x!) },
  VALUE: { arity: [1, 1], doc: 'VALUE(text) — text to number', run: ([x]) => num(x!) },
  TODAY: { arity: [0, 0], doc: 'TODAY()', run: (_a, e) => (e.now ?? new Date()).toISOString().slice(0, 10) },
  NOW: { arity: [0, 0], doc: 'NOW()', run: (_a, e) => (e.now ?? new Date()).toISOString() },
  DATE: {
    arity: [3, 3],
    doc: 'DATE(year, month, day)',
    run: ([y, m, d]) => {
      const [a, b, c] = [num(y!), num(m!), num(d!)];
      if (a === null || b === null || c === null) return null;
      const dt = new Date(Date.UTC(a, b - 1, c));
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
    },
  },
  YEAR: { arity: [1, 1], doc: 'YEAR(date)', run: ([x]) => { const d = toDay(x!); return d === null ? null : new Date(d * 86_400_000).getUTCFullYear(); } },
  MONTH: { arity: [1, 1], doc: 'MONTH(date)', run: ([x]) => { const d = toDay(x!); return d === null ? null : new Date(d * 86_400_000).getUTCMonth() + 1; } },
  DAY: { arity: [1, 1], doc: 'DAY(date)', run: ([x]) => { const d = toDay(x!); return d === null ? null : new Date(d * 86_400_000).getUTCDate(); } },
  WEEKDAY: { arity: [1, 1], doc: 'WEEKDAY(date) — 1 = Sunday … 7 = Saturday', run: ([x]) => { const d = toDay(x!); return d === null ? null : new Date(d * 86_400_000).getUTCDay() + 1; } },
  ADD_DAYS: { arity: [2, 2], doc: 'ADD_DAYS(date, n)', run: ([x, n]) => { const d = toDay(x!); const k = num(n!); return d === null || k === null ? null : fromDay(d + Math.trunc(k)); } },
  ADD_MONTHS: {
    arity: [2, 2],
    doc: 'ADD_MONTHS(date, n)',
    run: ([x, n]) => {
      const d = toDay(x!);
      const k = num(n!);
      if (d === null || k === null) return null;
      const dt = new Date(d * 86_400_000);
      const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + Math.trunc(k), 1));
      const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(dt.getUTCDate(), last));
      return target.toISOString().slice(0, 10);
    },
  },
  DAYS_BETWEEN: { arity: [2, 2], doc: 'DAYS_BETWEEN(start, end)', run: ([a, b]) => { const x = toDay(a!); const y = toDay(b!); return x === null || y === null ? null : y - x; } },
  ISNEW: { arity: [0, 0], doc: 'ISNEW() — true while creating', run: (_a, e) => !!e.isNew },
  ISCHANGED: {
    arity: [1, 1],
    lazy: true,
    doc: 'ISCHANGED(field)',
    run: (_a, e, raw) => {
      const r = raw[0]!;
      if (r.k !== 'ref') throw new FormulaError('ISCHANGED needs a field name');
      if (e.isNew || !e.prior) return false;
      return JSON.stringify(e.prior(r.name) ?? null) !== JSON.stringify(e.get(r.name) ?? null);
    },
  },
  PRIORVALUE: {
    arity: [1, 1],
    lazy: true,
    doc: 'PRIORVALUE(field)',
    run: (_a, e, raw) => {
      const r = raw[0]!;
      if (r.k !== 'ref') throw new FormulaError('PRIORVALUE needs a field name');
      return e.prior?.(r.name) ?? null;
    },
  },
  USER_ID: { arity: [0, 0], doc: 'USER_ID() — the signed-in user', run: (_a, e) => e.userId ?? null },
};

export const FORMULA_FUNCTIONS = Object.entries(FUNCTIONS).map(([name, f]) => ({ name, doc: f.doc }));

// ----------------------------------------------------------------------------------- evaluate
function evaluate(ast: Node, env: FormulaEnv): FValue {
  let steps = 0;
  const ev = (n: Node): FValue => {
    if (++steps > MAX_STEPS) throw new FormulaError('Formula took too many steps');
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'ref': {
        const v = env.get(n.name);
        return v === undefined ? null : v;
      }
      case 'un': {
        const x = ev(n.x);
        if (n.op === 'NOT') return !truthy(x);
        const v = num(x);
        return v === null ? null : n.op === '-' ? -v : v;
      }
      case 'bin': {
        if (n.op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
        if (n.op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '=':
            return eq(a, b);
          case '!=':
            return !eq(a, b);
          case '<': {
            const c = cmp(a, b);
            return c !== null && c < 0;
          }
          case '<=': {
            const c = cmp(a, b);
            return c !== null && c <= 0;
          }
          case '>': {
            const c = cmp(a, b);
            return c !== null && c > 0;
          }
          case '>=': {
            const c = cmp(a, b);
            return c !== null && c >= 0;
          }
          case '&':
            return str(a) + str(b);
        }
        // date arithmetic: date ± days, date − date
        if ((n.op === '+' || n.op === '-') && isDateLike(a)) {
          const d = toDay(a);
          if (n.op === '-' && isDateLike(b)) {
            const e2 = toDay(b);
            return d === null || e2 === null ? null : d - e2;
          }
          const k = num(b);
          return d === null || k === null ? null : fromDay(n.op === '+' ? d + Math.trunc(k) : d - Math.trunc(k));
        }
        const x = num(a);
        const y = num(b);
        if (x === null || y === null) return n.op === '+' && (typeof a === 'string' || typeof b === 'string') && x === null && y === null && !isBlank(a) && !isBlank(b) ? str(a) + str(b) : null;
        switch (n.op) {
          case '+':
            return x + y;
          case '-':
            return x - y;
          case '*':
            return x * y;
          case '/':
            return y === 0 ? null : x / y;
          case '%':
            return y === 0 ? null : x % y;
          case '^': {
            const r = x ** y;
            return Number.isFinite(r) ? r : null;
          }
        }
        return null;
      }
      case 'call': {
        const fn = FUNCTIONS[n.fn]!;
        if (fn.lazy) return fn.run([], env, n.args, ev);
        return fn.run(n.args.map(ev), env, n.args, ev);
      }
    }
  };
  return ev(ast);
}

function collectRefs(n: Node, out: Set<string>) {
  if (n.k === 'ref') out.add(n.name);
  else if (n.k === 'un') collectRefs(n.x, out);
  else if (n.k === 'bin') {
    collectRefs(n.a, out);
    collectRefs(n.b, out);
  } else if (n.k === 'call') n.args.forEach((a) => collectRefs(a, out));
}

export interface CompiledFormula {
  source: string;
  refs: string[];
  run: (env: FormulaEnv) => FValue;
}

const compiledCache = new Map<string, CompiledFormula>();

/** Parses once (memoised); throws FormulaError on syntax errors. */
export function compileFormula(source: string): CompiledFormula {
  const hit = compiledCache.get(source);
  if (hit) return hit;
  const ast = parse(source);
  const refs = new Set<string>();
  collectRefs(ast, refs);
  const c: CompiledFormula = { source, refs: [...refs], run: (env) => evaluate(ast, env) };
  if (compiledCache.size > 2000) compiledCache.clear();
  compiledCache.set(source, c);
  return c;
}

/** Syntax + field-name check for the admin UI and API. Returns an error message or null. */
export function checkFormula(source: string, knownFields: Iterable<string>): string | null {
  try {
    const c = compileFormula(source);
    const known = new Set(knownFields);
    const unknown = c.refs.filter((r) => !known.has(r));
    if (unknown.length) return `Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
    return null;
  } catch (e) {
    return e instanceof FormulaError ? e.message : 'Invalid formula';
  }
}

/** Evaluates and never throws: runtime problems give null (blank), like a spreadsheet. */
export function evalFormula(source: string, env: FormulaEnv): FValue {
  try {
    return compileFormula(source).run(env);
  } catch {
    return null;
  }
}

/** Evaluates to a boolean condition; any error counts as false. */
export function evalCondition(source: string, env: FormulaEnv): boolean {
  return truthy(evalFormula(source, env));
}

export type FormulaReturnType = 'number' | 'currency' | 'percent' | 'text' | 'date' | 'boolean';

/** Coerces a formula result into the declared return type for storage. */
export function coerceResult(v: FValue, type: FormulaReturnType, precision = 2): string | number | boolean | null {
  if (isBlank(v)) return null;
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = num(v);
      if (n === null) return null;
      const p = 10 ** Math.min(Math.max(precision, 0), 6);
      return Math.round(n * p) / p;
    }
    case 'boolean':
      return truthy(v);
    case 'date': {
      const d = toDay(v);
      return d === null ? null : fromDay(d);
    }
    default:
      return str(v).slice(0, 1000);
  }
}
