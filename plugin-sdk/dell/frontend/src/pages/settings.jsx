import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil } from '../icons.jsx';
import { apiFetch, PageHeader, Badge, LoadingPanel, Spinner, BRAND, fmtWhen } from '../ui.jsx';

const inp = 'dl-input';

export default function DellSettingsPage() {
  const [instances, setInstances] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [form, setForm] = React.useState({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [warrantyWarnDays, setWarrantyWarnDays] = React.useState('');
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const flash = (type, title, message) => {
    setStatusMsg({ type, title, message });
    setTimeout(() => setStatusMsg((s) => (s?.title === title ? null : s)), 5000);
  };

  const loadInstances = () => apiFetch('/dell/instances')
    .then((json) => setInstances(json))
    .catch(() => setInstances([]));

  React.useEffect(() => {
    loadInstances();
    apiFetch('/dell/config')
      .then((json) => setWarrantyWarnDays(String(json.warrantyWarnDays)))
      .catch(() => setWarrantyWarnDays('90'));
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const json = await apiFetch('/dell/config', { method: 'PUT', body: { warrantyWarnDays: Number(warrantyWarnDays) } });
      setWarrantyWarnDays(String(json.warrantyWarnDays));
      flash('success', 'Thresholds saved', `Warranty warnings now start ${json.warrantyWarnDays} days before expiry.`);
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
      const json = await apiFetch('/dell/instances/test', {
        method: 'POST',
        body: {
          host: form.host.trim(), username: form.username.trim(),
          password: form.password || undefined, sslVerify: form.sslVerify,
        },
      });
      setTestResult(json);
    } catch (err) {
      setTestResult(err?.payload || { ok: false, message: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
    setTestResult(null);
  };

  const startEdit = (o) => {
    setEditingId(o.id);
    setForm({
      name: o.name, host: o.host, username: o.username, password: '',
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
        sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await apiFetch(`/dell/instances/${editingId}`, { method: 'PUT', body });
        flash('success', 'OME instance updated', form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.');
      } else {
        body.password = form.password;
        await apiFetch('/dell/instances', { method: 'POST', body });
        flash('success', 'OME instance registered', 'First poll started — data appears shortly.');
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
    if (!window.confirm(`Unregister OME instance "${o.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiFetch(`/dell/instances/${o.id}`, { method: 'DELETE' });
      await loadInstances();
      flash('success', `Removed ${o.name}`);
    } catch (err) {
      flash('error', 'Remove failed', err?.payload?.error);
    }
  };

  const refresh = async (o) => {
    setRefreshingId(o.id);
    try {
      await apiFetch(`/dell/instances/${o.id}/refresh`, { method: 'POST', body: {} });
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
      <PageHeader icon={Settings} title="Dell OME Settings" description="Register OpenManage Enterprise appliances — each is polled directly with its own credentials" />

      {statusMsg && (
        <div className={`panel p-3 mb-4 text-xs ${statusMsg.type === 'error' ? 'text-status-crit' : 'text-status-ok'}`} style={{ borderLeft: `3px solid ${statusMsg.type === 'error' ? '#F87171' : '#34D399'}` }}>
          <b>{statusMsg.title}</b>{statusMsg.message ? ` — ${statusMsg.message}` : ''}
        </div>
      )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'OME instance'}` : 'Add an OME instance'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          A VIEWER-role OME account is sufficient for inventory, alerts and warranty. Power/thermal/utilization
          metrics additionally need the Power Manager plugin on the appliance. The password is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Datacenter OME" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / FQDN</label>
            <input value={form.host} onChange={set('host')} placeholder="ome.company.com" className={inp} spellCheck={false} />
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
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add OME instance'}
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
              {testResult.message || testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          How far ahead of a device warranty's expiry the Overview and Governance pages raise a warning. Expired warranties are always critical.
        </p>
        <div className="flex items-end gap-3">
          <div className="w-56">
            <label className="block text-xs font-semibold text-ink mb-1">Warranty warning (days before expiry)</label>
            <input type="number" min={1} max={365} value={warrantyWarnDays}
              onChange={(e) => setWarrantyWarnDays(e.target.value)} className={inp} />
          </div>
          <button onClick={saveConfig} disabled={savingConfig || !warrantyWarnDays || Number(warrantyWarnDays) < 1 || Number(warrantyWarnDays) > 365}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered OME instances</p>
        {instances == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : instances.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No OME instances registered yet.</div>
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
          The Dell OME platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>
    </div>
  );
}
