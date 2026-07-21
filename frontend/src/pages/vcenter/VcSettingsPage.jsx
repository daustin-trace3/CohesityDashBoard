import { useEffect, useState } from 'react';
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export default function VcSettingsPage() {
  const { toast } = useToast();
  const [vcs, setVcs] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);

  const loadVcs = () => client.get('/vcenter/vcenters')
    .then(({ data }) => setVcs(data))
    .catch(() => setVcs([]));

  useEffect(() => { loadVcs(); }, []);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/vcenter/vcenters/test', {
        host: form.host.trim(), username: form.username.trim(),
        password: form.password || undefined, sslVerify: form.sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const add = async () => {
    setSaving(true);
    try {
      await client.post('/vcenter/vcenters', {
        name: form.name.trim(), host: form.host.trim(), username: form.username.trim(),
        password: form.password, sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      });
      setForm({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
      setTestResult(null);
      await loadVcs();
      toast({ type: 'success', title: 'vCenter registered', message: 'First poll started — data appears shortly.' });
    } catch (err) {
      toast({ type: 'error', title: 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (vc) => {
    if (!window.confirm(`Unregister vCenter "${vc.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/vcenter/vcenters/${vc.id}`);
      await loadVcs();
      toast({ type: 'success', title: `Removed ${vc.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const refresh = async (vc) => {
    setRefreshingId(vc.id);
    try {
      await client.post(`/vcenter/vcenters/${vc.id}/refresh`, {}, { timeout: 300000 });
      await loadVcs();
      toast({ type: 'success', title: `${vc.name} refreshed` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${vc.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && form.password;

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="vCenter Settings" description="Register vCenter servers — each is polled directly with its own credentials" />

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> Add a vCenter</p>
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
            <label className="block text-xs font-semibold text-ink mb-1">Password</label>
            <input type="password" value={form.password} onChange={set('password')} className={inp} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Adding…' : 'Add vCenter'}
          </button>
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
