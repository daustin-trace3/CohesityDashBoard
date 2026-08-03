import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Search, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const PROBE_SECTIONS = ['version', 'nodes', 'resources', 'guests', 'storage', 'tasks', 'backup', 'cluster', 'certificates', 'subscription'];

// Portal to <body> — the page wrapper's fade-in animation leaves a transform
// applied (fill-mode: both), which would re-anchor position:fixed to the
// page div and cut off the modal top on scrolled/short pages.
function ProbeModal({ server, onClose }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const runProbe = () => {
    setLoading(true);
    setError(false);
    setResult(null);
    client.get(`/proxmox/servers/${server.id}/probe`, { params: { sections: PROBE_SECTIONS.join(',') }, timeout: 120000 })
      .then(({ data }) => setResult(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { runProbe(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Search size={15} className="text-brand" /> Raw probe — {server.name}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Live fetch of every section against the Proxmox API — read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={runProbe} disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5">
            {loading && <Spinner size={12} />} Re-run
          </button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Probe failed — the server may be unreachable.</div>
          ) : loading || result == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : (
            <pre className="bg-surface-overlay rounded-lg p-3 text-[11px] text-ink-muted whitespace-pre-wrap break-all">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function PxSettingsPage() {
  const { toast } = useToast();
  const [servers, setServers] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', sslVerify: false, pollingIntervalMinutes: 10 });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [probeServer, setProbeServer] = useState(null);
  const [config, setConfig] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadServers = () => client.get('/proxmox/servers')
    .then(({ data }) => setServers(data))
    .catch(() => setServers([]));

  useEffect(() => {
    loadServers();
    client.get('/proxmox/config')
      .then(({ data }) => setConfig({
        storageWarnPct: String(data.storageWarnPct),
        storageCritPct: String(data.storageCritPct),
        backupStaleDays: String(data.backupStaleDays),
        certWarnDays: String(data.certWarnDays),
      }))
      .catch(() => setConfig({ storageWarnPct: '85', storageCritPct: '95', backupStaleDays: '3', certWarnDays: '30' }));
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const body = {
        storageWarnPct: Number(config.storageWarnPct),
        storageCritPct: Number(config.storageCritPct),
        backupStaleDays: Number(config.backupStaleDays),
        certWarnDays: Number(config.certWarnDays),
      };
      const { data } = await client.put('/proxmox/config', body);
      setConfig({
        storageWarnPct: String(data.storageWarnPct),
        storageCritPct: String(data.storageCritPct),
        backupStaleDays: String(data.backupStaleDays),
        certWarnDays: String(data.certWarnDays),
      });
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Enter valid threshold values.' });
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/proxmox/servers/test', {
        id: editingId || undefined,
        host: form.host.trim(), port: Number(form.port) || 8006, tokenId: form.tokenId.trim(),
        tokenSecret: form.tokenSecret || undefined, sslVerify: form.sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', sslVerify: false, pollingIntervalMinutes: 10 });
    setTestResult(null);
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 8006, tokenId: s.tokenId || '', tokenSecret: '',
      sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 10,
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const add = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), host: form.host.trim(), port: Number(form.port) || 8006,
        tokenId: form.tokenId.trim(), sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 10,
      };
      if (editingId) {
        // Blank secret = keep the stored one (omit from the PUT body).
        if (form.tokenSecret) body.tokenSecret = form.tokenSecret;
        await client.put(`/proxmox/servers/${editingId}`, body);
        toast({ type: 'success', title: 'Server updated', message: form.tokenSecret ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored token secret unchanged.' });
      } else {
        body.tokenSecret = form.tokenSecret;
        await client.post('/proxmox/servers', body);
        toast({ type: 'success', title: 'Server registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      blankForm();
      await loadServers();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Unregister Proxmox server "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/proxmox/servers/${s.id}`);
      await loadServers();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const refresh = async (s) => {
    setRefreshingId(s.id);
    try {
      await client.post(`/proxmox/servers/${s.id}/refresh`, {}, { timeout: 300000 });
      await loadServers();
      toast({ type: 'success', title: `${s.name} refreshed` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.tokenId.trim() && (editingId || form.tokenSecret);

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="Proxmox VE Settings" description="Register Proxmox VE servers — each is polled directly with its own API token" />

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'server'}` : 'Add a Proxmox server'}</p>
        <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
          An API token with PVEAuditor is sufficient for inventory. Token ID is the full <code>user@realm!name</code> string. The secret is encrypted at rest.
        </p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Proxmox Lab" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
            <input value={form.host} onChange={set('host')} placeholder="192.168.1.10" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Port</label>
            <input type="number" min={1} max={65535} value={form.port} onChange={set('port')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className={inp} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Token ID</label>
            <input value={form.tokenId} onChange={set('tokenId')} placeholder="monitor@pve!dashboard" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Token secret{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={form.tokenSecret} onChange={set('tokenSecret')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
          </div>
          <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={add} disabled={saving || !canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add server'}
          </button>
          {editingId && (
            <button onClick={cancelEdit}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
              Cancel
            </button>
          )}
          <button onClick={test} disabled={testing || !form.host.trim() || !form.tokenId.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-2">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {testResult.ok ? `Connected — PVE ${testResult.version}` : testResult.error}
            </span>
          )}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          Storage utilization warning/critical percentages, days without a successful backup before a guest is flagged stale, and days ahead of TLS certificate expiry to warn.
        </p>
        {config == null ? (
          <LoadingPanel label="Loading…" height={60} />
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <label className="block text-xs font-semibold text-ink mb-1">Storage warning (%)</label>
              <input type="number" min={1} max={100} value={config.storageWarnPct}
                onChange={(e) => setConfig(c => ({ ...c, storageWarnPct: e.target.value }))} className={inp} />
            </div>
            <div className="w-44">
              <label className="block text-xs font-semibold text-ink mb-1">Storage critical (%)</label>
              <input type="number" min={1} max={100} value={config.storageCritPct}
                onChange={(e) => setConfig(c => ({ ...c, storageCritPct: e.target.value }))} className={inp} />
            </div>
            <div className="w-44">
              <label className="block text-xs font-semibold text-ink mb-1">Backup stale (days)</label>
              <input type="number" min={1} max={365} value={config.backupStaleDays}
                onChange={(e) => setConfig(c => ({ ...c, backupStaleDays: e.target.value }))} className={inp} />
            </div>
            <div className="w-44">
              <label className="block text-xs font-semibold text-ink mb-1">Cert warning (days)</label>
              <input type="number" min={1} max={365} value={config.certWarnDays}
                onChange={(e) => setConfig(c => ({ ...c, certWarnDays: e.target.value }))} className={inp} />
            </div>
            <button onClick={saveConfig} disabled={savingConfig}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
              {savingConfig ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Registered Servers</p>
        {servers == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : servers.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Proxmox servers registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Token ID</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last Poll</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{s.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{s.host}:{s.port}</td>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{s.tokenId}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {s.lastPollStatus === 'error' && s.lastPollError && (
                        <p className="text-[10px] text-status-crit mt-0.5 max-w-[260px] truncate" title={s.lastPollError}>{s.lastPollError}</p>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => setProbeServer(s)} title="Raw probe" aria-label={`Probe ${s.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Search size={13} />
                        </button>
                        <button onClick={() => startEdit(s)} title="Edit connection / update credentials" aria-label={`Edit ${s.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(s)} disabled={refreshingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                          <RefreshCw size={13} className={refreshingId === s.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => remove(s)} title="Unregister" aria-label={`Unregister ${s.name}`}
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
          The Proxmox VE platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>

      {probeServer && <ProbeModal server={probeServer} onClose={() => setProbeServer(null)} />}
    </div>
  );
}
