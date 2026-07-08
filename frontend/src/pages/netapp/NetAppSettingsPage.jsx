import { useEffect, useState, useCallback } from 'react';
import { Settings, RefreshCw, Save, PlugZap, Play, Server, Clock, Cloud } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, Badge } from '../../components/ui/primitives';
import { BRAND } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

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
      <PageHeader icon={Settings} title="NetApp Settings" description="Collect all clusters through Active IQ Unified Manager (AIQUM)">
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

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
    </div>
  );
}
