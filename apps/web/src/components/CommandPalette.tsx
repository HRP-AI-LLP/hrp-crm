/**
 * Ctrl+K / ⌘K: go anywhere, create anything, find any record. Arrow keys move, Enter opens, Esc closes.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { NI, OBJECT_ICON } from './NavIcons';

export interface Command {
  id: string;
  label: string;
  group: 'Go to' | 'Create' | 'Records' | 'Actions';
  icon?: string;
  to?: string;
  run?: () => void;
  hint?: string;
  keywords?: string;
}

export function useCommandPaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      } else if (e.key === '/' && !(e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

const score = (c: Command, q: string) => {
  if (!q) return 1;
  const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => hay.includes(w))) return 0;
  return hay.startsWith(words[0]!) ? 3 : c.label.toLowerCase().includes(q.toLowerCase()) ? 2 : 1;
};

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => get<{ results: { object: string; label: string; items: { id: string; title: string }[] }[] }>(`/api/v1/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  });
  const items = useMemo(() => {
    const local = commands
      .map((c) => ({ c, s: score(c, q.trim()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, q.trim() ? 12 : 40);
    const recs: Command[] = (found.data?.results ?? []).flatMap((g) =>
      g.items.slice(0, 5).map((i) => ({ id: `${g.object}:${i.id}`, label: i.title || 'Untitled', group: 'Records' as const, icon: OBJECT_ICON[g.object] ?? 'file', to: `/o/${g.object}/${i.id}`, hint: g.label })),
    );
    // records first when the search found some, then pages and actions
    return q.trim().length >= 2 ? [...recs, ...local] : local;
  }, [commands, q, found.data]);
  useEffect(() => setSel(0), [q, found.data]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    if (c.run) c.run();
    else if (c.to) nav(c.to);
  };
  let lastGroup = '';
  return (
    <div className="cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <div className="cmdk-input">
          <NI name="search" />
          <input
            autoFocus
            placeholder="Search records, pages and actions…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(items.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                go(items[sel]);
              } else if (e.key === 'Escape') onClose();
            }}
            aria-label="Search"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={list} role="listbox">
          {!items.length && <div className="cmdk-group">{found.isFetching ? 'Searching…' : 'Nothing matches'}</div>}
          {items.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="cmdk-group">{head}</div>}
                <div className="cmdk-item" data-i={i} role="option" aria-selected={i === sel} onMouseMove={() => setSel(i)} onClick={() => go(c)}>
                  <NI name={c.icon ?? 'arrow'} />
                  <span>{c.label}</span>
                  {c.hint && <span className="sub">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
