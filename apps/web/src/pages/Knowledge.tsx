import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';

interface Doc {
  id: string;
  title: string;
  status: string;
  chunk_count: number;
  error: string | null;
  created_at: string;
}

export function KnowledgePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; citations: { documentId: string; title: string }[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['kb'],
    queryFn: () => get<{ items: Doc[] }>('/api/ai/kb/documents'),
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.status === 'pending') ? 3000 : false),
  });

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    setAsking(true);
    try {
      setAnswer(await post('/api/ai/kb/ask', { question }));
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Knowledge base</h1>
          <p>Price lists, policies and product notes your team and Synapse AI answer from.</p>
        </div>
        {can('ai') && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            Add document
          </button>
        )}
      </div>
      <div className="two-col">
        <section className="panel">
          <form className="panel-body stack" onSubmit={ask}>
            <label className="field">
              Ask a question
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What is our refund policy for annual plans?" />
            </label>
            <div>
              <button className="btn ai" disabled={asking || question.trim().length < 3}>
                {asking ? 'Searching…' : 'Ask Synapse AI'}
              </button>
            </div>
          </form>
          {answer && (
            <div className="panel-body">
              <div className="ai-box">
                <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{answer.answer}</p>
                {answer.citations.length > 0 && <p className="muted small">Sources: {answer.citations.map((c) => c.title).join(', ')}</p>}
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Documents</h2>
          </div>
          {isLoading ? (
            <div className="panel-body">
              <Spinner />
            </div>
          ) : data?.items.length ? (
            <table className="data">
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b>{d.title}</b>
                      <div className="muted small">
                        {d.status === 'indexed' ? `${d.chunk_count} passages` : d.status === 'failed' ? `Indexing failed: ${d.error}` : 'Indexing…'} · added {relative(d.created_at)}
                      </div>
                    </td>
                    {can('ai') && (
                      <td style={{ width: 80 }}>
                        <button
                          className="btn danger sm"
                          onClick={async () => {
                            await del(`/api/ai/kb/documents/${d.id}`);
                            qc.invalidateQueries({ queryKey: ['kb'] });
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No documents yet">Paste your FAQ, price list or product sheet so AI drafts and answers stay accurate.</Empty>
          )}
        </section>
      </div>
      {adding && <AddDoc onClose={() => setAdding(false)} />}
    </>
  );
}

function AddDoc({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const save = async () => {
    try {
      await post('/api/ai/kb/documents', { title, content });
      toast('Document added. Indexing has started.');
      qc.invalidateQueries({ queryKey: ['kb'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title="Add document"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title || !content} onClick={save}>
            Add document
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing and refund policy 2026" />
        </label>
        <label className="field wide">
          Content
          <textarea value={content} onChange={(e) => setContent(e.target.value)} style={{ minHeight: 280 }} placeholder="Paste plain text or Markdown" />
        </label>
        <p className="muted small wide">Text is stored in your workspace only and is never shared with other workspaces.</p>
      </div>
    </Modal>
  );
}
