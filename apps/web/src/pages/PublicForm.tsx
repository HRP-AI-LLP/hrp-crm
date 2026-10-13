import type { FieldDef } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { FieldInput } from '../components/fields';
import { ApiError } from '../lib/api';

/** Hosted web-to-lead form (no sign-in). Uses plain fetch: no workspace header, no credentials. */
export function PublicFormPage() {
  const { key = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['public-form', key],
    queryFn: async () => {
      const r = await fetch(`/api/public/forms/${key}`);
      if (!r.ok) throw new Error('This form is not available.');
      return (await r.json()) as { name: string; fields: FieldDef[] };
    },
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const r = await fetch(`/api/public/forms/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...values, consent }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e2 = new ApiError(r.status, j.error?.code, j.error?.message ?? 'Could not submit', j.error?.details);
      setErr(e2.details?.map((d) => `${d.field}: ${d.message}`).join('; ') || e2.message);
      return;
    }
    setDone(j.message);
  };

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="panel" style={{ width: 'min(520px, 100%)' }}>
        <div className="panel-head">
          <h2>{data?.name ?? 'Contact us'}</h2>
        </div>
        <div className="panel-body">
          {error && <p className="field-error">{(error as Error).message}</p>}
          {done ? (
            <p>{done}</p>
          ) : (
            data && (
              <form className="stack" onSubmit={submit}>
                {data.fields.map((f) => (
                  <label key={f.key} className="field">
                    <span>
                      {f.label} {f.required && <span className="req">*</span>}
                    </span>
                    {f.type === 'lookup' || f.type === 'user' ? null : <FieldInput field={{ ...f, standard: false }} objectKey="" value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />}
                  </label>
                ))}
                <input name="_hp" tabIndex={-1} autoComplete="off" className="sr-only" aria-hidden="true" onChange={(e) => setValues((s) => ({ ...s, _hp: e.target.value }))} />
                <label className="row small">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree to be contacted about my enquiry.
                </label>
                {err && <div className="field-error">{err}</div>}
                <button className="btn primary">Send</button>
              </form>
            )
          )}
        </div>
      </div>
    </div>
  );
}
