/**
 * Renders an agent run: headline, sections of points, and the CRM records each point cites.
 * Every agent returns the same shape, so one renderer serves all of them.
 */
import { AGENT_BY_KEY } from '@synapse/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../ui';
import { relative } from '../../lib/format';

export type Json = Record<string, any>;
export interface Citation {
  ref: string;
  object: string;
  id: string;
  kind: string;
  label: string;
  at: string | null;
}
export interface Run {
  id: string;
  agent?: string;
  agent_key?: string;
  output: Json;
  citations: Citation[];
  aiUsed?: boolean;
  ai_used?: boolean;
  model?: string | null;
  started_at?: string;
  actionItems?: { id: string; title: string }[];
  suggestions?: { id: string; field: string; proposed: unknown }[];
}

export function citeHref(c: { object: string; id: string }) {
  if (c.object === 'event') return `/copilot?meeting=${c.id}`;
  if (c.object === 'kb') return '/knowledge';
  return `/o/${c.object}/${c.id}`;
}

export function Cites({ cites }: { cites?: Citation[] }) {
  if (!cites?.length) return null;
  return (
    <span className="cites">
      {cites.slice(0, 4).map((c) => (
        <Link key={`${c.ref}-${c.id}`} to={citeHref(c)} className="cite" title={c.label}>
          {c.ref}
        </Link>
      ))}
    </span>
  );
}

export function ScoreBadge({ kind, score, band }: { kind: string; score: number; band: string }) {
  const label = kind === 'deal_risk' ? 'Risk' : kind === 'account_health' ? 'Health' : 'Fit';
  return (
    <span className={`score-badge ${band}`} title={`${label} ${score}/100`}>
      <b>{score}</b> {label.toLowerCase()}
    </span>
  );
}

function Copy({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button
      className="btn sm"
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => toast('Copied'))
          .catch(() => toast('Copy failed', true))
      }
    >
      Copy
    </button>
  );
}

export function AgentOutput({ run, compact }: { run: Run; compact?: boolean }) {
  const o = run.output ?? {};
  const key = run.agent ?? run.agent_key ?? '';
  const def = AGENT_BY_KEY[key];
  const [showSources, setShowSources] = useState(false);
  const ai = run.aiUsed ?? run.ai_used;
  return (
    <div className="agent-out">
      <div className="spread">
        <div className="small muted">
          {def?.label ?? key}
          {run.started_at ? ` · ${relative(run.started_at)}` : ''}
          {ai ? ' · AI' : ' · rule-based'}
        </div>
        {typeof o.score === 'number' && <ScoreBadge kind={key === 'account_health' ? 'account_health' : 'deal_risk'} score={o.score} band={o.band} />}
      </div>
      {o.headline && <p className="agent-headline">{o.headline}</p>}
      {o.note && <p className="small muted">{o.note}</p>}
      {o.draft && (
        <div className="draft-box">
          {o.allowed === false && <p className="small" style={{ color: 'var(--bad)' }}>Not sent anywhere: this person has not agreed to marketing on {o.channel}. Use it only as a reply.</p>}
          {o.draft.subject && (
            <div className="small">
              <b>Subject:</b> {o.draft.subject}
            </div>
          )}
          <pre className="draft-text">{o.draft.body}</pre>
          <div className="row">
            <Copy text={o.draft.subject ? `${o.draft.subject}\n\n${o.draft.body}` : o.draft.body} />
            <Cites cites={o.draftCites} />
          </div>
          {Array.isArray(o.followUps) && o.followUps.length > 0 && (
            <details>
              <summary className="small">Follow-ups</summary>
              {o.followUps.map((f: Json, i: number) => (
                <div key={i} className="small" style={{ marginTop: 6 }}>
                  <b>After {f.afterDays} days:</b> {f.body}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {(o.sections as Json[] | undefined)?.map((s) => (
        <div key={s.key} className="agent-section">
          <h4>{s.title}</h4>
          {s.text && <p>{s.text}</p>}
          {s.items?.length > 0 && (
            <ul>
              {(s.items as Json[]).slice(0, compact ? 4 : 20).map((it, i) => (
                <li key={i}>
                  {it.link ? <Link to={it.link}>{it.text}</Link> : it.text}
                  {it.meta?.pitch && <div className="small muted">{it.meta.pitch}</div>}
                  <Cites cites={it.cites} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {Array.isArray(o.owners) && o.owners.length > 0 && (
        <table className="data small" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Owner</th>
              <th>Deals</th>
              <th>At risk</th>
              <th>Stalled</th>
              <th>Slipped</th>
              <th>No next step</th>
            </tr>
          </thead>
          <tbody>
            {(o.owners as Json[]).map((r) => (
              <tr key={r.owner}>
                <td>{r.owner}</td>
                <td>{r.deals}</td>
                <td>{r.atRisk}</td>
                <td>{r.stalled}</td>
                <td>{r.slipped}</td>
                <td>{r.noNext}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.citations?.length > 0 && !compact && (
        <div className="small">
          <button className="link-btn" onClick={() => setShowSources((v) => !v)}>
            {showSources ? 'Hide' : 'Show'} {run.citations.length} source{run.citations.length > 1 ? 's' : ''}
          </button>
          {showSources && (
            <ol className="sources">
              {run.citations.map((c) => (
                <li key={`${c.ref}-${c.id}`}>
                  <span className="cite">{c.ref}</span> <Link to={citeHref(c)}>{c.label}</Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {(run.actionItems?.length ?? 0) > 0 && <p className="small muted">Added {run.actionItems!.length} action item{run.actionItems!.length > 1 ? 's' : ''}.</p>}
      {(run.suggestions?.length ?? 0) > 0 && <p className="small muted">{run.suggestions!.length} field update{run.suggestions!.length > 1 ? 's' : ''} waiting for your approval.</p>}
    </div>
  );
}
