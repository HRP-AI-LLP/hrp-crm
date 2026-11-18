/** Small shared pieces for the industry screens: actions with toasts, period picker, KPI tiles, tables. */
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useToast } from '../ui';

export type Json = Record<string, any>;

export const inr = (v: unknown) => `₹${Math.round(Number(v ?? 0)).toLocaleString('en-IN')}`;
export const inrShort = (v: unknown) => {
  const n = Number(v ?? 0);
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)} L`;
  if (a >= 1e3) return `₹${(n / 1e3).toFixed(0)}k`;
  return `₹${Math.round(n)}`;
};
export const pct = (v: unknown) => (v == null ? '—' : `${Number(v).toFixed(1).replace(/\.0$/, '')}%`);
export const d = (v: unknown) => (v ? new Date(String(v).length === 10 ? `${v}T00:00:00` : String(v)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
export const fyStart = () => {
  const t = today();
  const y = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
  return `${y}-04-01`;
};
export const label = (s: unknown) => String(s ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Runs an API call, toasts the result and refreshes the given queries. */
export function useAct(keys: unknown[][] = []) {
  const toast = useToast();
  const qc = useQueryClient();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

export function usePeriod(init?: { from?: string; to?: string }) {
  const [p, setP] = useState({ from: init?.from ?? fyStart(), to: init?.to ?? today() });
  const qs = `from=${p.from}&to=${p.to}`;
  const picker = (
    <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        aria-label="Period"
        style={{ width: 'auto' }}
        value=""
        onChange={(e) => {
          const t = today();
          const v = e.target.value;
          const back = (days: number) => new Date(Date.parse(`${t}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
          if (v === 'fy') setP({ from: fyStart(), to: t });
          if (v === 'm') setP({ from: `${t.slice(0, 8)}01`, to: t });
          if (v === '90') setP({ from: back(90), to: t });
          if (v === '365') setP({ from: back(365), to: t });
          if (v === 'lfy') {
            const s = Number(fyStart().slice(0, 4)) - 1;
            setP({ from: `${s}-04-01`, to: `${s + 1}-03-31` });
          }
        }}
      >
        <option value="">Quick range…</option>
        <option value="m">This month</option>
        <option value="90">Last 90 days</option>
        <option value="fy">This financial year</option>
        <option value="lfy">Last financial year</option>
        <option value="365">Last 12 months</option>
      </select>
      <input type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} aria-label="From" style={{ width: 'auto' }} />
      <span className="muted small">to</span>
      <input type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} aria-label="To" style={{ width: 'auto' }} />
    </div>
  );
  return { ...p, qs, picker };
}

export function Kpis({ items }: { items: { l: string; v: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' | 'warn' }[] }) {
  return (
    <div className="kpis" style={{ margin: '0 0 14px' }}>
      {items.map((k) => (
        <div key={k.l} className="panel kpi">
          <div className="l">{k.l}</div>
          <div className={`v${k.tone ? ` ${k.tone}-text` : ''}`}>{k.v}</div>
          {k.sub ? <div className="small muted">{k.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function Head({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="spread" style={{ marginBottom: 12, gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>
        {sub ? <p className="muted small" style={{ margin: '2px 0 0' }}>{sub}</p> : null}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

export function NoRows({ children }: { children: ReactNode }) {
  return <p className="muted small" style={{ padding: '18px 4px', textAlign: 'center' }}>{children}</p>;
}
