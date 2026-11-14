/** A meeting in Copilot: the brief before, notes / transcript / recording during, the debrief after. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, upload } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';
import { AgentOutput, citeHref, type Json, type Run } from './AgentOutput';
import { ActionItems } from './Widgets';

export function MeetingModal({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['meeting', eventId];
  const q = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/intel/meetings/${eventId}`) });
  const [tab, setTab] = useState<'prep' | 'notes' | 'debrief'>('prep');
  const [notes, setNotes] = useState('');
  const [transcript, setTranscript] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setNotes(q.data.notes ?? '');
    setTranscript(q.data.transcript ?? '');
    if (q.data.debrief) setTab('debrief');
    else if (new Date(q.data.event.startsAt).getTime() < Date.now()) setTab('notes');
  }, [q.data?.event?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['copilot'] });
    qc.invalidateQueries({ queryKey: ['action-items'] });
  };
  const doing = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const saveNotes = () => put(`/api/v1/intel/meetings/${eventId}/notes`, { notes, transcript });

  if (!q.data)
    return (
      <Modal title="Meeting" onClose={onClose} wide>
        <div className="modal-body one">
          <Spinner />
        </div>
      </Modal>
    );
  const e = q.data.event;
  return (
    <Modal title={e.title} onClose={onClose} wide>
      <div className="modal-body one">
        <div className="small muted">
          {dateTime(e.startsAt)} · {e.kind.replace('_', ' ')}
          {e.location ? ` · ${e.location}` : ''}
          {e.related && (
            <>
              {' · '}
              <Link to={citeHref(e.related)} onClick={onClose}>
                {e.related.title}
              </Link>
            </>
          )}
        </div>
        <div className="tabs" role="tablist" style={{ padding: 0, marginTop: 8 }}>
          {(['prep', 'notes', 'debrief'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === 'prep' ? 'Brief' : t === 'notes' ? 'Notes & recording' : 'Debrief'}
            </button>
          ))}
        </div>

        {tab === 'prep' && (
          <div className="stack" style={{ marginTop: 12 }}>
            {q.data.prep ? <AgentOutput run={q.data.prep as Run} /> : <p className="muted">No brief yet. It pulls in the recent conversations, open items, risks, competitors and questions to ask.</p>}
            <div>
              <button className="btn ai" disabled={!!busy || !e.related} onClick={() => doing('prep', () => post('/api/v1/intel/agents/meeting_prep/run', { object: 'event', id: eventId }))}>
                {busy === 'prep' ? 'Preparing…' : q.data.prep ? 'Refresh the brief' : 'Prepare a brief'}
              </button>
              {!e.related && <p className="small muted">Link this meeting to a lead, contact, account or deal in the calendar to get a brief.</p>}
            </div>
          </div>
        )}

        {tab === 'notes' && (
          <div className="stack" style={{ marginTop: 12 }}>
            <label className="field">
              <span>Your notes</span>
              <textarea rows={7} value={notes} onChange={(x) => setNotes(x.target.value)} placeholder={'What was discussed, decisions, numbers, dates.\nLines starting with "Action:" or "- [ ]" become action items.'} />
            </label>
            <label className="field">
              <span>Transcript {q.data.transcriptSource === 'audio' && <span className="chip info tiny">from recording</span>}</span>
              <textarea rows={5} value={transcript} onChange={(x) => setTranscript(x.target.value)} placeholder="Paste a transcript from Meet, Teams or Zoom, or upload a recording below" />
            </label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn" disabled={!!busy || !q.data.canWrite} onClick={() => doing('save', async () => (await saveNotes(), toast('Saved')))}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
              <label className={`btn${busy ? ' disabled' : ''}`}>
                {busy === 'audio' ? 'Transcribing…' : 'Upload recording'}
                <input
                  type="file"
                  accept="audio/*,video/webm"
                  hidden
                  disabled={!!busy}
                  onChange={(x) => {
                    const f = x.target.files?.[0];
                    if (f)
                      doing('audio', async () => {
                        const r = await upload<{ transcript: string }>(`/api/v1/intel/meetings/${eventId}/transcribe`, f);
                        setTranscript((t) => (t ? `${t}\n\n${r.transcript}` : r.transcript));
                        toast('Recording transcribed');
                      });
                  }}
                />
              </label>
              <button
                className="btn ai"
                disabled={!!busy || (notes + transcript).trim().length < 20}
                onClick={() =>
                  doing('debrief', async () => {
                    await saveNotes();
                    await post('/api/v1/intel/agents/meeting_debrief/run', { object: 'event', id: eventId });
                    setTab('debrief');
                  })
                }
              >
                {busy === 'debrief' ? 'Debriefing…' : 'Debrief this meeting'}
              </button>
            </div>
            <p className="small muted">Recordings are turned into text and not kept. Up to 25 MB.</p>
          </div>
        )}

        {tab === 'debrief' && (
          <div className="stack" style={{ marginTop: 12 }}>
            {q.data.debrief ? <AgentOutput run={q.data.debrief as Run} /> : <p className="muted">Add notes or a recording, then debrief the meeting.</p>}
            {q.data.debrief && e.related && (
              <p className="small">
                Suggested field updates wait for approval on <Link to={citeHref(e.related)} onClick={onClose}>{e.related.title}</Link> → Copilot.
              </p>
            )}
            <h3>Action items</h3>
            <ActionItems query={`scope=event&id=${eventId}&status=all`} empty="None yet." />
          </div>
        )}
      </div>
    </Modal>
  );
}
