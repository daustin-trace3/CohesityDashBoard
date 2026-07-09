import { useEffect, useState, useCallback } from 'react';
import { Settings, Save, PlugZap, Play, Server, Clock, Cloud, Plus, Pencil, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, Badge, RefreshButton } from '../../components/ui/primitives';
import { BRAND } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

const TABS = [
  { key: 'aiqum', label: 'AIQUM (Unified Manager)', icon: Cloud },
  { key: 'direct', label: 'Direct Clusters', icon: Server },
];

const emptyDirectForm = { name: '', mgmt_host: '', username: '', password: '', polling_interval_minutes: 15, ssl_verify: false };

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-ink-faint mt-1">{hint}</p>}
    </div>
  );
}

function shortVersion(v) {
  const m = String(v || '').match(/(\d+\.\d+\.\d+\S*)/);
  return m ? m[1] : (v || '—');
}

export default function NetAppSettingsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState('aiqum');
  const [cfg, setCfg] = useState(null);
  const [clusters, setClusters] = useState(null);
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [interval, setIntervalMin] = useState(15);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollingId, setPollingId] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const [directMode, setDirectMode] = useState(null); // null | 'add' | { edit: row }
  const [directForm, setDirectForm] = useState(emptyDirectForm);
  const [directSaving, setDirectSaving] = useState(false);
  const [directTesting, setDirectTesting] = useState(false);
  const [directTestResult, setDirectTestResult] = useState(null);
  const [directError, setDirectError] = useState(null);
  const [directDeleting, setDirectDeleting] = useState(null);

  const load = useCallback(() => Promise.allSettled([
    client.get('/netapp/aiqum'),
    client.get('/netapp/arrays'),
  ]).then(([c, a]) => {
    if (c.status === 'fulfilled') {
      setCfg(c.value.data);
      setHost(c.value.data.host || '');
      // Username is write-only: the server reports presence, never the value.
      setUsername('');
      setIntervalMin(c.value.data.pollIntervalMin || 15);
    } else { setCfg({ configured: false }); toast({ type: 'error', title: 'Failed to load AIQUM config' }); }
    setClusters(a.status === 'fulfilled' ? a.value.data : []);
  }), [toast]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const patch = { host, pollIntervalMin: Number(interval) };
      if (username.trim()) patch.username = username.trim();
      if (password) patch.password = password;
      await client.put('/netapp/aiqum', patch);
      setPassword('');
      toast({ type: 'success', title: 'AIQUM settings saved' });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save.' });
    } finally { setSaving(false); }
  };

  const testConn = async () => {
    setTesting(true); setTestResult(null);
    try {
      const { data } = await client.post('/netapp/aiqum/test', { host, username: username.trim() || undefined, password: password || undefined });
      setTestResult(data.ok ? { ok: true, msg: `Connected · ${data.clusterCount} clusters managed (${(data.clusters || []).join(', ')})` } : { ok: false, msg: data.error });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.response?.data?.error || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const pollAll = async () => {
    setPolling(true);
    try { await client.post('/netapp/poll'); toast({ type: 'success', title: 'Discovery + poll triggered' }); setTimeout(load, 1500); }
    catch (err) { toast({ type: 'error', title: 'Poll failed', message: err?.response?.data?.error || 'Poll failed.' }); }
    finally { setPolling(false); }
  };

  const pollOne = async (c) => {
    setPollingId(c.id);
    try { await client.post(`/netapp/arrays/${c.id}/poll`); toast({ type: 'success', title: 'Poll triggered', message: c.name }); }
    catch (err) { toast({ type: 'error', title: 'Poll failed', message: err?.response?.data?.error || 'Poll failed.' }); }
    finally { setPollingId(null); }
  };

  const directRows = (clusters || []).filter((c) => c.source === 'direct');
  const setDF = (key, val) => setDirectForm((f) => ({ ...f, [key]: val }));

  const openAddDirect = () => { setDirectMode('add'); setDirectForm(emptyDirectForm); setDirectTestResult(null); setDirectError(null); };
  const openEditDirect = (row) => {
    setDirectMode({ edit: row });
    setDirectForm({ name: row.name, mgmt_host: row.mgmt_host, username: '', password: '', polling_interval_minutes: row.polling_interval_minutes || 15, ssl_verify: !!row.ssl_verify });
    setDirectTestResult(null); setDirectError(null);
  };
  const closeDirectForm = () => setDirectMode(null);

  const canSaveDirect = directForm.name.trim() && directForm.mgmt_host.trim() && (directMode !== 'add' || (directForm.username.trim() && directForm.password));
  const canTestDirect = directForm.mgmt_host.trim() && (directForm.password || directMode !== 'add');

  const directSave = async () => {
    setDirectSaving(true); setDirectError(null);
    const isEdit = directMode !== 'add';
    const payload = {
      name: directForm.name.trim(),
      mgmt_host: directForm.mgmt_host.trim(),
      polling_interval_minutes: Number(directForm.polling_interval_minutes) || 15,
      ssl_verify: !!directForm.ssl_verify,
    };
    if (!isEdit || directForm.username.trim()) payload.username = directForm.username.trim();
    if (!isEdit || directForm.password) payload.password = directForm.password;
    try {
      if (isEdit) await client.put(`/netapp/arrays/${directMode.edit.id}`, payload);
      else await client.post('/netapp/arrays', payload);
      toast({ type: 'success', title: isEdit ? 'Cluster updated' : 'Cluster added', message: payload.name });
      setDirectMode(null);
      load();
    } catch (err) {
      setDirectError(err?.response?.data?.error || 'Save failed.');
    } finally { setDirectSaving(false); }
  };

  const directTest = async () => {
    setDirectTesting(true); setDirectTestResult(null);
    try {
      const payload = {
        mgmt_host: directForm.mgmt_host.trim(),
        username: directForm.username.trim() || undefined,
        password: directForm.password || undefined,
        ssl_verify: !!directForm.ssl_verify,
      };
      if (directMode !== 'add' && !directForm.password) payload.id = directMode.edit.id;
      const { data } = await client.post('/netapp/arrays/test', payload);
      setDirectTestResult(data.ok ? { ok: true, msg: `Connected · ONTAP ${data.version || '—'} (${data.name || directForm.name})` } : { ok: false, msg: data.error });
    } catch (err) {
      setDirectTestResult({ ok: false, msg: err?.response?.data?.error || 'Connection failed' });
    } finally { setDirectTesting(false); }
  };

  const directDelete = async (row) => {
    if (!window.confirm('Removing a cluster deletes its collected history.')) return;
    setDirectDeleting(row.id);
    try {
      await client.delete(`/netapp/arrays/${row.id}`);
      toast({ type: 'success', title: 'Cluster removed', message: row.name });
      load();
    } catch (err) {
      toast({ type: 'error', title: 'Delete failed', message: err?.response?.data?.error || 'Delete failed.' });
    } finally { setDirectDeleting(null); }
  };

  if (cfg == null) {
    return (
      <div className="animate-fade-in max-w-3xl">
        <PageHeader icon={Settings} title="NetApp Settings" description="Active IQ Unified Manager connection" />
        <LoadingPanel label="Loading settings…" height={160} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="NetApp Settings" description="Manage AIQUM and direct ONTAP cluster connections">
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start mb-4">
        {TABS.map((t) => {
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

      {tab === 'aiqum' && (
        <>
          {/* Connection status */}
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-3"><Cloud size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Active IQ Unified Manager</p></div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm mb-3">
              <span className="flex items-center gap-2">Status: {cfg.configured ? <Badge tone="ok">Connected</Badge> : <Badge tone="crit">Not configured</Badge>}</span>
              <span className="text-ink-muted">Clusters managed: <span className="text-ink tnum">{cfg.clusterCount ?? 0}</span></span>
              <span className="text-ink-muted">Config source: <span className="text-ink">{cfg.hostSource}</span></span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="AIQUM host" hint="Base URL of the Unified Manager appliance.">
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://aiqum.example.com" className={inp} spellCheck={false} />
              </Field>
              <Field label="Username" hint={`AIQUM account (Operator/read-only is sufficient). ${cfg.hasUsername ? 'A username is on file — leave blank to keep it.' : 'Required.'}`}>
                <input type="password" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={cfg.hasUsername ? '•••••• (unchanged)' : 'operator'} className={inp} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Password" hint={`Stored encrypted. ${cfg.hasPassword ? 'A password is on file — leave blank to keep it.' : 'Required.'}`}>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={cfg.hasPassword ? '•••••• (unchanged)' : '••••••'} className={inp} autoComplete="new-password" />
              </Field>
              <Field label="Poll interval (min)" hint="How often to discover clusters and collect data.">
                <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={5} max={1440} value={interval} onChange={(e) => setIntervalMin(e.target.value)} className={inp} /></div>
              </Field>
            </div>
            <p className="text-[11px] text-ink-faint mt-2">
              Requires an AIQUM user with at least the Operator role (Settings → Users in Unified Manager).{' '}
              <a href="https://docs.netapp.com/us-en/active-iq-unified-manager/" target="_blank" rel="noreferrer" className="underline hover:text-ink">AIQUM documentation</a>
            </p>
            {testResult && <p className={`text-[12px] mt-2 ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.ok ? '✓ ' : '✗ '}{testResult.msg}</p>}
            <div className="flex items-center gap-2 mt-3">
              <button onClick={testConn} disabled={testing || !host || (!username.trim() && !cfg.hasUsername)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
                <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button onClick={save} disabled={saving || !host || (!username.trim() && !cfg.hasUsername)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
                <Save size={13} /> {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={pollAll} disabled={polling || !cfg.configured}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 ml-auto">
                <Play size={13} /> {polling ? 'Collecting…' : 'Discover + poll now'}
              </button>
            </div>
          </div>

          {/* Managed clusters (read-only, discovered from AIQUM) */}
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-3"><Server size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Managed Clusters</p></div>
            {clusters == null ? (
              <LoadingPanel label="Loading clusters…" height={100} />
            ) : clusters.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No clusters discovered yet. Save a valid AIQUM connection, then “Discover + poll now”.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">ONTAP</th><th className="py-2 pr-3">Management IP</th><th className="py-2 pr-3">Source</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {clusters.map((c) => (
                      <tr key={c.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{shortVersion(c.version)}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{c.management_ip || '—'}</td>
                        <td className="py-2 pr-3"><Badge tone="info">{c.source === 'aiqum' ? 'AIQUM gateway' : c.source}</Badge></td>
                        <td className="py-2 pr-3 text-right">
                          <button onClick={() => pollOne(c)} disabled={pollingId === c.id}
                            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
                            <Play size={12} /> {pollingId === c.id ? 'Polling…' : 'Poll'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-ink-faint mt-3">Clusters are discovered automatically from AIQUM — there is no per-cluster registration. Removing a cluster from AIQUM removes it here on the next poll.</p>
          </div>
        </>
      )}

      {tab === 'direct' && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2"><Server size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Direct ONTAP Clusters</p></div>
            {!directMode && (
              <button onClick={openAddDirect}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors">
                <Plus size={13} /> Add cluster
              </button>
            )}
          </div>

          {directMode && (
            <div className="border border-cohesity-border rounded-lg p-3 mb-4">
              <p className="text-xs font-semibold text-ink mb-3">{directMode === 'add' ? 'Add direct cluster' : `Edit — ${directMode.edit.name}`}</p>
              {directError && <p className="text-[12px] text-status-crit mb-2">{directError}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name">
                  <input value={directForm.name} onChange={(e) => setDF('name', e.target.value)} className={inp} />
                </Field>
                <Field label="Management host">
                  <input value={directForm.mgmt_host} onChange={(e) => setDF('mgmt_host', e.target.value)} placeholder="https://cluster-mgmt.example.com" className={inp} spellCheck={false} />
                </Field>
                <Field label="Username" hint={directMode !== 'add' ? 'Leave blank to keep the stored username.' : undefined}>
                  <input value={directForm.username} onChange={(e) => setDF('username', e.target.value)} placeholder={directMode !== 'add' ? '•••••• (stored — leave blank to keep)' : ''} className={inp} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Password">
                  <input type="password" value={directForm.password} onChange={(e) => setDF('password', e.target.value)} placeholder={directMode !== 'add' ? '•••••• (stored — leave blank to keep)' : '••••••'} className={inp} autoComplete="new-password" />
                </Field>
                <Field label="Poll interval (min)">
                  <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={5} value={directForm.polling_interval_minutes} onChange={(e) => setDF('polling_interval_minutes', e.target.value)} className={inp} /></div>
                </Field>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
                    <input type="checkbox" checked={directForm.ssl_verify} onChange={(e) => setDF('ssl_verify', e.target.checked)} className="accent-brand cursor-pointer" />
                    Verify TLS certificate
                  </label>
                </div>
              </div>

              <p className="text-[11px] text-ink-faint mt-3">
                Connects to the cluster management LIF over the ONTAP REST API. Requires a cluster account with the &lsquo;http&rsquo; application enabled
                and a read-only role — create one with <code>security login create</code> or the ONTAP REST API.{' '}
                <a href="https://docs.netapp.com/us-en/ontap-restapi/ontap/post-security-accounts.html" target="_blank" rel="noreferrer" className="underline hover:text-ink">Creating ONTAP accounts (REST)</a>
                {' · '}
                <a href="https://docs.netapp.com/us-en/ontap-automation/rest/rbac_overview.html" target="_blank" rel="noreferrer" className="underline hover:text-ink">ONTAP REST RBAC overview</a>
              </p>

              {directTestResult && <p className={`text-[12px] mt-2 ${directTestResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{directTestResult.ok ? '✓ ' : '✗ '}{directTestResult.msg}</p>}

              <div className="flex items-center gap-2 mt-3">
                <button onClick={directTest} disabled={directTesting || !canTestDirect}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
                  <PlugZap size={13} /> {directTesting ? 'Testing…' : 'Test connection'}
                </button>
                <button onClick={directSave} disabled={directSaving || !canSaveDirect}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
                  <Save size={13} /> {directSaving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={closeDirectForm}
                  className="text-xs font-medium px-3.5 py-2 text-ink-faint hover:text-ink transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {directRows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No direct clusters configured yet. Add one to connect a standalone ONTAP cluster.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Management host</th><th className="py-2 pr-3">ONTAP</th><th className="py-2 pr-3">Poll interval</th><th className="py-2 pr-3">TLS</th><th className="py-2 pr-3"></th>
                </tr></thead>
                <tbody>
                  {directRows.map((c) => (
                    <tr key={c.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{c.mgmt_host}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{shortVersion(c.version)}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{c.polling_interval_minutes}m</td>
                      <td className="py-2 pr-3">{c.ssl_verify ? <Badge tone="ok">Verified</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                      <td className="py-2 pr-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button onClick={() => pollOne(c)} disabled={pollingId === c.id}
                            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
                            <Play size={12} /> {pollingId === c.id ? 'Polling…' : 'Poll'}
                          </button>
                          <button onClick={() => openEditDirect(c)}
                            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors">
                            <Pencil size={12} /> Edit
                          </button>
                          <button onClick={() => directDelete(c)} disabled={directDeleting === c.id}
                            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-status-crit hover:border-status-crit/40 transition-colors disabled:opacity-40">
                            <Trash2 size={12} /> {directDeleting === c.id ? 'Removing…' : 'Delete'}
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
      )}
    </div>
  );
}
