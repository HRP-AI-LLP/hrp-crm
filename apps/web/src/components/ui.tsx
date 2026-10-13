import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

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
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={wide ? { width: 'min(860px, 100%)' } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
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
  const color = v === null ? '#c7d0d8' : v >= 70 ? '#e8a317' : v >= 40 ? '#2d8197' : '#9aa6b2';
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

export function Spinner() {
  return <span className="muted">Loading…</span>;
}
