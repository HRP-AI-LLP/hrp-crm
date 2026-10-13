import { type ObjectMeta, type PageLayout, resolveLayout } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, put } from '../../lib/api';
import { useToast } from '../ui';
import { TYPE_LABELS } from './FieldEditor';

type Drag = { key: string; from: number } | null;
const HIDDEN = -1;

const uid = () => `s${Math.random().toString(36).slice(2, 8)}`;

/**
 * Drag-and-drop page layout builder. Fields move between sections (or to the "Not on the page"
 * tray) by dragging; every move also has a keyboard/button equivalent.
 */
export function LayoutBuilder({ obj }: { obj: ObjectMeta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [layout, setLayout] = useState<PageLayout>(() => resolveLayout(obj));
  const [dirty, setDirty] = useState(false);
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLayout(resolveLayout(obj));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.key, JSON.stringify(obj.layout), obj.fields.length]);

  const byKey = new Map(obj.fields.map((f) => [f.key, f]));
  const update = (fn: (l: PageLayout) => PageLayout) => {
    setLayout((l) => fn(structuredClone(l)));
    setDirty(true);
  };

  /** move a field to section `to` (HIDDEN = tray) before `beforeKey` (or at the end) */
  const move = (key: string, to: number, beforeKey?: string) =>
    update((l) => {
      l.sections.forEach((s) => (s.fields = s.fields.filter((k) => k !== key)));
      l.hidden = l.hidden.filter((k) => k !== key);
      const list = to === HIDDEN ? l.hidden : l.sections[to]!.fields;
      const at = beforeKey ? list.indexOf(beforeKey) : -1;
      if (at >= 0) list.splice(at, 0, key);
      else list.push(key);
      return l;
    });

  const nudge = (si: number, key: string, d: -1 | 1) =>
    update((l) => {
      const f = l.sections[si]!.fields;
      const i = f.indexOf(key);
      const j = i + d;
      if (j >= 0 && j < f.length) [f[i], f[j]] = [f[j]!, f[i]!];
      else if (j < 0 && si > 0) {
        f.splice(i, 1);
        l.sections[si - 1]!.fields.push(key);
      } else if (j >= f.length && si < l.sections.length - 1) {
        f.splice(i, 1);
        l.sections[si + 1]!.fields.unshift(key);
      }
      return l;
    });

  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/admin/objects/${obj.key}/layout`, layout);
      toast('Page layout saved');
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save the layout', true);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!window.confirm('Go back to the default layout (one section with every field)?')) return;
    await put(`/api/admin/objects/${obj.key}/layout`, { reset: true }).catch((e) => toast((e as Error).message, true));
    qc.invalidateQueries({ queryKey: ['meta'] });
  };

  const dropProps = (target: number, beforeKey?: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(`${target}:${beforeKey ?? ''}`);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (drag && drag.key !== beforeKey) move(drag.key, target, beforeKey);
      setDrag(null);
      setOver(null);
    },
  });

  const chip = (key: string, si: number) => {
    const f = byKey.get(key);
    if (!f) return null;
    const locked = si !== HIDDEN && f.required && !f.readOnly;
    return (
      <div
        key={key}
        className={`lb-chip${drag?.key === key ? ' dragging' : ''}${over === `${si}:${key}` ? ' drop-before' : ''}`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', key);
          setDrag({ key, from: si });
        }}
        onDragEnd={() => {
          setDrag(null);
          setOver(null);
        }}
        {...dropProps(si, key)}
      >
        <span className="grip" aria-hidden="true">
          ⋮⋮
        </span>
        <span className="lb-label">
          {f.label}
          {f.required && <span className="req"> *</span>}
          <span className="muted small"> · {TYPE_LABELS[f.type]}</span>
        </span>
        <span className="lb-actions">
          {si === HIDDEN ? (
            <button className="btn ghost sm" onClick={() => move(key, layout.sections.length - 1)} aria-label={`Add ${f.label} to the page`}>
              Add
            </button>
          ) : (
            <>
              <button className="btn ghost sm" onClick={() => nudge(si, key, -1)} aria-label={`Move ${f.label} up`}>
                ↑
              </button>
              <button className="btn ghost sm" onClick={() => nudge(si, key, 1)} aria-label={`Move ${f.label} down`}>
                ↓
              </button>
              <button className="btn ghost sm" disabled={locked} title={locked ? 'Required fields stay on the page' : undefined} onClick={() => move(key, HIDDEN)} aria-label={`Remove ${f.label} from the page`}>
                ✕
              </button>
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="lb">
      <div className="spread" style={{ marginBottom: 12 }}>
        <p className="muted small" style={{ margin: 0 }}>
          Drag fields to arrange the {obj.label.toLowerCase()} page and the “New {obj.label.toLowerCase()}” form. Sections can have one or two columns and start collapsed.
        </p>
        <div className="row">
          <button className="btn" onClick={reset} disabled={!obj.layout}>
            Reset to default
          </button>
          <button className="btn primary" onClick={save} disabled={!dirty || busy}>
            {busy ? 'Saving…' : dirty ? 'Save layout' : 'Saved'}
          </button>
        </div>
      </div>
      <div className="lb-grid">
        <div className="lb-canvas">
          {layout.sections.map((s, si) => (
            <section key={s.id} className={`lb-section${over === `${si}:` ? ' drop' : ''}`} {...dropProps(si)}>
              <header>
                <input
                  aria-label="Section title"
                  value={s.title}
                  placeholder="Section title"
                  onChange={(e) => update((l) => ((l.sections[si]!.title = e.target.value), l))}
                />
                <div className="seg" role="group" aria-label="Columns">
                  {([1, 2] as const).map((n) => (
                    <button key={n} aria-pressed={s.columns === n} onClick={() => update((l) => ((l.sections[si]!.columns = n), l))}>
                      {n} col
                    </button>
                  ))}
                </div>
                <label className="row small" title="Start collapsed on the record page">
                  <input type="checkbox" checked={!!s.collapsed} onChange={(e) => update((l) => ((l.sections[si]!.collapsed = e.target.checked), l))} /> Collapsed
                </label>
                <button className="btn ghost sm" aria-label="Move section up" disabled={si === 0} onClick={() => update((l) => (([l.sections[si - 1], l.sections[si]] = [l.sections[si]!, l.sections[si - 1]!]), l))}>
                  ↑
                </button>
                <button className="btn ghost sm" aria-label="Move section down" disabled={si === layout.sections.length - 1} onClick={() => update((l) => (([l.sections[si + 1], l.sections[si]] = [l.sections[si]!, l.sections[si + 1]!]), l))}>
                  ↓
                </button>
                <button
                  className="btn ghost sm"
                  aria-label="Delete section"
                  disabled={layout.sections.length === 1}
                  onClick={() =>
                    update((l) => {
                      const [gone] = l.sections.splice(si, 1);
                      // fields of a deleted section move to the previous one (required fields must stay visible)
                      l.sections[Math.max(0, si - 1)]!.fields.push(...gone!.fields);
                      return l;
                    })
                  }
                >
                  Delete
                </button>
              </header>
              <div className={`lb-fields cols-${s.columns}`}>
                {s.fields.map((k) => chip(k, si))}
                {!s.fields.length && <div className="lb-empty">Drop fields here</div>}
              </div>
            </section>
          ))}
          <button className="btn" onClick={() => update((l) => (l.sections.push({ id: uid(), title: 'New section', columns: 2, fields: [] }), l))}>
            Add section
          </button>
        </div>
        <aside className={`lb-tray${over === `${HIDDEN}:` ? ' drop' : ''}`} {...dropProps(HIDDEN)}>
          <h3>Not on the page</h3>
          <p className="muted small">Fields here are kept but not shown. New fields appear at the end of the last section.</p>
          {layout.hidden.map((k) => chip(k, HIDDEN))}
          {!layout.hidden.length && <div className="lb-empty">Drag a field here to hide it</div>}
        </aside>
      </div>
    </div>
  );
}
