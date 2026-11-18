/**
 * A section menu down the left of the content (in place of a row of tabs) for screens with more than
 * five sections. Groups are optional; the menu folds to icons with its ☰ button (remembered per screen)
 * and stacks above the content on a phone.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { NI } from './NavIcons';

export interface SideItem<K extends string> {
  key: K;
  label: string;
  icon?: string;
  group?: string;
  badge?: number | string | null;
}

export function SideTabs<K extends string>({ id, title, items, value, onChange, children, panel = true, defaultOpen = true }: { id: string; title: string; items: SideItem<K>[]; value: K; onChange: (k: K) => void; children: ReactNode; panel?: boolean; defaultOpen?: boolean }) {
  const key = `synapse.side.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v ? v !== 'closed' : defaultOpen;
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? 'closed' : 'open');
    } catch {
      /* ignore */
    }
  };
  const groups: { label: string; items: SideItem<K>[] }[] = [];
  for (const it of items) {
    const g = it.group ?? '';
    const cur = groups.find((x) => x.label === g);
    if (cur) cur.items.push(it);
    else groups.push({ label: g, items: [it] });
  }
  const current = items.find((i) => i.key === value);
  // five sections or fewer stay as tabs across the top
  if (items.length <= 5) {
    const bar = (
      <div className="tabs" role="tablist" style={panel ? undefined : { padding: 0 }}>
        {items.map((it) => (
          <button key={it.key} role="tab" aria-selected={value === it.key} onClick={() => onChange(it.key)}>
            {it.label}
            {it.badge ? ` (${it.badge})` : ''}
          </button>
        ))}
      </div>
    );
    return panel ? (
      <section className="panel">
        {bar}
        {children}
      </section>
    ) : (
      <>
        {bar}
        {children}
      </>
    );
  }
  return (
    <div className={`side-layout${open ? '' : ' collapsed'}`}>
      <nav className="side-menu panel" aria-label={title}>
        <button className="side-toggle" onClick={toggle} aria-expanded={open} title={open ? 'Collapse the menu' : 'Show the menu'}>
          <NI name="menu" size={18} className="" />
          {open ? <span>{title}</span> : <span className="side-current">{current?.label}</span>}
        </button>
        {groups.map((g) => (
          <div key={g.label || '_'} className="side-group">
            {open && g.label && <div className="side-group-label">{g.label}</div>}
            {g.items.map((it) => (
              <button key={it.key} className={`side-item${value === it.key ? ' on' : ''}`} onClick={() => onChange(it.key)} title={it.label} aria-current={value === it.key ? 'page' : undefined}>
                <NI name={it.icon ?? 'dot'} size={17} className="" />
                {open && <span className="side-label">{it.label}</span>}
                {open && it.badge ? <span className="side-badge">{it.badge}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {panel ? <section className="panel side-content">{children}</section> : <div className="side-content">{children}</div>}
    </div>
  );
}
