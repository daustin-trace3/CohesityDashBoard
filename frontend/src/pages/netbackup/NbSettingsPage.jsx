import { useEffect, useState, useCallback } from 'react';
import { Settings, Cloud, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Plus, X, PlugZap, Save } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const TABS = [
  { key: 'alta', label: 'Alta (SaaS)', icon: Cloud, sourceType: 'alta' },
  { key: 'primary', label: 'Primary Servers (Direct)', icon: Server, sourceType: 'primary' },
];

const ALTA_EMPTY = { name: '', host: '', apiKey: '', pollingIntervalMinutes: 15 };
const PRIMARY_EMPTY = {
  name: '', host: '', port: 1556, authMode: 'password',
  username: '', domainName: '', domainType: '', password: '', apiKey: '',
  sslVerify: false, pollingIntervalMinutes: 15,
};

export default function NbSettingsPage() {
  const [tab, setTab] = useState('alta');
  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="NetBackup Settings" description="Register Alta (SaaS) or on-prem primary servers" />

      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start w-fit mb-4">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
              }`}>
              <Icon size={13} className={active ? 'text-brand' : ''} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'alta' ? <SourcesTab sourceType="alta" /> : <SourcesTab sourceType="primary" />}

      <AlertThresholdsPanel />
    </div>
  );
}

function SourcesTab({ sourceType }) {
  const { toast } = useToast();
  const [sources, setSources] = useState(null);
  const [form, setForm] = useState(sourceType === 'alta' ? { ...ALTA_EMPTY } : { ...PRIMARY_EMPTY });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(() => client.get('/netbackup/sources')
    .then(({ data }) => setSources((data.sources || []).filter(s => s.sourceType === sourceType)))
    .catch(() => setSources([])), [sourceType]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const blankForm = () => {
    setForm(sourceType === 'alta' ? { ...ALTA_EMPTY } : { ...PRIMARY_EMPTY });
    setTestResult(null);
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    if (sourceType === 'alta') {
      setForm({ name: s.name, host: s.host, apiKey: '', pollingIntervalMinutes: s.pollingIntervalMinutes || 15 });
    } else {
      setForm({
        name: s.name, host: s.host, port: s.port || 1556, authMode: s.authMode || 'password',
        username: s.username || '', domainName: s.domainName || '', domainType: s.domainType || '',
        password: '', apiKey: '', sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 15,
      });
    }
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const buildBody = () => {
    if (sourceType === 'alta') {
      const body = { name: form.name.trim(), sourceType: 'alta', host: form.host.trim(), authMode: 'apikey', pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15 };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      return body;
    }
    const body = {
      name: form.name.trim(), sourceType: 'primary', host: form.host.trim(), port: Number(form.port) || 1556,
      authMode: form.authMode, sslVerify: !!form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
    };
    if (form.authMode === 'password') {
      body.username = form.username.trim();
      if (form.domainName.trim()) body.domainName = form.domainName.trim();
      if (form.domainType.trim()) body.domainType = form.domainType.trim();
      if (form.password) body.password = form.password;
    } else {
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    }
    return body;
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await client.post('/netbackup/sources/test', buildBody());
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = buildBody();
      if (editingId) {
        await client.put(`/netbackup/sources/${editingId}`, body);
        toast({ type: 'success', title: 'Source updated' });
      } else {
        if (sourceType === 'primary' && form.authMode === 'password') body.password = form.password;
        if (sourceType === 'alta' || (sourceType === 'primary' && form.authMode === 'apikey')) body.apiKey = form.apiKey.trim();
        await client.post('/netbackup/sources', body);
        toast({ type: 'success', title: 'Source registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      blankForm();
      await load();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete source "${s.name}"? Its collected data is removed.`)) return;
    setDeletingId(s.id);
    try {
      await client.delete(`/netbackup/sources/${s.id}`);
      await load();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    } finally {
      setDeletingId(null);
    }
  };

  const refresh = async (s) => {
    setRefreshingId(s.id);
    try {
      await client.post(`/netbackup/sources/${s.id}/refresh`, {}, { timeout: 300000 });
      await load();
      toast({ type: 'success', title: `${s.name} refresh triggered` });
    } catch (err) {
      toast({ type: 'error', title: `Refresh failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = sourceType === 'alta'
    ? form.name.trim() && form.host.trim() && (editingId || form.apiKey.trim())
    : form.name.trim() && form.host.trim()
      && (form.authMode === 'apikey' ? (editingId || form.apiKey.trim()) : form.username.trim() && (editingId || form.password));

  return (
    <div>
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          {editingId ? <Pencil size={14} className="text-brand" /> : <Plus size={14} className="text-brand" />}
          {editingId ? `Edit — ${form.name || 'source'}` : sourceType === 'alta' ? 'Add an Alta (SaaS) source' : 'Add a primary server'}
        </p>
        {sourceType === 'alta' ? (
          <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
            Connects to a NetBackup Alta tenant via API key. No login step is required.
          </p>
        ) : (
          <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
            Connects directly to a NetBackup 11.x primary server's REST API. Credentials are encrypted at rest.
          </p>
        )}

        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
            <input value={form.name} onChange={set('name')} placeholder={sourceType === 'alta' ? 'Alta Prod' : 'Primary Server 1'} className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">{sourceType === 'alta' ? 'Tenant URL' : 'Host / FQDN'}</label>
            <input value={form.host} onChange={set('host')} placeholder={sourceType === 'alta' ? 'https://<tenant>.netbackup.alta.veritas.com/netbackup' : 'netbackup.company.com'} className={inp} spellCheck={false} />
          </div>

          {sourceType === 'alta' ? (
            <div>
              <label className="block text-xs font-semibold text-ink mb-1">API key{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
              <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Port</label>
                <input type="number" min={1} max={65535} value={form.port} onChange={set('port')} className={inp} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-ink mb-1">Auth mode</label>
                <select value={form.authMode} onChange={set('authMode')} className={inp}>
                  <option value="password">Username / password</option>
                  <option value="apikey">API key</option>
                </select>
              </div>
              {form.authMode === 'password' ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Username</label>
                    <input value={form.username} onChange={set('username')} className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Domain name</label>
                    <input value={form.domainName} onChange={set('domainName')} placeholder="Optional" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Domain type</label>
                    <input value={form.domainType} onChange={set('domainType')} placeholder="Optional" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
                    <input type="password" value={form.password} onChange={set('password')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-ink mb-1">API key{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
                  <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
                </div>
              )}
            </>
          )}

          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className={inp} />
          </div>
          {sourceType === 'primary' && (
            <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
              <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} className="accent-brand cursor-pointer" />
              <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
            </label>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={save} disabled={saving || !canSubmit}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            <Save size={14} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add source'}
          </button>
          {editingId && (
            <button onClick={cancelEdit}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer">
              <X size={14} /> Cancel
            </button>
          )}
          <button onClick={test} disabled={testing || !form.host.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer">
            {testing ? <Spinner size={13} /> : <PlugZap size={14} />} Test connection
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
        <p className="text-sm font-semibold text-ink mb-3">{sourceType === 'alta' ? 'Registered Alta Sources' : 'Registered Primary Servers'}</p>
        {sources == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : sources.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">None registered yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Host</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Last Poll</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink whitespace-nowrap">{s.name}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap max-w-[220px] truncate" title={s.host}>{s.host}</td>
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
                        <button onClick={() => startEdit(s)} title="Edit connection / update credentials" aria-label={`Edit ${s.name}`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => refresh(s)} disabled={refreshingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`}
                          className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
                          <RefreshCw size={13} className={refreshingId === s.id ? 'animate-spin' : ''} />
                        </button>
                        <button onClick={() => remove(s)} disabled={deletingId === s.id} title="Delete" aria-label={`Delete ${s.name}`}
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
      </div>
    </div>
  );
}

function AlertThresholdsPanel() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [successWarnPct, setSuccessWarnPct] = useState('');
  const [storageWarnPct, setStorageWarnPct] = useState('');
  const [staleBackupHours, setStaleBackupHours] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client.get('/netbackup/config')
      .then(({ data }) => {
        setCfg(data);
        setSuccessWarnPct(String(data.successWarnPct));
        setStorageWarnPct(String(data.storageWarnPct));
        setStaleBackupHours(String(data.staleBackupHours));
      })
      .catch(() => setCfg({ successWarnPct: 90, storageWarnPct: 20, staleBackupHours: 48 }));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await client.put('/netbackup/config', {
        successWarnPct: Number(successWarnPct), storageWarnPct: Number(storageWarnPct), staleBackupHours: Number(staleBackupHours),
      });
      setCfg(data);
      setSuccessWarnPct(String(data.successWarnPct));
      setStorageWarnPct(String(data.storageWarnPct));
      setStaleBackupHours(String(data.staleBackupHours));
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Check the entered values.' });
    } finally {
      setSaving(false);
    }
  };

  if (cfg == null) {
    return (
      <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <LoadingPanel label="Loading thresholds…" height={80} />
      </div>
    );
  }

  return (
    <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
      <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
        Thresholds that drive the computed issues feed — success rate, storage headroom and stale-backup detection.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <div>
          <label className="block text-xs font-semibold text-ink mb-1">Success rate warning % (50–100)</label>
          <input type="number" min={50} max={100} value={successWarnPct} onChange={(e) => setSuccessWarnPct(e.target.value)} className={inp} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink mb-1">Storage free warning % (5–50)</label>
          <input type="number" min={5} max={50} value={storageWarnPct} onChange={(e) => setStorageWarnPct(e.target.value)} className={inp} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink mb-1">Stale backup hours (12–336)</label>
          <input type="number" min={12} max={336} value={staleBackupHours} onChange={(e) => setStaleBackupHours(e.target.value)} className={inp} />
        </div>
      </div>
      <button onClick={save} disabled={saving}
        className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
