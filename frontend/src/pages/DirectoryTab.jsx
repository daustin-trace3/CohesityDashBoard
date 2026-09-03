import { useCallback, useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Plug, RefreshCw, Save } from 'lucide-react';
import client from '../api/client';
import { Badge, LastUpdated } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

// Active Directory tab on Users & Access (2026-09-03). Connection only:
// domain + one approved account, everything else discovered. AD users and
// groups are added from the Users and Groups tabs by name (the source
// toggle on their create dialogs), so nothing directory-specific is listed
// here beyond the sync status.

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

export default function DirectoryTab() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [sync, setSync] = useState({ running: false, runs: [] });
  const [syncing, setSyncing] = useState(false);
  const [linkCount, setLinkCount] = useState(0);

  const loadAll = useCallback(() => {
    client.get('/directory/config').then(({ data }) => {
      setCfg(data);
      setForm({
        enabled: !!data.enabled, domain: data.domain || '', bindUser: data.bindUser || '', bindPassword: '',
        servers: (data.servers || []).join(', '), baseDn: data.baseDn || '', tlsMode: data.tlsMode || 'auto',
        tlsVerify: data.tlsVerify !== false, caCert: data.caCert || '', syncIntervalMinutes: data.syncIntervalMinutes || 60,
        deactivateRemoved: data.deactivateRemoved !== false,
      });
    }).catch(() => {});
    client.get('/directory/links').then(({ data }) => setLinkCount(data.length)).catch(() => {});
    client.get('/directory/sync/status').then(({ data }) => setSync(data)).catch(() => {});
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const save = async (overrides = {}) => {
    setSaving(true);
    try {
      const body = { ...form, ...overrides, servers: form.servers.split(/[\s,;]+/).filter(Boolean) };
      if (!body.bindPassword) delete body.bindPassword;
      const { data } = await client.put('/directory/config', body);
      setCfg(data);
      setForm((f) => ({ ...f, bindPassword: '' }));
      toast({ type: 'success', title: 'Directory settings saved' });
      return true;
    } catch (err) {
      toast({ type: 'error', title: 'Could not save', message: errorMessage(err, 'Check the values and try again.') });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setReport(null);
    const ok = await save();
    if (!ok) { setTesting(false); return; }
    try {
      const { data } = await client.post('/directory/test');
      setReport(data);
    } catch (err) {
      setReport(err?.response?.data || { ok: false, error: errorMessage(err, 'Test failed.') });
    } finally {
      setTesting(false);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const { data } = await client.post('/directory/sync');
      toast({ type: data.status === 'ok' ? 'success' : 'error', title: data.status === 'ok' ? 'Sync complete' : 'Sync failed', message: data.message || `${data.seen ?? 0} users across ${data.groups ?? 0} groups` });
    } catch (err) {
      toast({ type: 'error', title: 'Sync failed', message: errorMessage(err, '') });
    } finally {
      setSyncing(false);
      loadAll();
    }
  };

  if (!form) return <p className="text-xs text-ink-faint">Loading...</p>;
  const lastRun = sync.runs?.[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0"><Building2 size={15} className="text-brand" /></span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-ink flex items-center gap-2">
              Active Directory
              <Badge tone={cfg?.configured ? 'ok' : 'neutral'}>{cfg?.configured ? 'Connected' : form.enabled ? 'Incomplete' : 'Off'}</Badge>
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
              Give ICC a domain name and one approved account. Domain controllers, the search base and TLS are discovered.
              Then add domain users and groups by name from the Users and Groups tabs. Local accounts keep working as break-glass.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-ink">
            <input type="checkbox" checked={form.enabled} onChange={set('enabled')} className="accent-brand cursor-pointer" /> Enable domain sign-in
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">Domain</label>
            <input value={form.domain} onChange={set('domain')} placeholder="corp.example.com" className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">Approved account</label>
            <input value={form.bindUser} onChange={set('bindUser')} placeholder="svc-icc or svc-icc@corp.example.com" className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label className="text-xs font-semibold text-ink mb-1 block">
              Password {cfg?.bindPasswordSource === 'settings' && <span className="text-ink-faint font-normal">(saved, leave blank to keep)</span>}
            </label>
            <input type="password" value={form.bindPassword} onChange={set('bindPassword')} className={inputClass} autoComplete="new-password" />
          </div>
        </div>

        <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink cursor-pointer self-start">
          {advanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Advanced (only when discovery needs a hand)
        </button>
        {advanced && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-cohesity-border/60 pt-3">
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Domain controllers <span className="text-ink-faint font-normal">(optional, comma separated)</span></label>
              <input value={form.servers} onChange={set('servers')} placeholder="dc1.corp.example.com, ldaps://dc2.corp.example.com:636" className={inputClass} />
              <p className="text-[10px] text-ink-faint mt-1">Blank = DNS SRV discovery. A scheme pins transport: ldaps://, starttls://, or ldap:// for plain (lab only).</p>
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Search base DN <span className="text-ink-faint font-normal">(optional)</span></label>
              <input value={form.baseDn} onChange={set('baseDn')} placeholder="dc=corp,dc=example,dc=com" className={inputClass} />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Transport</label>
              <select value={form.tlsMode} onChange={set('tlsMode')} className={inputClass}>
                <option value="auto">Auto (LDAPS 636, then StartTLS 389)</option>
                <option value="ldaps">LDAPS only</option>
                <option value="starttls">StartTLS only</option>
              </select>
            </div>
            <div className="flex flex-col gap-2 justify-end">
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-ink">
                <input type="checkbox" checked={form.tlsVerify} onChange={set('tlsVerify')} className="accent-brand cursor-pointer" /> Verify the domain controller certificate
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-ink">
                <input type="checkbox" checked={form.deactivateRemoved} onChange={set('deactivateRemoved')} className="accent-brand cursor-pointer" /> Deactivate group-synced users removed from every linked group
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-semibold text-ink mb-1 block">CA certificate (PEM) <span className="text-ink-faint font-normal">(optional, for a private CA or a self-signed DC certificate)</span></label>
              <textarea value={form.caCert} onChange={set('caCert')} rows={3} className={`${inputClass} font-mono`} placeholder="-----BEGIN CERTIFICATE-----" />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink mb-1 block">Sync every (minutes)</label>
              <input type="number" min={5} max={1440} value={form.syncIntervalMinutes} onChange={set('syncIntervalMinutes')} className={inputClass} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button onClick={() => save()} disabled={saving}
            className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40 cursor-pointer">
            <Save size={13} /> {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={test} disabled={testing || saving || !form.domain || !form.bindUser}
            className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
            <Plug size={13} /> {testing ? 'Testing...' : 'Save and test connection'}
          </button>
        </div>

        {report && (
          <div className={`text-xs rounded-lg px-3 py-2 border ${report.ok ? 'bg-status-ok/10 border-status-ok/30 text-ink' : 'bg-status-crit/10 border-status-crit/30 text-status-crit'}`}>
            {report.ok ? (
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-status-ok">Connected</span>
                <span className="text-ink-muted">Bound as {report.boundAs} via {report.url}. Search base {report.baseDn}. {report.userCount != null ? `${report.userCount} user objects visible.` : ''}</span>
                {report.servers?.length > 0 && <span className="text-ink-faint">Domain controllers: {report.servers.join(', ')}</span>}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold">Not connected</span>
                <span>{report.error}</span>
                {report.servers?.length > 0 && <span className="text-ink-faint">Tried: {report.servers.join(', ')}</span>}
                {report.servers?.length === 0 && <span className="text-ink-faint">No domain controllers were discovered. Check DNS from this host or list them under Advanced.</span>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="panel p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink">Group sync</p>
          <p className="text-[11px] text-ink-muted mt-0.5">
            {linkCount} domain group{linkCount === 1 ? '' : 's'} mirrored from the Groups tab.
            {lastRun ? (
              <> Last sync {lastRun.status === 'ok' ? 'succeeded' : lastRun.status}{lastRun.finished_at ? <> <LastUpdated date={lastRun.finished_at} prefix="" /></> : ''}{lastRun.status === 'ok' ? `, ${lastRun.users_seen} users across ${lastRun.groups_synced} groups.` : '.'}</>
            ) : ' No sync has run yet.'}
          </p>
          {lastRun?.status === 'error' && <p className="text-xs text-status-crit mt-1">{lastRun.message}</p>}
          {lastRun?.status === 'ok' && lastRun.message && <p className="text-xs text-status-warn mt-1">{lastRun.message}</p>}
        </div>
        <button onClick={runSync} disabled={syncing || sync.running || !cfg?.configured}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
          <RefreshCw size={12} className={syncing || sync.running ? 'animate-spin' : ''} /> Sync now
        </button>
      </div>
    </div>
  );
}
