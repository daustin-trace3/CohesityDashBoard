// vCenter Settings — ported from frontend/src/pages/vcenter/VcSettingsPage.jsx.
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil } from '../icons.jsx';
import { apiFetch, PageHeader, Badge, LoadingPanel, Spinner, BRAND, fmtWhen } from '../ui.jsx';

const inp = 'vc-input';

export default function VcSettingsPage() {
  const [vcs, setVcs] = React.useState(null);
  const [form, setForm] = React.useState({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [certWarnDays, setCertWarnDays] = React.useState('');
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const flash = (type, title, message) => {
    setStatusMsg({ type, title, message });
    setTimeout(() => setStatusMsg((s) => (s?.title === title ? null : s)), 5000);
  };

  const loadVcs = () => apiFetch('/vcenter/vcenters')
    .then((json) => setVcs(Array.isArray(json) ? json : []))
    .catch(() => setVcs([]));

  React.useEffect(() => {
    loadVcs();
    apiFetch('/vcenter/config')
      .then((json) => setCertWarnDays(String(json.certWarnDays)))
      .catch(() => setCertWarnDays('60'));
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const json = await apiFetch('/vcenter/config', { method: 'PUT', body: { certWarnDays: Number(certWarnDays) } });
      setCertWarnDays(String(json.certWarnDays));
      flash('success', 'Thresholds saved', `Certificate warnings now start ${json.certWarnDays} days before expiry.`);
    } catch (err) {
      flash('error', 'Save failed', err?.payload?.error || 'Enter a value between 1 and 365 days.');
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const json = await apiFetch('/vcenter/vcenters/test', {
        method: 'POST',
        body: {
          host: form.host.trim(), username: form.username.trim(),
          password: form.password || undefined, sslVerify: form.sslVerify,
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
    setForm({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
    setTestResult(null);
  };

  const startEdit = (vc) => {
    setEditingId(vc.id);
    setForm({
      name: vc.name, host: vc.host, username: vc.username, password: '',
      sslVerify: !!vc.sslVerify, pollingIntervalMinutes: vc.pollingIntervalMinutes || 15,
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
        sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await apiFetch(`/vcenter/vcenters/${editingId}`, { method: 'PUT', body });
        flash('success', 'vCenter updated', form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.');
      } else {
        body.password = form.password;
        await apiFetch('/vcenter/vcenters', { method: 'POST', body });
        flash('success', 'vCenter registered', 'First poll started — data appears shortly.');
      }
      setEditingId(null);
      blankForm();
      await loadVcs();
    } catch (err) {
      flash('error', editingId ? 'Update failed' : 'Registration failed', err?.payload?.error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (vc) => {
    if (!window.confirm(`Unregister vCenter "${vc.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiFetch(`/vcenter/vcenters/${vc.id}`, { method: 'DELETE' });
      await loadVcs();
      flash('success', `Removed ${vc.name}`);
    } catch (err) {
      flash('error', 'Remove failed', err?.payload?.error);
    }
  };

  const refresh = async (vc) => {
    setRefreshingId(vc.id);
    try {
      await apiFetch(`/vcenter/vcenters/${vc.id}/refresh`, { method: 'POST', body: {} });
      await loadVcs();
      flash('success', `${vc.name} refreshed`);
    } catch (err) {
      flash('error', `Refresh failed for ${vc.name}`, err?.payload?.error);
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  return (
    <div className="animate-fade-in max-w-5xl">
      <PageHeader icon={Settings} title="vCenter Settings" description="Register vCenter servers — each is polled directly with its own credentials" />

      {statusMsg && (
        <div className={`panel p-3 mb-4 text-xs ${statusMsg.type === 'error' ? 'text-status-crit' : 'text-status-ok'}`} style={{ borderLeft: `3px solid ${statusMsg.type === 'error' ? '#F87171' : '#34D399'}` }}>
          <b>{statusMsg.title}</b>{statusMsg.message ? ` — ${statusMsg.message}` : ''}
        </div>
      )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'vCenter'}` : 'Add a vCenter'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          A read-only vCenter account is sufficient for inventory; certificate details additionally need the
          certificate-management view privilege. The password is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Prod vCenter" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / FQDN</label>
            <input value={form.host} onChange={set('host')} placeholder="vcenter.company.com" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Username</label>
            <input value={form.username} onChange={set('username')} placeholder="monitor@vsphere.local" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add vCenter'}
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
              {testResult.ok ? `Connected — ${testResult.hosts} host(s) visible` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          How far ahead of a vCenter TLS certificate's expiry the Overview raises a warning. Expiry within 14 days (or past due) is always critical.
        </p>
        <div className="flex items-end gap-3">
          <div className="w-56">
            <label className="block text-xs font-semibold text-ink mb-1">Certificate warning (days before expiry)</label>
            <input type="number" min={1} max={365} value={certWarnDays}
              onChange={(e) => setCertWarnDays(e.target.value)} className={inp} />
          </div>
          <button onClick={saveConfig} disabled={savingConfig || !certWarnDays || Number(certWarnDays) < 1 || Number(certWarnDays) > 365}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered vCenters</p>
        {vcs == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : vcs.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No vCenters registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Username</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last Poll</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {vcs.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{v.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{v.host}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.username}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={v.lastPollStatus === 'error' ? 'crit' : v.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {v.lastPollStatus === 'error' ? 'Unreachable' : v.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {v.lastPollStatus === 'error' && v.lastPollError && (
                        <p className="text-[10px] text-status-crit mt-0.5 max-w-[260px] truncate" title={v.lastPollError}>{v.lastPollError}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(v.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => startEdit(v)} title="Edit connection / update credentials" aria-label={`Edit ${v.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(v)} disabled={refreshingId === v.id} title="Poll now" aria-label={`Poll ${v.name} now`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                          <RefreshCw size={13} className={refreshingId === v.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => remove(v)} title="Unregister" aria-label={`Unregister ${v.name}`}
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
          The vCenter platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>
    </div>
  );
}
