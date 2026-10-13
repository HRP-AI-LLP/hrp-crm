import type { FieldDef, ObjectMeta, RecordDto } from '@synapse/shared';
import { valueType } from '@synapse/shared';
import { Link } from 'react-router-dom';
import { money, moneyShort, number } from '../lib/format';
import { BarChart, type ChartData, DonutChart, FunnelChart, HBarChart, LineChart, NumberTile } from './charts';
import { FieldValue } from './fields';
import { Empty } from './ui';

export interface ReportDefinition {
  type: 'table' | 'summary' | 'chart';
  filters: { field: string; op: string; value?: unknown }[];
  columns: string[];
  sort?: { field: string; dir: 'asc' | 'desc' } | null;
  groupBy?: string | null;
  groupBy2?: string | null;
  dateBucket?: 'day' | 'week' | 'month' | 'quarter' | 'year' | null;
  measure: { agg: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | null };
  chart?: 'bar' | 'hbar' | 'line' | 'pie' | 'funnel' | 'number' | null;
  limit: number;
}

export type ReportResult =
  | { kind: 'table'; items: RecordDto[]; total?: number }
  | { kind: 'aggregate'; rows: { g1: string | null; g2: string | null; value: number | null; n: number }[]; labels: Record<string, Record<string, string>> };

const SYSTEM: Record<string, FieldDef> = {
  created_at: { key: 'created_at', label: 'Created', type: 'datetime', standard: true },
  updated_at: { key: 'updated_at', label: 'Last updated', type: 'datetime', standard: true },
};

export function fieldOf(obj: ObjectMeta, key?: string | null): FieldDef | undefined {
  if (!key) return undefined;
  return obj.fields.find((f) => f.key === key) ?? SYSTEM[key];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function bucketLabel(v: string, bucket: ReportDefinition['dateBucket']) {
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  switch (bucket ?? 'month') {
    case 'year':
      return String(y);
    case 'quarter':
      return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case 'month':
      return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
    default:
      return `${d} ${MONTHS[m - 1]}`;
  }
}

export function measureLabel(obj: ObjectMeta, d: ReportDefinition) {
  if (d.measure.agg === 'count') return `Number of ${obj.plural.toLowerCase()}`;
  const f = fieldOf(obj, d.measure.field);
  const word = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest' }[d.measure.agg];
  return `${word} ${f?.label.toLowerCase() ?? ''}`;
}

export function measureFormat(obj: ObjectMeta, d: ReportDefinition, short = true) {
  const f = fieldOf(obj, d.measure.field);
  if (d.measure.agg !== 'count' && f && valueType(f) === 'currency') return short ? moneyShort : (n: number) => money(n);
  if (d.measure.agg !== 'count' && f && valueType(f) === 'percent') return (n: number) => `${Math.round(n * 10) / 10}%`;
  return (n: number) => (short && Math.abs(n) >= 1e5 ? moneyShort(n).replace('₹', '') : number(Math.round(n * 100) / 100));
}

/** Turns aggregate rows into categories × series for the charts. */
export function toChartData(obj: ObjectMeta, d: ReportDefinition, r: Extract<ReportResult, { kind: 'aggregate' }>): ChartData {
  const f1 = fieldOf(obj, d.groupBy);
  const isDate = !!f1 && ['date', 'datetime'].includes(valueType(f1));
  const label = (col: 'g1' | 'g2', v: string | null) => {
    if (v === null || v === '') return '(none)';
    if (col === 'g1' && isDate) return bucketLabel(v, d.dateBucket);
    const f2 = fieldOf(obj, d.groupBy2);
    if (col === 'g2' && f2 && ['date', 'datetime'].includes(valueType(f2))) return bucketLabel(v, d.dateBucket);
    return r.labels[col]?.[v] ?? v;
  };
  const keys1 = [...new Set(r.rows.map((x) => x.g1))];
  const keys2 = d.groupBy2 ? [...new Set(r.rows.map((x) => x.g2))] : [null];
  const series = keys2.map((k2) => ({
    label: d.groupBy2 ? label('g2', k2) : measureLabel(obj, d),
    values: keys1.map((k1) => r.rows.filter((x) => x.g1 === k1 && (!d.groupBy2 || x.g2 === k2)).reduce((a, x) => a + (x.value ?? 0), 0)),
  }));
  return { categories: keys1.map((k) => label('g1', k)), series };
}

export function ReportView({ obj, def, result, stageOrder, compact }: { obj: ObjectMeta; def: ReportDefinition; result: ReportResult; stageOrder?: string[]; compact?: boolean }) {
  if (result.kind === 'table') {
    if (!result.items.length) return <Empty title="No records match" />;
    const cols = (def.columns.length ? def.columns : obj.fields.slice(0, 5).map((f) => f.key)).map((k) => fieldOf(obj, k)).filter((f): f is FieldDef => !!f);
    return (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              {cols.map((c) => (
                <th key={c.key} className={['number', 'currency', 'percent'].includes(valueType(c)) ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/o/${obj.key}/${r.id}`}>{r.title || 'Untitled'}</Link>
                </td>
                {cols.map((c) => (
                  <td key={c.key} className={['number', 'currency', 'percent'].includes(valueType(c)) ? 'num' : undefined}>
                    <FieldValue field={c} record={r} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.total !== undefined && result.total > result.items.length && (
          <p className="muted small" style={{ padding: '6px 12px' }}>
            Showing {result.items.length} of {result.total.toLocaleString('en-IN')}
          </p>
        )}
      </div>
    );
  }

  if (!result.rows.length) return <Empty title="No records match" />;
  const data = toChartData(obj, def, result);
  if (stageOrder && def.groupBy === 'stage_id') {
    const ids = [...new Set(result.rows.map((x) => x.g1))];
    const idx = ids.map((id, i) => ({ id, i, o: stageOrder.indexOf(id ?? '') }));
    idx.sort((a, b) => (a.o < 0 ? 999 : a.o) - (b.o < 0 ? 999 : b.o));
    data.categories = idx.map((x) => data.categories[x.i]!);
    data.series = data.series.map((s) => ({ ...s, values: idx.map((x) => s.values[x.i]!) }));
  }
  const fmt = measureFormat(obj, def);
  const fullFmt = measureFormat(obj, def, false);
  const total = data.series.reduce((a, s) => a + s.values.reduce((b, v) => b + v, 0), 0);

  if (def.type === 'chart') {
    switch (def.chart ?? 'bar') {
      case 'number':
        return <NumberTile value={def.measure.agg === 'avg' ? total / Math.max(1, data.categories.length) : total} label={measureLabel(obj, def)} fmt={fullFmt} />;
      case 'hbar':
        return <HBarChart data={data} fmt={fmt} />;
      case 'line':
        return <LineChart data={data} fmt={fmt} height={compact ? 200 : 260} />;
      case 'pie':
        return <DonutChart data={data} fmt={fmt} />;
      case 'funnel':
        return <FunnelChart data={data} fmt={fmt} />;
      default:
        return <BarChart data={data} fmt={fmt} height={compact ? 200 : 260} />;
    }
  }

  // summary table (pivot when there are two groupings)
  const f1 = fieldOf(obj, def.groupBy);
  return (
    <div className="table-wrap">
      <table className="data summary">
        <thead>
          <tr>
            <th>{f1?.label ?? ''}</th>
            {def.groupBy2 ? data.series.map((s) => <th key={s.label} className="num">{s.label}</th>) : <th className="num">{measureLabel(obj, def)}</th>}
            {(def.groupBy2 || !def.groupBy) && <th className="num">Total</th>}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((c, i) => (
            <tr key={c + i}>
              <td>{def.groupBy ? c : 'All records'}</td>
              {data.series.map((s) => (
                <td key={s.label} className="num">
                  {fullFmt(s.values[i] ?? 0)}
                </td>
              ))}
              {(def.groupBy2 || !def.groupBy) && <td className="num"><b>{fullFmt(data.series.reduce((a, s) => a + (s.values[i] ?? 0), 0))}</b></td>}
            </tr>
          ))}
        </tbody>
        {def.groupBy && (
          <tfoot>
            <tr>
              <td>
                <b>Total</b>
              </td>
              {data.series.map((s) => (
                <td key={s.label} className="num">
                  <b>{def.measure.agg === 'sum' || def.measure.agg === 'count' ? fullFmt(s.values.reduce((a, v) => a + v, 0)) : ''}</b>
                </td>
              ))}
              {def.groupBy2 && <td className="num"><b>{def.measure.agg === 'sum' || def.measure.agg === 'count' ? fullFmt(total) : ''}</b></td>}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
