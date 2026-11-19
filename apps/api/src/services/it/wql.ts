/**
 * Work query language: a small JQL / WIQL-style filter for work items, compiled to parameterised SQL.
 *
 *   type = bug AND status != done AND assignee = currentUser() ORDER BY priority DESC
 *   sprint in openSprints() AND (labels = api OR component = "Mobile app") AND points >= 3
 *   text ~ "login" AND created >= -14d AND epic = FLEET-4
 *
 * Fields: project, key, type, status, state, assignee, reporter, watcher, priority, severity, points,
 * estimate, remaining, sprint, release (fixVersion), epic, parent, component, labels, text, summary,
 * description, resolution, created, updated, due, resolved, started, and custom fields (cf.key or the
 * field's key). Operators: = != > >= < <= ~ !~ IN, NOT IN, IS EMPTY, IS NOT EMPTY; AND, OR, NOT, ( ).
 * Values never reach the SQL text: everything is a bound parameter.
 */
import { badRequest } from '../../lib/errors';

type Tok = { t: 'str' | 'word' | 'num' | 'op' | 'lp' | 'rp' | 'comma'; v: string; at: number };

export interface WqlContext {
  userId: string;
  /** custom fields of the projects in scope */
  customFields: { key: string; label: string; type: string }[];
  /** workflow state labels → keys */
  stateLabels: Map<string, string[]>;
}

class P {
  vals: unknown[];
  constructor(first: unknown[]) {
    this.vals = [...first];
  }
  add(v: unknown) {
    this.vals.push(v);
    return `$${this.vals.length}`;
  }
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        v += src[j];
        j++;
      }
      if (j >= src.length) throw badRequest(`Unclosed quote at ${i + 1}`);
      out.push({ t: 'str', v, at: i });
      i = j + 1;
      continue;
    }
    if (c === '(') (out.push({ t: 'lp', v: c, at: i }), i++);
    else if (c === ')') (out.push({ t: 'rp', v: c, at: i }), i++);
    else if (c === ',') (out.push({ t: 'comma', v: c, at: i }), i++);
    else if (/[=!<>~]/.test(c)) {
      const two = src.slice(i, i + 2);
      const op = ['!=', '>=', '<=', '!~'].includes(two) ? two : c;
      if (op === '!') throw badRequest(`Unexpected "!" at ${i + 1}`);
      out.push({ t: 'op', v: op, at: i });
      i += op.length;
    } else {
      const m = /^[-+]?[\w.@:/#-]+/.exec(src.slice(i));
      if (!m) throw badRequest(`Unexpected "${c}" at ${i + 1}`);
      out.push({ t: /^[-+]?\d+(\.\d+)?$/.test(m[0]) ? 'num' : 'word', v: m[0], at: i });
      i += m[0].length;
    }
  }
  return out;
}

type Val = { kind: 'lit'; v: string } | { kind: 'fn'; name: string; args: string[] } | { kind: 'empty' };

const FIELD_ALIAS: Record<string, string> = {
  issuetype: 'type', workitemtype: 'type', 'work item type': 'type', statuscategory: 'status', storypoints: 'points', 'story points': 'points', sp: 'points',
  fixversion: 'release', version: 'release', iteration: 'sprint', iterationpath: 'sprint', label: 'labels', tag: 'labels', tags: 'labels', components: 'component',
  duedate: 'due', resolutiondate: 'resolved', closed: 'resolved', createddate: 'created', changeddate: 'updated', assignedto: 'assignee', title: 'summary', name: 'summary',
  originalestimate: 'estimate', remainingwork: 'remaining', number: 'key', id: 'key',
};
const PRIORITY = ['none', 'low', 'medium', 'high', 'urgent'];
const STATUS_ALIAS: Record<string, string> = { 'to do': 'open', todo: 'open', new: 'open', open: 'open', backlog: 'open', 'in progress': 'in_progress', in_progress: 'in_progress', active: 'in_progress', doing: 'in_progress', review: 'review', 'in review': 'review', blocked: 'blocked', done: 'done', closed: 'done', resolved: 'done', cancelled: 'cancelled', canceled: 'cancelled', removed: 'cancelled' };
const TYPE_ALIAS: Record<string, string> = { 'sub-task': 'subtask', subtask: 'subtask', 'user story': 'story', story: 'story', pbi: 'story', 'product backlog item': 'story', bug: 'bug', defect: 'bug', task: 'task', epic: 'epic', feature: 'feature', spike: 'spike', chore: 'chore' };

export interface Compiled {
  where: string;
  order: string;
  params: unknown[];
}

/** Compiles a query; `first` are the parameters already used by the caller ($1…). */
export function compileWql(src: string, ctx: WqlContext, first: unknown[]): Compiled {
  const toks = lex(src.trim());
  let i = 0;
  const p = new P(first);
  const peek = () => toks[i];
  const kw = (w: string) => peek()?.t === 'word' && peek()!.v.toLowerCase() === w;
  const expect = (t: Tok['t'], what: string) => {
    const k = toks[i];
    if (!k || k.t !== t) throw badRequest(`Expected ${what}${k ? ` at ${k.at + 1}` : ' at the end'}`);
    i++;
    return k;
  };

  const value = (): Val => {
    const k = toks[i];
    if (!k) throw badRequest('A value is missing at the end');
    if (k.t === 'str' || k.t === 'num') return (i++, { kind: 'lit', v: k.v });
    if (k.t === 'word') {
      i++;
      if (toks[i]?.t === 'lp') {
        i++;
        const args: string[] = [];
        while (toks[i] && toks[i]!.t !== 'rp') {
          const a = toks[i]!;
          if (a.t === 'comma') {
            i++;
            continue;
          }
          args.push(a.v);
          i++;
        }
        expect('rp', '")"');
        return { kind: 'fn', name: k.v.toLowerCase(), args };
      }
      if (/^(empty|null)$/i.test(k.v)) return { kind: 'empty' };
      return { kind: 'lit', v: k.v };
    }
    throw badRequest(`Expected a value at ${k.at + 1}`);
  };

  /* ───── dates ───── */
  const dateExpr = (v: Val): string => {
    if (v.kind === 'fn') {
      const map: Record<string, string> = {
        now: `now()`, startofday: `date_trunc('day', now())`, endofday: `date_trunc('day', now()) + interval '1 day'`, startofweek: `date_trunc('week', now())`,
        endofweek: `date_trunc('week', now()) + interval '7 days'`, startofmonth: `date_trunc('month', now())`, endofmonth: `date_trunc('month', now()) + interval '1 month'`,
        startofyear: `date_trunc('year', now())`, today: `date_trunc('day', now())`,
      };
      const base = map[v.name];
      if (!base) throw badRequest(`Unknown date function ${v.name}()`);
      const off = v.args[0] ? rel(v.args[0]) : null;
      return off ? `(${base} + ${p.add(off)}::interval)` : base;
    }
    if (v.kind !== 'lit') throw badRequest('A date is needed');
    const r = rel(v.v);
    if (r) return `(now() + ${p.add(r)}::interval)`;
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v.v) || Number.isNaN(Date.parse(v.v))) throw badRequest(`"${v.v}" is not a date (use 2026-11-30, -7d, -2w or startOfWeek())`);
    return `${p.add(v.v)}::timestamptz`;
  };
  const rel = (s: string) => {
    const m = /^([-+]?\d{1,4})\s*([hdwmy])$/i.exec(s);
    if (!m) return null;
    const unit = { h: 'hours', d: 'days', w: 'weeks', m: 'months', y: 'years' }[m[2]!.toLowerCase()]!;
    return `${m[1]} ${unit}`;
  };

  const userIdOf = (v: Val): string => {
    if (v.kind === 'fn') {
      if (v.name === 'currentuser' || v.name === 'me') return `${p.add(ctx.userId)}::uuid`;
      throw badRequest(`Unknown function ${v.name}() for a person`);
    }
    if (v.kind !== 'lit') throw badRequest('A person is needed');
    if (/^[0-9a-f-]{36}$/i.test(v.v)) return `${p.add(v.v)}::uuid`;
    if (/^@?me$/i.test(v.v)) return `${p.add(ctx.userId)}::uuid`;
    const x = p.add(v.v.replace(/^@/, '').toLowerCase());
    return `(select u.id from users u where u.tenant_id = t.tenant_id and (lower(u.full_name) = ${x} or lower(u.email) = ${x} or lower(split_part(u.full_name, ' ', 1)) = ${x}) order by (lower(u.full_name) = ${x}) desc limit 1)`;
  };
  const itemIdOf = (v: Val): string => {
    if (v.kind !== 'lit') throw badRequest('A work item key is needed');
    const k = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})$/.exec(v.v);
    if (k)
      return `(select x.id from project_tasks x join projects xp on xp.tenant_id = x.tenant_id and xp.id = x.project_id where x.tenant_id = t.tenant_id and xp.work_key = ${p.add(k[1]!.toUpperCase())} and x.task_number = ${p.add(Number(k[2]))})`;
    if (/^\d{1,7}$/.test(v.v)) return `(select x.id from project_tasks x where x.tenant_id = t.tenant_id and x.project_id = t.project_id and x.task_number = ${p.add(Number(v.v))})`;
    if (/^[0-9a-f-]{36}$/i.test(v.v)) return `${p.add(v.v)}::uuid`;
    return `(select x.id from project_tasks x where x.tenant_id = t.tenant_id and x.project_id = t.project_id and lower(x.name) = ${p.add(v.v.toLowerCase())} limit 1)`;
  };

  /** One comparison: column SQL for "=" against one value. */
  const eqOne = (field: string, v: Val): string => {
    const lit = v.kind === 'lit' ? v.v : null;
    switch (field) {
      case 'project':
        if (!lit) throw badRequest('project = KEY or name');
        return `p.id in (select id from projects where tenant_id = t.tenant_id and (work_key = ${p.add(lit.toUpperCase())} or lower(name) = ${p.add(lit.toLowerCase())} or id::text = ${p.add(lit)}))`;
      case 'key':
        return `t.id = ${itemIdOf(v)}`;
      case 'type': {
        if (!lit) throw badRequest('type = bug');
        const ty = TYPE_ALIAS[lit.toLowerCase()];
        if (!ty) throw badRequest(`Unknown type "${lit}"`);
        return `t.work_type = ${p.add(ty)}`;
      }
      case 'status': {
        if (!lit) throw badRequest('status = done');
        const st = STATUS_ALIAS[lit.toLowerCase()];
        if (!st) throw badRequest(`Unknown status "${lit}" (to do, in progress, review, blocked, done, cancelled)`);
        return `t.status = ${p.add(st)}`;
      }
      case 'state': {
        if (!lit) throw badRequest('state = "Ready for QA"');
        const l = lit.toLowerCase();
        const keys = [...new Set([...(ctx.stateLabels.get(l) ?? []), l.replace(/\s+/g, '_')])];
        const st = STATUS_ALIAS[l];
        return `(t.state = any(${p.add(keys)}::text[])${st ? ` or (t.state is null and t.status = ${p.add(st)})` : ''})`;
      }
      case 'assignee':
        return `${userIdOf(v)} = any(t.assignees)`;
      case 'reporter':
        return `t.reporter_id = ${userIdOf(v)}`;
      case 'watcher':
        return `exists (select 1 from project_task_watchers w where w.tenant_id = t.tenant_id and w.task_id = t.id and w.user_id = ${userIdOf(v)})`;
      case 'priority':
        if (!lit || !PRIORITY.includes(lit.toLowerCase())) throw badRequest(`Priority is one of ${PRIORITY.join(', ')}`);
        return `t.priority = ${p.add(lit.toLowerCase())}`;
      case 'severity':
        return `t.severity = ${p.add((lit ?? '').toLowerCase())}`;
      case 'resolution':
        return `lower(t.resolution) = ${p.add((lit ?? '').toLowerCase())}`;
      case 'sprint': {
        if (v.kind === 'fn') {
          if (v.name === 'opensprints') return `t.sprint_id in (select id from project_sprints where tenant_id = t.tenant_id and status in ('active','planned'))`;
          if (v.name === 'currentsprint' || v.name === 'activesprint' || v.name === 'activesprints') return `t.sprint_id in (select id from project_sprints where tenant_id = t.tenant_id and status = 'active')`;
          if (v.name === 'closedsprints') return `t.sprint_id in (select id from project_sprints where tenant_id = t.tenant_id and status = 'closed')`;
          throw badRequest(`Unknown sprint function ${v.name}()`);
        }
        return `t.sprint_id in (select id from project_sprints where tenant_id = t.tenant_id and (lower(name) = ${p.add(lit!.toLowerCase())} or id::text = ${p.add(lit)}))`;
      }
      case 'release': {
        if (v.kind === 'fn') {
          if (v.name === 'releasedversions') return `t.release_id in (select id from project_releases where tenant_id = t.tenant_id and status = 'released')`;
          if (v.name === 'unreleasedversions') return `t.release_id in (select id from project_releases where tenant_id = t.tenant_id and status in ('planned','in_progress'))`;
          throw badRequest(`Unknown release function ${v.name}()`);
        }
        const x = p.add(lit!.toLowerCase());
        return `t.release_id in (select id from project_releases where tenant_id = t.tenant_id and (lower(name) = ${x} or lower(version) = ${x}))`;
      }
      case 'epic':
        return `t.epic_id = ${itemIdOf(v)}`;
      case 'parent':
        return `t.parent_id = ${itemIdOf(v)}`;
      case 'component':
        return `t.component_ids && array(select id from project_components where tenant_id = t.tenant_id and project_id = t.project_id and lower(name) = ${p.add((lit ?? '').toLowerCase())})`;
      case 'labels':
        return `${p.add((lit ?? '').toLowerCase())} = any(array(select lower(x) from unnest(t.tags) x))`;
      case 'points':
      case 'estimate':
      case 'remaining':
        return `${numCol(field)} = ${num(lit)}`;
      case 'created':
      case 'updated':
      case 'resolved':
      case 'started':
      case 'due':
        return `${dateCol(field)}::date = (${dateExpr(v)})::date`;
      case 'summary':
      case 'text':
      case 'description':
        return `lower(${field === 'description' ? 't.description' : 't.name'}) = ${p.add((lit ?? '').toLowerCase())}`;
      default: {
        const cf = customField(field);
        if (cf) return cf.type === 'number' ? `(t.custom ->> ${p.add(cf.key)})::numeric = ${num(lit)}` : cf.type === 'multiselect' ? `t.custom -> ${p.add(cf.key)} ? ${p.add(lit ?? '')}` : `lower(t.custom ->> ${p.add(cf.key)}) = ${p.add((lit ?? '').toLowerCase())}`;
        throw badRequest(`Unknown field "${field}"`);
      }
    }
  };
  const num = (s: string | null) => {
    if (s === null || !/^[-+]?\d+(\.\d+)?$/.test(s)) throw badRequest(`"${s ?? ''}" is not a number`);
    return `${p.add(Number(s))}::numeric`;
  };
  const numCol = (f: string) => ({ points: 't.story_points', estimate: 't.estimate_hours', remaining: 't.remaining_hours' })[f]!;
  const dateCol = (f: string) => ({ created: 't.created_at', updated: 't.updated_at', resolved: 't.completed_at', started: 't.started_at', due: 't.due_date' })[f]!;
  const customField = (f: string) => {
    const k = f.startsWith('cf.') ? f.slice(3) : f;
    return ctx.customFields.find((c) => c.key === k || c.label.toLowerCase() === k);
  };
  const emptySql = (field: string): string => {
    switch (field) {
      case 'assignee':
        return `cardinality(t.assignees) = 0`;
      case 'labels':
        return `cardinality(t.tags) = 0`;
      case 'component':
        return `cardinality(t.component_ids) = 0`;
      case 'reporter':
        return `t.reporter_id is null`;
      case 'sprint':
        return `t.sprint_id is null`;
      case 'release':
        return `t.release_id is null`;
      case 'epic':
        return `t.epic_id is null`;
      case 'parent':
        return `t.parent_id is null`;
      case 'severity':
        return `t.severity is null`;
      case 'resolution':
        return `t.resolution is null`;
      case 'description':
        return `coalesce(t.description, '') = ''`;
      case 'points':
      case 'estimate':
      case 'remaining':
        return `${numCol(field)} is null`;
      case 'due':
      case 'resolved':
      case 'started':
        return `${dateCol(field)} is null`;
      default: {
        const cf = customField(field);
        if (cf) return `coalesce(t.custom ->> ${p.add(cf.key)}, '') in ('', '[]')`;
        throw badRequest(`"${field}" cannot be empty`);
      }
    }
  };

  const clause = (): string => {
    const f = toks[i];
    if (!f || (f.t !== 'word' && f.t !== 'str')) throw badRequest(`Expected a field${f ? ` at ${f.at + 1}` : ' at the end'}`);
    i++;
    let field = f.v.toLowerCase();
    field = FIELD_ALIAS[field] ?? field;
    // IS [NOT] EMPTY
    if (kw('is')) {
      i++;
      const not = kw('not') ? (i++, true) : false;
      const v = value();
      if (v.kind !== 'empty') throw badRequest('Use IS EMPTY or IS NOT EMPTY');
      const e = emptySql(field);
      return not ? `not (${e})` : `(${e})`;
    }
    // [NOT] IN (...)
    let negIn = false;
    if (kw('not') && toks[i + 1]?.t === 'word' && toks[i + 1]!.v.toLowerCase() === 'in') {
      negIn = true;
      i++;
    }
    if (kw('in')) {
      i++;
      const vals: Val[] = [];
      if (toks[i]?.t === 'lp') {
        i++;
        while (toks[i] && toks[i]!.t !== 'rp') {
          if (toks[i]!.t === 'comma') {
            i++;
            continue;
          }
          vals.push(value());
        }
        expect('rp', '")"');
      } else vals.push(value()); // in openSprints()
      if (!vals.length) throw badRequest('IN needs at least one value');
      const any = vals.map((v) => (v.kind === 'empty' ? emptySql(field) : eqOne(field, v))).join(' or ');
      return negIn ? `not coalesce((${any}), false)` : `(${any})`;
    }
    const op = toks[i];
    if (!op || op.t !== 'op') throw badRequest(`Expected an operator after ${f.v}${op ? ` at ${op.at + 1}` : ''}`);
    i++;
    const v = value();
    if (op.v === '~' || op.v === '!~') {
      if (v.kind !== 'lit') throw badRequest('~ needs some text');
      const like = p.add(`%${v.v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const col = field === 'summary' ? 't.name' : field === 'description' ? `coalesce(t.description, '')` : field === 'text' ? `(t.name || ' ' || coalesce(t.description, ''))` : customField(field) ? `coalesce(t.custom ->> ${p.add(customField(field)!.key)}, '')` : null;
      if (!col) throw badRequest(`~ works on text, summary, description and text custom fields`);
      return op.v === '~' ? `${col} ilike ${like}` : `${col} not ilike ${like}`;
    }
    if (v.kind === 'empty') {
      if (op.v === '=') return `(${emptySql(field)})`;
      if (op.v === '!=') return `not (${emptySql(field)})`;
      throw badRequest('Compare EMPTY with = or !=');
    }
    if (op.v === '=') return `coalesce((${eqOne(field, v)}), false)`;
    if (op.v === '!=') return `not coalesce((${eqOne(field, v)}), false)`;
    // ordering comparisons
    const cmp = op.v;
    if (['points', 'estimate', 'remaining'].includes(field)) return `${numCol(field)} ${cmp} ${num(v.kind === 'lit' ? v.v : null)}`;
    if (['created', 'updated', 'resolved', 'started', 'due'].includes(field)) return `${dateCol(field)} ${cmp} ${dateExpr(v)}`;
    if (field === 'priority') {
      const lit = v.kind === 'lit' ? v.v.toLowerCase() : '';
      if (!PRIORITY.includes(lit)) throw badRequest(`Priority is one of ${PRIORITY.join(', ')}`);
      return `array_position(${p.add(PRIORITY)}::text[], t.priority) ${cmp} ${PRIORITY.indexOf(lit) + 1}`;
    }
    if (field === 'key' && v.kind === 'lit') {
      const n = /(\d+)$/.exec(v.v)?.[1];
      if (!n) throw badRequest('Compare keys like key > FLEET-10');
      return `t.task_number ${cmp} ${p.add(Number(n))}`;
    }
    const cf = customField(field);
    if (cf && cf.type === 'number') return `(t.custom ->> ${p.add(cf.key)})::numeric ${cmp} ${num(v.kind === 'lit' ? v.v : null)}`;
    if (cf && cf.type === 'date') return `(t.custom ->> ${p.add(cf.key)})::date ${cmp} (${dateExpr(v)})::date`;
    throw badRequest(`${f.v} cannot be compared with ${cmp}`);
  };

  const primary = (): string => {
    if (toks[i]?.t === 'lp') {
      i++;
      const e = orExpr();
      expect('rp', '")"');
      return `(${e})`;
    }
    return clause();
  };
  const notExpr = (): string => (kw('not') && !(toks[i + 1]?.t === 'word' && toks[i + 1]!.v.toLowerCase() === 'in') ? (i++, `not (${notExpr()})`) : primary());
  const andExpr = (): string => {
    const parts = [notExpr()];
    while (kw('and')) {
      i++;
      parts.push(notExpr());
    }
    return parts.length > 1 ? `(${parts.join(' and ')})` : parts[0]!;
  };
  const orExpr = (): string => {
    const parts = [andExpr()];
    while (kw('or')) {
      i++;
      parts.push(andExpr());
    }
    return parts.length > 1 ? `(${parts.join(' or ')})` : parts[0]!;
  };

  let where = 'true';
  if (toks.length && !kw('order')) where = orExpr();
  let order = '';
  if (kw('order')) {
    i++;
    if (!kw('by')) throw badRequest('Write ORDER BY');
    i++;
    const parts: string[] = [];
    for (;;) {
      const f = expect('word', 'a field to sort by');
      const name = FIELD_ALIAS[f.v.toLowerCase()] ?? f.v.toLowerCase();
      const col: Record<string, string> = {
        key: 't.task_number', created: 't.created_at', updated: 't.updated_at', priority: `array_position(array['none','low','medium','high','urgent'], t.priority)`, rank: 't.backlog_rank',
        due: 't.due_date', points: 't.story_points', status: `array_position(array['open','in_progress','review','blocked','done','cancelled'], t.status)`, type: 't.work_type',
        summary: 'lower(t.name)', resolved: 't.completed_at', estimate: 't.estimate_hours', remaining: 't.remaining_hours', project: 'p.name',
      };
      if (!col[name]) throw badRequest(`Cannot sort by "${f.v}"`);
      let dir = 'asc';
      if (kw('asc') || kw('desc')) dir = toks[i++]!.v.toLowerCase();
      parts.push(`${col[name]} ${dir} nulls last`);
      if (toks[i]?.t === 'comma') {
        i++;
        continue;
      }
      break;
    }
    order = parts.join(', ');
  }
  if (i < toks.length) throw badRequest(`Unexpected "${toks[i]!.v}" at ${toks[i]!.at + 1}`);
  return { where, order, params: p.vals };
}
