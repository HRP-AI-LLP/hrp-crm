import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

// ------------------------------------------------------------------ toasts
interface Toast {
  id: number;
  text: string;
  err?: boolean;
}
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.err ? ' err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ------------------------------------------------------------------ modal
export function Modal({ title, onClose, children, footer, wide, xl }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; xl?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // the latest onClose, so the effect below runs once per opening: callers pass a new function on
  // every render, and re-running it on each keystroke moved the focus away from the field being typed in
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    // first field the dialog asked for, else its first field, else its first button (not the ✕)
    if (root && !root.contains(document.activeElement)) {
      const first =
        root.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ??
        root.querySelector<HTMLElement>('.modal-body input:not([type=hidden]):not([disabled]),.modal-body select,.modal-body textarea') ??
        root.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea') ??
        root.querySelector<HTMLElement>('.modal-foot button, button');
      first?.focus();
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={xl ? { width: 'min(1280px, 96vw)', maxHeight: '96vh' } : wide ? { width: 'min(860px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-x" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        </div>
        <div className="modal-scroll">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the synapse score ring
export function ScoreRing({ value, size = 'sm' }: { value: number | null | undefined; size?: 'sm' | 'lg' }) {
  const px = size === 'lg' ? 76 : 30;
  const stroke = size === 'lg' ? 7 : 3.5;
  const r = (px - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, value));
  const color = v === null ? '#cbd5e1' : v >= 70 ? '#06a6c7' : v >= 40 ? '#0f8dde' : '#94a3b8';
  return (
    <span className={`score ${size}`} title={v === null ? 'Not scored yet' : `AI score ${v}`}>
      <svg width={px} height={px} aria-hidden="true">
        <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke="#eef1f4" strokeWidth={stroke} />
        {v !== null && <circle cx={px / 2} cy={px / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(v / 100) * c} ${c}`} />}
      </svg>
      <b>{v ?? '–'}</b>
    </span>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function StageChip({ stage }: { stage?: { label: string; color: string | null; category: string } | undefined }) {
  if (!stage) return <span className="muted">—</span>;
  return (
    <span className={`chip${stage.category === 'won' ? ' good' : stage.category === 'lost' ? ' bad' : ''}`}>
      <span className="dot" style={{ background: stage.color ?? '#7b8796' }} />
      {stage.label}
    </span>
  );
}

export const Icon = {
  search: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  menu: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

/**
 * A KPI / stat tile. The standard, system-wide stat card: label, big value, optional sub-line and
 * tone. Pass `to` (a route) or `onClick` (e.g. switch a tab) to make it a clickable card that
 * navigates to the screen behind the number — it then gets a pointer, hover lift and keyboard focus.
 * Prefer this over a hand-rolled `.panel.kpi` so every stat card behaves the same everywhere.
 */
export function Kpi({
  l,
  v,
  sub,
  tone,
  to,
  onClick,
  title,
}: {
  l: ReactNode;
  v: ReactNode;
  sub?: ReactNode;
  tone?: 'good' | 'bad' | 'warn';
  to?: string;
  onClick?: () => void;
  title?: string;
}) {
  const interactive = !!(to || onClick);
  const cls = `panel kpi${interactive ? ' kpi-link' : ''}`;
  const inner = (
    <>
      <div className="l">{l}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`}>{v}</div>
      {sub && <div className="small muted">{sub}</div>}
    </>
  );
  if (to) return <Link className={cls} to={to} title={title ?? `Open ${typeof l === 'string' ? l : 'details'}`}>{inner}</Link>;
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} title={title ?? `Open ${typeof l === 'string' ? l : 'details'}`}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

export function Spinner() {
  return <span className="muted">Loading…</span>;
}
