import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, PlugZap, Save, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND } from './helpers';
import { inp, Field } from './PureSettingsPage';

const EMPTY_FORM = {
  name: '', mgmt_host: '', auth_method: 'client',
  client_id: '', key_id: '', username: '', issuer: '',
  privateKey: '', apiToken: '',
  polling_interval_minutes: 15, ssl_verify: true,
};

function formFromRow(row) {
  if (!row) return { ...EMPTY_FORM };
  return {
    name: row.name || '',
    mgmt_host: row.mgmt_host || '',
    auth_method: row.auth_method === 'token' ? 'token' : 'client',
    client_id: '', key_id: '', username: '',
    issuer: row.issuer || '',
    privateKey: '', apiToken: '',
    polling_interval_minutes: row.polling_interval_minutes || 15,
    ssl_verify: !!row.ssl_verify,
  };
}

function CredentialGuidance({ authMethod }) {
  return (
    <div className="text-[11px] text-ink-faint space-y-1 mb-2">
      <p>Two ways to authenticate to a FlashArray:</p>
      {authMethod === 'token' ? (
        <p>
          API token: each array user has one — Purity UI → Settings → Users (or <code>pureadmin list --api-token --expose</code> in
          the CLI). A read-only user is sufficient for monitoring.{' '}
          <a href="https://support.purestorage.com/Solutions/Microsoft_Platform_Guide/a_Windows_PowerShell/How-To:_Manage_Credentials"
            target="_blank" rel="noreferrer" className="underline">Managing FlashArray credentials</a>
        </p>
      ) : (
        <p>
          API client (OAuth2): create with <code>pureadmin apiclient create</code> on the array (Purity//FA 6.x). You'll need
          the client_id, key_id, issuer, a username the client acts as, and the RSA private key (PEM) whose public half you
          registered. Generate the key pair with openssl (e.g. <code>openssl genrsa -out private.pem 2048</code>).{' '}
          <a href="https://support.purestorage.com/bundle/m_purityfa_rest_api/page/FlashArray/PurityFA/topics/concept/c_purityfa_rest_api.html"
            target="_blank" rel="noreferrer" className="underline">Purity//FA REST API reference</a>{' '}
          <a href="https://support.everpuredata.com/r/microsoft-platform-guide/connect-via-oauth2"
            target="_blank" rel="noreferrer" className="underline">OAuth2 / API client setup guide</a>
        </p>
      )}
    </div>
  );
}

function buildPayload(form) {
  const payload = {
    name: form.name.trim(),
    mgmt_host: form.mgmt_host.trim(),
    auth_method: form.auth_method,
    polling_interval_minutes: Number(form.polling_interval_minutes) || 15,
    ssl_verify: !!form.ssl_verify,
  };
  if (form.auth_method === 'token') {
    if (form.apiToken.trim()) payload.apiToken = form.apiToken.trim();
  } else {
    payload.client_id = form.client_id.trim();
    payload.key_id = form.key_id.trim();
    payload.username = form.username.trim();
    if (form.issuer.trim()) payload.issuer = form.issuer.trim();
    if (form.privateKey.trim()) payload.privateKey = form.privateKey;
  }
  return payload;
}

function ArrayForm({ mode, initial, onCancel, onSaved }) {
  const [form, setForm] = useState(() => formFromRow(initial));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const payload = buildPayload(form);
      delete payload.name;
      const { data } = await client.post('/pure/arrays/test', payload);
      setTestResult(data.ok ? { ok: true, msg: 'Connection succeeded' } : { ok: false, msg: data.error || 'Connection failed' });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.response?.data?.error || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = buildPayload(form);
      const { data } = mode === 'edit'
        ? await client.put(`/pure/arrays/${initial.id}`, payload)
        : await client.post('/pure/arrays', payload);
      onSaved(data, mode);
    } catch (err) {
      setSubmitError(err?.response?.data?.error || err?.response?.data?.errors?.[0]?.msg || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {submitError && (
        <div className="bg-status-crit/10 border border-status-crit/25 text-status-crit text-xs rounded-lg px-3 py-2">{submitError}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input required value={form.name} onChange={(e) => set('name', e.target.value)} className={inp} />
        </Field>
        <Field label="Management host">
          <input required value={form.mgmt_host} onChange={(e) => set('mgmt_host', e.target.value)}
            placeholder="e.g. flasharray1.company.com" className={inp} />
        </Field>
      </div>

      <CredentialGuidance authMethod={form.auth_method} />

      <Field label="Authentication method">
        <select value={form.auth_method} onChange={(e) => set('auth_method', e.target.value)} className={inp}>
          <option value="client">API client (OAuth2)</option>
          <option value="token">API token</option>
        </select>
      </Field>

      {form.auth_method === 'client' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Client ID">
              <input required value={form.client_id} onChange={(e) => set('client_id', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Key ID">
              <input required value={form.key_id} onChange={(e) => set('key_id', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Username">
              <input required value={form.username} onChange={(e) => set('username', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Issuer" hint="Optional">
              <input value={form.issuer} onChange={(e) => set('issuer', e.target.value)} className={inp} autoComplete="off" />
            </Field>
          </div>
          <Field label="Private key (PEM)" hint={mode === 'edit' ? 'Stored — leave blank to keep the existing key.' : undefined}>
            <textarea value={form.privateKey} onChange={(e) => set('privateKey', e.target.value)} rows={5}
              placeholder={mode === 'edit' ? '•••••• (stored — leave blank to keep)' : '-----BEGIN PRIVATE KEY-----'}
              className={`${inp} font-mono text-[11px]`} spellCheck={false} />
          </Field>
        </>
      ) : (
        <Field label="API token" hint={mode === 'edit' ? 'Stored — leave blank to keep the existing token.' : undefined}>
          <input type="password" value={form.apiToken} onChange={(e) => set('apiToken', e.target.value)}
            placeholder={mode === 'edit' ? '•••••• (stored — leave blank to keep)' : ''}
            className={inp} autoComplete="off" spellCheck={false} />
        </Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Polling interval (minutes)">
          <input type="number" min={5} max={1440} value={form.polling_interval_minutes}
            onChange={(e) => set('polling_interval_minutes', e.target.value)} className={inp} />
        </Field>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
            <input type="checkbox" checked={form.ssl_verify} onChange={(e) => set('ssl_verify', e.target.checked)} className="accent-brand cursor-pointer" />
            Verify SSL certificate
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <button type="submit" disabled={submitting}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
          <Save size={13} /> {submitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add array'}
        </button>
        <button type="button" onClick={handleTest} disabled={testing}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
          <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={onCancel}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 text-ink-muted hover:text-ink transition-colors">
          <X size={13} /> Cancel
        </button>
        {testResult && (
          <span className={`text-[12px] ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
          </span>
        )}
      </div>
    </form>
  );
}

export default function PureDirectArraysTab() {
  const { toast } = useToast();
  const [arrays, setArrays] = useState(null);
  const [mode, setMode] = useState(null); // null | 'add' | { edit: row }
  const [pollingId, setPollingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(() => client.get('/pure/arrays')
    .then(({ data }) => setArrays(data))
    .catch(() => { setArrays([]); toast({ type: 'error', title: 'Failed to load arrays' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (row, savedMode) => {
    setMode(null);
    load();
    toast({ type: 'success', title: savedMode === 'edit' ? 'Array updated' : 'Array registered — first poll triggered' });
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete array "${row.name}"? This removes its stored credentials and history.`)) return;
    setDeletingId(row.id);
    try {
      await client.delete(`/pure/arrays/${row.id}`);
      toast({ type: 'success', title: 'Array deleted' });
      setArrays((prev) => prev.filter((a) => a.id !== row.id));
    } catch (err) {
      toast({ type: 'error', title: 'Delete failed', message: err?.response?.data?.error || 'Could not delete array.' });
    } finally {
      setDeletingId(null);
    }
  };

  const handlePoll = async (row) => {
    setPollingId(row.id);
    try {
      await client.post(`/pure/arrays/${row.id}/poll`);
      toast({ type: 'success', title: `Poll triggered for ${row.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Poll failed', message: err?.response?.data?.error || 'Could not trigger poll.' });
    } finally {
      setPollingId(null);
    }
  };

  if (arrays == null) {
    return <LoadingPanel label="Loading arrays…" height={160} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-xs text-ink-muted max-w-lg">
          Directly-managed FlashArrays, polled on their own schedule independent of Pure1.
        </p>
        {!mode && (
          <button onClick={() => setMode('add')}
            className="inline-flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 bg-brand text-cohesity-black rounded-lg hover:bg-brand-bright transition-colors flex-shrink-0">
            <Plus size={14} /> Add array
          </button>
        )}
      </div>

      {mode === 'add' && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Add array</p>
          <ArrayForm mode="add" onCancel={() => setMode(null)} onSaved={handleSaved} />
        </div>
      )}

      {mode?.edit && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Edit — {mode.edit.name}</p>
          <ArrayForm mode="edit" initial={mode.edit} onCancel={() => setMode(null)} onSaved={handleSaved} />
        </div>
      )}

      {arrays.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-ink-muted">No direct arrays registered yet.</div>
      ) : (
        <div className="panel p-0 overflow-hidden divide-y divide-cohesity-border">
          {arrays.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{row.name}</p>
                <p className="text-[11px] text-ink-faint truncate">{row.mgmt_host}</p>
              </div>
              <Badge tone={row.auth_method === 'token' ? 'info' : 'brand'}>
                {row.auth_method === 'token' ? 'API token' : 'API client'}
              </Badge>
              {row.auth_method === 'token' ? (
                <Badge tone="neutral">Token stored</Badge>
              ) : (
                <div className="flex items-center gap-1">
                  <Badge tone={row.has_client_id ? 'ok' : 'crit'}>Client ID</Badge>
                  <Badge tone={row.has_key_id ? 'ok' : 'crit'}>Key ID</Badge>
                  <Badge tone={row.has_username ? 'ok' : 'crit'}>User</Badge>
                </div>
              )}
              <span className="text-[11px] text-ink-faint w-14 flex-shrink-0 hidden sm:block">{row.polling_interval_minutes}m</span>
              <Badge tone={row.ssl_verify ? 'ok' : 'neutral'} className="hidden md:inline-flex">
                {row.ssl_verify ? 'SSL verify' : 'SSL relaxed'}
              </Badge>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button onClick={() => handlePoll(row)} disabled={pollingId === row.id} title="Poll now"
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
                  <PlugZap size={12} /> {pollingId === row.id ? 'Polling…' : 'Poll now'}
                </button>
                <button onClick={() => setMode({ edit: row })}
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors">
                  <Pencil size={12} /> Edit
                </button>
                <button onClick={() => handleDelete(row)} disabled={deletingId === row.id}
                  className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-status-crit hover:border-status-crit/40 transition-colors disabled:opacity-40">
                  <Trash2 size={12} /> {deletingId === row.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
