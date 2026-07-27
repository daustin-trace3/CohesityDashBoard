import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, Pencil, Search, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

// Portal to <body> — the page wrapper's fade-in animation leaves a transform
// applied (fill-mode: both), which would re-anchor position:fixed to the
// page div and cut off the modal top on scrolled/short pages.
function ProbeModal({ instance, onClose }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(false);
    client.get(`/ariaops/instances/${instance.id}/probe`)
      .then(({ data }) => setResult(data))
      .catch(() => setError(true));
  }, [instance.id]);

  const sections = result?.sections || {};

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Search size={15} className="text-brand" /> Raw probe — {instance.name}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Live per-section fetch against {instance.host} — read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex flex-col gap-3">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Probe failed — the instance may be unreachable.</div>
          ) : result == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : Object.keys(sections).length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">Probe returned no sections.</div>
          ) : (
            Object.entries(sections).map(([key, sec]) => (
              <div key={key} className="bg-surface-overlay rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge tone={sec?.ok ? 'ok' : 'crit'}>{sec?.ok ? 'OK' : 'ERROR'}</Badge>
                  <p className="text-xs font-semibold text-ink">{key}</p>
                  {sec?.count != null && <span className="text-[11px] text-ink-faint tnum">{sec.count} item(s)</span>}
                </div>
                {sec?.error && <p className="text-[11px] text-status-crit mb-1.5">{sec.error}</p>}
                <pre className="text-[10px] text-ink-muted whitespace-pre-wrap break-all bg-cohesity-black/40 rounded-md p-2 max-h-52 overflow-y-auto">
                  {JSON.stringify(sec?.firstItem ?? sec, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function AriaOpsSettingsPage() {
  const { toast } = useToast();
  const [instances, setInstances] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', username: '', password: '', authSource: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [probeInstance, setProbeInstance] = useState(null);

  const loadInstances = () => client.get('/ariaops/instances')
    .then(({ data }) => setInstances(data))
    .catch(() => setInstances([]));

  useEffect(() => { loadInstances(); }, []);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/ariaops/instances/test', {
        host: form.host.trim(), username: form.username.trim(),
        password: form.password || undefined, authSource: form.authSource.trim() || undefined,
        sslVerify: form.sslVerify, id: editingId || undefined,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', host: '', username: '', password: '', authSource: '', sslVerify: false, pollingIntervalMinutes: 15 });
    setTestResult(null);
  };

  const startEdit = (o) => {
    setEditingId(o.id);
    setForm({
      name: o.name, host: o.host, username: o.username, password: '', authSource: o.authSource || '',
      sslVerify: !!o.sslVerify, pollingIntervalMinutes: o.pollingIntervalMinutes || 15,
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const add = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), host: form.host.trim(), username: form.username.trim(),
        authSource: form.authSource.trim() || undefined,
        sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await client.put(`/ariaops/instances/${editingId}`, body);
        toast({ type: 'success', title: 'Aria Operations instance updated', message: form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.' });
      } else {
        body.password = form.password;
        await client.post('/ariaops/instances', body);
        toast({ type: 'success', title: 'Aria Operations instance registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      blankForm();
      await loadInstances();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (o) => {
    if (!window.confirm(`Unregister Aria Operations instance "${o.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/ariaops/instances/${o.id}`);
      await loadInstances();
      toast({ type: 'success', title: `Removed ${o.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const refresh = async (o) => {
    setRefreshingId(o.id);
    try {
      await client.post(`/ariaops/instances/${o.id}/refresh`, {}, { timeout: 300000 });
      await loadInstances();
      toast({ type: 'success', title: `${o.name} refreshed` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${o.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="Aria Operations Settings" description="Register vROps instances — each is polled directly with its own credentials" />

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'Aria Operations instance'}` : 'Add an Aria Operations instance'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          A read-only Aria Operations account is sufficient for resources and alerts. The password is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Prod Aria Operations" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / FQDN</label>
            <input value={form.host} onChange={set('host')} placeholder="vrops.company.com" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Username</label>
            <input value={form.username} onChange={set('username')} placeholder="apiuser" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Auth source <span className="font-normal text-ink-faint">(optional)</span></label>
            <input value={form.authSource} onChange={set('authSource')} placeholder="local" className={inp} spellCheck={false} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add Aria Operations instance'}
          </button>
          {editingId && (
            <button onClick={cancelEdit}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
          )}
          <button onClick={test} disabled={testing || !form.host.trim() || !form.username.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-2">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok ? `Connected${testResult.version ? ` — v${testResult.version}` : ''}` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered Aria Operations instances</p>
        {instances == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : instances.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Aria Operations instances registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Username</th>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last Poll</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {instances.map((o) => (
                  <tr key={o.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{o.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{o.host}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{o.username}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{o.version || '—'}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={o.lastPollStatus === 'error' ? 'crit' : o.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {o.lastPollStatus === 'error' ? 'Unreachable' : o.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {o.lastPollStatus === 'error' && o.lastPollError && (
                        <p className="text-[10px] text-status-crit mt-0.5 max-w-[260px] truncate" title={o.lastPollError}>{o.lastPollError}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(o.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => startEdit(o)} title="Edit connection / update credentials" aria-label={`Edit ${o.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(o)} disabled={refreshingId === o.id} title="Poll now" aria-label={`Poll ${o.name} now`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                          <RefreshCw size={13} className={refreshingId === o.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => setProbeInstance(o)} title="Probe raw API shapes" aria-label={`Probe ${o.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Search size={13} />
                        </button>
                        <button onClick={() => remove(o)} title="Unregister" aria-label={`Unregister ${o.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
          The Aria Operations platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>

      {probeInstance && <ProbeModal instance={probeInstance} onClose={() => setProbeInstance(null)} />}
    </div>
  );
}
