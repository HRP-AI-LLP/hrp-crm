/**
 * Showing, editing and exporting what the agents make:
 *  · DiagramView — the picture (Mermaid), its Mermaid source, draw.io XML and spec; downloads SVG,
 *    PNG, JPG, .drawio, .mmd; opens in diagrams.net to edit.
 *  · DocumentView — the document with its figures drawn; edit the markdown; download Word, PDF,
 *    HTML, Markdown.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { get, put } from '../../lib/api';
import { drawioFromSvg, drawioLink, fileName, rasterize, renderMermaid, saveBlob, saveText, standaloneSvg } from '../../lib/diagrams';
import { printPdf, toDocx, toStandaloneHtml, toViewHtml } from '../../lib/docexport';
import { relative } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

/** Draws Mermaid source; shows Mermaid's own message when it can't. */
export function MermaidPicture({ src, onSvg, maxHeight }: { src: string; onSvg?: (svg: string | null) => void; maxHeight?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    renderMermaid(src).then(
      (s) => {
        if (!live) return;
        setSvg(s);
        onSvg?.(s);
      },
      (e: Error) => {
        if (!live) return;
        setSvg(null);
        setErr(e.message?.split('\n').slice(0, 4).join('\n') || 'This diagram could not be drawn');
        onSvg?.(null);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  if (err) return <pre className="dg-error">{err}</pre>;
  if (!svg) return <Spinner />;
  return <div className="dg-picture" style={maxHeight ? { maxHeight } : undefined} dangerouslySetInnerHTML={{ __html: svg }} />;
}

type DTab = 'picture' | 'mermaid' | 'drawio' | 'spec';

export function DiagramView({ artifact, canEdit, onSaved }: { artifact: Json; canEdit: boolean; onSaved?: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<DTab>('picture');
  const [svg, setSvg] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const title = artifact.title as string;
  const src = (artifact.body as string) ?? '';
  const structured = !!artifact.spec && artifact.spec.type !== 'mermaid' && !('mermaid' in (artifact.spec as Json));
  const drawio = (artifact.drawio as string | null) || (svg ? drawioFromSvg(title, svg) : null);
  const savedPicture = useRef(false);
  // Mermaid-only kinds: the picture becomes the draw.io file, kept for agents and downloads
  useEffect(() => {
    if (!artifact.drawio && svg && canEdit && artifact.id && !savedPicture.current) {
      savedPicture.current = true;
      put(`/api/v1/sdlc/artifacts/${artifact.id}/drawio`, { xml: drawioFromSvg(title, svg) }).catch(() => undefined);
    }
  }, [svg, artifact.drawio, artifact.id, canEdit, title]);

  const download = async (kind: 'svg' | 'png' | 'jpg' | 'drawio' | 'mmd') => {
    try {
      const name = fileName(title);
      if (kind === 'mmd') return saveText(src, `${name}.mmd`);
      if (kind === 'drawio') return drawio ? saveText(drawio, `${name}.drawio`, 'application/xml') : toast('Wait for the picture', true);
      if (!svg) return toast('The picture is not drawn yet', true);
      if (kind === 'svg') return saveText(standaloneSvg(svg).svg, `${name}.svg`, 'image/svg+xml');
      const { blob } = await rasterize(svg, kind === 'png' ? 'png' : 'jpeg', 2);
      saveBlob(blob, `${name}.${kind}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const copyImage = async () => {
    if (!svg) return;
    try {
      const { blob } = await rasterize(svg, 'png', 2);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Picture copied');
    } catch {
      toast('Your browser did not allow copying the picture', true);
    }
  };
  const save = async () => {
    if (edit === null) return;
    setBusy(true);
    try {
      if (tab === 'spec') await put(`/api/v1/sdlc/artifacts/${artifact.id}`, { spec: JSON.parse(edit), note: 'Spec edited' });
      else await put(`/api/v1/sdlc/artifacts/${artifact.id}`, { mermaid: edit, note: 'Mermaid edited' });
      setEdit(null);
      savedPicture.current = false;
      toast('Saved as a new version');
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const tabs: [DTab, string][] = [['picture', 'Picture'], ['mermaid', 'Mermaid'], ['drawio', 'draw.io'], ...(structured ? ([['spec', 'Spec']] as [DTab, string][]) : [])];
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' }}>
        <div className="seg" role="tablist">
          {tabs.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => (setTab(k), setEdit(null))}>
              {l}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn sm" onClick={() => download('png')}>PNG</button>
          <button type="button" className="btn sm" onClick={() => download('jpg')}>JPG</button>
          <button type="button" className="btn sm" onClick={() => download('svg')}>SVG</button>
          <button type="button" className="btn sm" onClick={() => download('drawio')}>.drawio</button>
          <button type="button" className="btn sm" onClick={() => download('mmd')}>.mmd</button>
          <button type="button" className="btn sm ghost" onClick={copyImage} title="Copy the picture to paste into a document or chat">Copy</button>
          {drawio && (
            <a className="btn sm primary" href={drawioLink(drawio)} target="_blank" rel="noreferrer" title="Opens in diagrams.net — edit, then File → Save as">
              Open in draw.io
            </a>
          )}
        </div>
      </div>
      {tab === 'picture' && <MermaidPicture src={src} onSvg={setSvg} />}
      {tab !== 'picture' && svg === null && <div style={{ display: 'none' }}><MermaidPicture src={src} onSvg={setSvg} /></div>}
      {tab === 'mermaid' &&
        (edit !== null ? (
          <div className="stack">
            <textarea className="dg-code" value={edit} onChange={(e) => setEdit(e.target.value)} rows={18} spellCheck={false} />
            <MermaidPicture src={edit} maxHeight={360} />
          </div>
        ) : (
          <pre className="dg-code">{src}</pre>
        ))}
      {tab === 'drawio' && (
        <div className="stack">
          <p className="small muted">
            {artifact.drawio ? 'Editable shapes, laid out automatically.' : 'This kind of diagram has no editable shapes in draw.io: the file holds the picture.'} Open it in draw.io (web or desktop), or import the .drawio file in Confluence, Visio or Lucidchart.
          </p>
          <pre className="dg-code">{drawio ?? '…'}</pre>
        </div>
      )}
      {tab === 'spec' &&
        (edit !== null ? <textarea className="dg-code" value={edit} onChange={(e) => setEdit(e.target.value)} rows={22} spellCheck={false} /> : <pre className="dg-code">{JSON.stringify(artifact.spec, null, 2)}</pre>)}
      {canEdit && (tab === 'mermaid' || tab === 'spec') && (
        <div className="row" style={{ gap: 6 }}>
          {edit === null ? (
            <button type="button" className="btn sm" onClick={() => setEdit(tab === 'spec' ? JSON.stringify(artifact.spec, null, 2) : src)}>
              Edit {tab === 'spec' ? 'spec' : 'Mermaid'}
            </button>
          ) : (
            <>
              <button type="button" className="btn sm primary" disabled={busy} onClick={save}>Save</button>
              <button type="button" className="btn sm ghost" onClick={() => setEdit(null)}>Cancel</button>
              {tab === 'mermaid' && structured && <span className="small muted">Saving Mermaid by hand keeps the picture; draw.io then holds the picture instead of shapes.</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A document with its figures drawn (click a figure to open it). */
export function DocumentBody({ md, onFigure }: { md: string; onFigure?: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = toViewHtml(md);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    el.querySelectorAll<HTMLElement>('.mmd-fig').forEach((fig) => {
      const src = decodeURIComponent(fig.dataset.src ?? '');
      fig.innerHTML = '<div class="muted small">Drawing…</div>';
      renderMermaid(src).then(
        (svg) => {
          if (live) fig.innerHTML = svg;
        },
        () => {
          if (live) fig.innerHTML = '<div class="muted small">This figure could not be drawn</div>';
        },
      );
      if (fig.dataset.id && onFigure) {
        fig.classList.add('clickable');
        fig.title = 'Open the diagram (draw.io, PNG, JPG…)';
        fig.onclick = () => onFigure(fig.dataset.id!);
      }
    });
    return () => {
      live = false;
    };
  }, [html, onFigure]);
  return <div ref={ref} className="doc-view" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function DocumentView({ artifact, canEdit, onSaved }: { artifact: Json; canEdit: boolean; onSaved?: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [figure, setFigure] = useState<string | null>(null);
  const md = (artifact.body as string) ?? '';
  const title = artifact.title as string;
  const exp = async (kind: 'docx' | 'pdf' | 'html' | 'md') => {
    setBusy(kind);
    try {
      const name = fileName(title);
      if (kind === 'md') saveText(md, `${name}.md`, 'text/markdown');
      if (kind === 'html') saveText(await toStandaloneHtml(title, md), `${name}.html`, 'text/html');
      if (kind === 'docx') saveBlob(await toDocx(title, md), `${name}.docx`);
      if (kind === 'pdf') await printPdf(title, md);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      await put(`/api/v1/sdlc/artifacts/${artifact.id}`, { body: edit, note: 'Edited' });
      setEdit(null);
      toast('Saved as a new version');
      onSaved?.();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 6 }}>
          {canEdit && edit === null && (
            <button type="button" className="btn sm" onClick={() => setEdit(md)}>
              Edit
            </button>
          )}
          {edit !== null && (
            <>
              <button type="button" className="btn sm primary" disabled={!!busy} onClick={save}>Save</button>
              <button type="button" className="btn sm ghost" onClick={() => setEdit(null)}>Cancel</button>
            </>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {(['docx', 'pdf', 'html', 'md'] as const).map((k) => (
            <button key={k} type="button" className="btn sm" disabled={!!busy} onClick={() => exp(k)}>
              {busy === k ? '…' : { docx: 'Word', pdf: 'PDF', html: 'HTML', md: 'Markdown' }[k]}
            </button>
          ))}
        </div>
      </div>
      {edit !== null ? (
        <div className="doc-edit">
          <textarea className="dg-code" value={edit} onChange={(e) => setEdit(e.target.value)} spellCheck={false} />
          <div className="doc-preview">
            <DocumentBody md={edit} />
          </div>
        </div>
      ) : (
        <DocumentBody md={md} onFigure={setFigure} />
      )}
      {figure && <ArtifactModal id={figure} onClose={() => setFigure(null)} />}
    </div>
  );
}

/** Any artifact by id, with its version history. */
export function ArtifactPanel({ id, onChanged }: { id: string; onChanged?: () => void }) {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['sdlc-artifact', id], queryFn: () => get<Json>(`/api/v1/sdlc/artifacts/${id}`) });
  const [ver, setVer] = useState<number | null>(null);
  const old = useQuery({ queryKey: ['sdlc-artifact', id, ver], enabled: ver !== null, queryFn: () => get<Json>(`/api/v1/sdlc/artifacts/${id}/versions/${ver}`) });
  if (!data) return <Spinner />;
  const a = ver !== null && old.data ? { ...data.artifact, ...old.data, id: data.artifact.id, drawio: old.data.drawio } : data.artifact;
  const saved = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['sdlc-run'] });
    qc.invalidateQueries({ queryKey: ['sdlc-artifacts'] });
    onChanged?.();
  };
  return (
    <div className="stack">
      <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className={`chip ${data.artifact.status === 'approved' ? 'good' : ''}`}>{data.artifact.status === 'approved' ? 'approved' : 'draft'}</span>
        <span className="muted">updated {relative(data.artifact.updated_at)}</span>
        {data.versions.length > 1 && (
          <label className="row" style={{ gap: 4 }}>
            <span className="muted">Version</span>
            <select value={ver ?? ''} onChange={(e) => setVer(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{data.artifact.version} (current)</option>
              {data.versions.slice(1).map((v: Json) => (
                <option key={v.version} value={v.version}>
                  {v.version} — {v.note ?? ''} {v.by ? `· ${v.by}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {a.kind === 'diagram' ? <DiagramView key={`${a.id}-${a.version}`} artifact={a} canEdit={ver === null} onSaved={saved} /> : <DocumentView key={`${a.id}-${a.version}`} artifact={a} canEdit={ver === null} onSaved={saved} />}
    </div>
  );
}

export function ArtifactModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['sdlc-artifact', id], queryFn: () => get<Json>(`/api/v1/sdlc/artifacts/${id}`) });
  return (
    <Modal title={data?.artifact.title ?? 'Loading…'} xl onClose={onClose}>
      <div className="modal-body">
        <ArtifactPanel id={id} />
      </div>
    </Modal>
  );
}
