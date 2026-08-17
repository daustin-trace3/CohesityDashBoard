// Ported from the built-in AriaSettingsPage.jsx. The probe modal used
// react-dom's createPortal directly; window.ReactDOM here is react-dom/
// client (no createPortal), so this uses the ui.jsx Modal primitive
// (portalOrInline-guarded) instead.
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Search } from '../icons.jsx';
import { apiFetch, PageHeader, Badge, LoadingPanel, Spinner, Modal, BRAND, fmtWhen } from '../ui.jsx';

const inp = 'ar-input';

function ProbeModal({ instance, onClose }) {
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    setResult(null);
    setError(false);
    apiFetch(`/aria/instances/${instance.id}/probe`)
      .then((json) => setResult(json))
      .catch(() => setError(true));
  }, [instance.id]);

  const sections = result?.sections || {};

  return (
    <Modal title={`Raw probe — ${instance.name}`} subtitle={`Live per-section fetch against ${instance.host} — read-only`} icon={Search} onClose={onClose} maxWidth="min(768px,92vw)">
      {error ? (
        <div className="text-sm text-status-crit py-6 text-center">Probe failed — the instance may be unreachable.</div>
      ) : result == null ? (
        <div className="py-10 flex justify-center"><Spinner size={20} /></div>
      ) : Object.keys(sections).length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">Probe returned no sections.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {Object.entries(sections).map(([key, sec]) => (
            <div key={key} className="bg-surface-overlay rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <Badge tone={sec?.ok ? 'ok' : 'crit'}>{sec?.ok ? 'OK' : 'ERROR'}</Badge>
                <p className="text-xs font-semibold text-ink">{key}</p>
                {sec?.count != null && <span className="text-[11px] text-ink-faint tnum">{sec.count} item(s)</span>}
              </div>
              {sec?.error && <p className="text-[11px] text-status-crit mb-1.5">{sec.error}</p>}
              <pre className="text-[10px] text-ink-muted whitespace-pre-wrap break-all bg-black/40 rounded-md p-2 overflow-y-auto" style={{ maxHeight: 208 }}>
                {JSON.stringify(sec?.firstItem ?? sec, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function AriaSettingsPage() {
  const [instances, setInstances] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [form, setForm] = React.useState({ name: '', host: '', username: '', password: '', domain: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [probeInstance, setProbeInstance] = React.useState(null);
  const [leaseWarnDays, setLeaseWarnDays] = React.useState('');
  const [certWarnDays, setCertWarnDays] = React.useState('');
  const [requestFailLookbackHours, setRequestFailLookbackHours] = React.useState('');
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [status, setStatus] = React.useState(null); // { type, title, message }

  const flash = (type, title, message) => {
    setStatus({ type, title, message });
    setTimeout(() => setStatus(null), 5000);
  };

  const loadInstances = () => apiFetch('/aria/instances')
    .then((json) => setInstances(json))
    .catch(() => setInstances([]));

  React.useEffect(() => {
    loadInstances();
    apiFetch('/aria/config')
      .then((json) => {
        setLeaseWarnDays(String(json.leaseWarnDays));
        setCertWarnDays(String(json.certWarnDays));
        setRequestFailLookbackHours(String(json.requestFailLookbackHours));
      })
      .catch(() => { setLeaseWarnDays('7'); setCertWarnDays('30'); setRequestFailLookbackHours('24'); });
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const json = await apiFetch('/aria/config', {
        method: 'PUT',
        body: {
          leaseWarnDays: Number(leaseWarnDays), certWarnDays: Number(certWarnDays),
          requestFailLookbackHours: Number(requestFailLookbackHours),
        },
      });
      setLeaseWarnDays(String(json.leaseWarnDays));
      setCertWarnDays(String(json.certWarnDays));
      setRequestFailLookbackHours(String(json.requestFailLookbackHours));
      flash('success', 'Thresholds saved');
    } catch (err) {
      flash('error', 'Save failed', err?.payload?.error || 'Check the threshold values are within range.');
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const json = await apiFetch('/aria/instances/test', {
        method: 'POST',
        body: {
          host: form.host.trim(), username: form.username.trim(),
          password: form.password || undefined, domain: form.domain.trim() || undefined,
          sslVerify: form.sslVerify, id: editingId || undefined,
        },
      });
      setTestResult(json);
    } catch (err) {
      setTestResult(err?.payload || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', host: '', username: '', password: '', domain: '', sslVerify: false, pollingIntervalMinutes: 15 });
    setTestResult(null);
  };

  const startEdit = (o) => {
    setEditingId(o.id);
    setForm({
      name: o.name, host: o.host, username: o.username, password: '', domain: o.domain || '',
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
        domain: form.domain.trim() || undefined,
        sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        if (form.password) body.password = form.password;
        await apiFetch(`/aria/instances/${editingId}`, { method: 'PUT', body });
        flash('success', 'Aria instance updated', form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.');
      } else {
        body.password = form.password;
        await apiFetch('/aria/instances', { method: 'POST', body });
        flash('success', 'Aria instance registered', 'First poll started — data appears shortly.');
      }
      setEditingId(null);
      blankForm();
      await loadInstances();
    } catch (err) {
      flash('error', editingId ? 'Update failed' : 'Registration failed', err?.payload?.error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (o) => {
    if (!window.confirm(`Unregister Aria instance "${o.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiFetch(`/aria/instances/${o.id}`, { method: 'DELETE' });
      await loadInstances();
      flash('success', `Removed ${o.name}`);
    } catch (err) {
      flash('error', 'Remove failed', err?.payload?.error);
    }
  };

  const refresh = async (o) => {
    setRefreshingId(o.id);
    try {
      await apiFetch(`/aria/instances/${o.id}/refresh`, { method: 'POST', body: {} });
      await loadInstances();
      flash('success', `${o.name} refreshed`);
    } catch (err) {
      flash('error', `Refresh failed for ${o.name}`, err?.payload?.error);
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  return (
    <div className="animate-fade-in max-w-5xl">
      <PageHeader icon={Settings} title="Aria Automation Settings" description="Register vRA 8.x on-prem instances — each is polled directly with its own credentials" />

      {status && (
        <div className="panel p-3 mb-4 text-sm" style={{ borderLeft: `3px solid ${status.type === 'error' ? 'var(--ar-crit)' : 'var(--ar-ok)'}` }}>
          <span className={status.type === 'error' ? 'text-status-crit font-semibold' : 'text-status-ok font-semibold'}>{status.title}</span>
          {status.message && <span className="text-ink-muted"> — {status.message}</span>}
        </div>
      )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'Aria instance'}` : 'Add an Aria instance'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          A read-only Aria Automation account is sufficient for deployments, requests and inventory. The password is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Prod Aria Automation" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / FQDN</label>
            <input value={form.host} onChange={set('host')} placeholder="aria.company.com" className={inp} spellCheck={false} />
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
            <label className="block text-xs font-semibold text-ink mb-1">Domain <span className="font-normal text-ink-faint">(optional)</span></label>
            <input value={form.domain} onChange={set('domain')} placeholder="System Domain" className={inp} spellCheck={false} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={add} disabled={saving || !canSubmit}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: BRAND, color: '#0B1015', border: 'none', cursor: saving || !canSubmit ? 'default' : 'pointer', opacity: saving || !canSubmit ? 0.5 : 1 }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add Aria instance'}
          </button>
          {editingId && (
            <button onClick={cancelEdit} className="ar-btn-ghost">Cancel</button>
          )}
          <button onClick={test} disabled={testing || !form.host.trim() || !form.username.trim()} className="ar-btn-ghost">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok ? `Connected${testResult.version ? ` — v${testResult.version}` : ''}${testResult.deployments != null ? ` · ${testResult.deployments} deployment(s)` : ''}` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          How far ahead of expiry deployment leases and TLS certificates raise a warning, and how far back failed requests are counted.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div style={{ width: 224 }}>
            <label className="block text-xs font-semibold text-ink mb-1">Lease warning (days before expiry)</label>
            <input type="number" min={1} max={60} value={leaseWarnDays}
              onChange={(e) => setLeaseWarnDays(e.target.value)} className={inp} />
          </div>
          <div style={{ width: 224 }}>
            <label className="block text-xs font-semibold text-ink mb-1">Cert warning (days before expiry)</label>
            <input type="number" min={1} max={365} value={certWarnDays}
              onChange={(e) => setCertWarnDays(e.target.value)} className={inp} />
          </div>
          <div style={{ width: 224 }}>
            <label className="block text-xs font-semibold text-ink mb-1">Failed request lookback (hours)</label>
            <input type="number" min={1} max={168} value={requestFailLookbackHours}
              onChange={(e) => setRequestFailLookbackHours(e.target.value)} className={inp} />
          </div>
          <button onClick={saveConfig}
            disabled={savingConfig || !leaseWarnDays || Number(leaseWarnDays) < 1 || Number(leaseWarnDays) > 60
              || !certWarnDays || Number(certWarnDays) < 1 || Number(certWarnDays) > 365
              || !requestFailLookbackHours || Number(requestFailLookbackHours) < 1 || Number(requestFailLookbackHours) > 168}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: BRAND, color: '#0B1015', border: 'none', cursor: 'pointer', opacity: savingConfig ? 0.5 : 1 }}>
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered Aria instances</p>
        {instances == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : instances.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Aria instances registered yet.</div>
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
                          className="ar-btn-ghost" style={{ padding: 6 }}>
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(o)} disabled={refreshingId === o.id} title="Poll now" aria-label={`Poll ${o.name} now`}
                          className="ar-btn-ghost" style={{ padding: 6 }}>
                          <RefreshCw size={13} className={refreshingId === o.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => setProbeInstance(o)} title="Probe raw API shapes" aria-label={`Probe ${o.name}`}
                          className="ar-btn-ghost" style={{ padding: 6 }}>
                          <Search size={13} />
                        </button>
                        <button onClick={() => remove(o)} title="Unregister" aria-label={`Unregister ${o.name}`}
                          className="ar-btn-ghost" style={{ padding: 6, color: 'var(--ar-crit)' }}>
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
          The Aria Automation platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>

      {probeInstance && <ProbeModal instance={probeInstance} onClose={() => setProbeInstance(null)} />}
    </div>
  );
}
