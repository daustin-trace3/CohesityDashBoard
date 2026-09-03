import { useCallback, useEffect, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Link2, Link2Off, Plug, RefreshCw, Search, Save } from 'lucide-react';
import client from '../api/client';
import { Badge, LastUpdated } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

// Active Directory tab on Users & Access (2026-09-03). Minimal input by
// design: domain + one approved account. Everything else (domain controllers,
// base DN, TLS) is discovered; the Advanced block only overrides.

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

function Section({ title, hint, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-xs font-semibold text-ink">{title}</p>
        {hint && <p className="text-[11px] text-ink-muted leading-relaxed mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export default function DirectoryTab() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [links, setLinks] = useState([]);
  const [sync, setSync] = useState({ running: false, runs: [] });
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

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
    client.get('/directory/links').then(({ data }) => setLinks(data)).catch(() => {});
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
    // The test uses the SAVED account, so persist first when anything changed.
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

  const search = async () => {
    setSearching(true);
    try {
      const { data } = await client.get('/directory/groups', { params: { q } });
      setResults(data);
    } catch (err) {
      toast({ type: 'error', title: 'Directory search failed', message: errorMessage(err, '') });
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const link = async (g) => {
    try {
      await client.post('/directory/links', { dn: g.dn });
      toast({ type: 'success', title: `Linked ${g.name}`, message: 'Members are being pulled in. Grant the group platform access on the Groups tab.' });
      setResults((r) => (r || []).map((x) => (x.dn === g.dn ? { ...x, linked: true } : x)));
      loadAll();
    } catch (err) {
      toast({ type: 'error', title: 'Could not link group', message: errorMessage(err, '') });
    }
  };

  const unlink = async (l) => {
    if (!window.confirm(`Unlink "${l.name}"? Its grants are removed; users stay but lose access from this group.`)) return;
    try {
      await client.delete(`/directory/links/${l.id}`);
      toast({ type: 'success', title: 'Group unlinked' });
      loadAll();
    } catch (err) {
      toast({ type: 'error', title: 'Could not unlink', message: errorMessage(err, '') });
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
              <Badge tone={cfg?.configured ? 'ok' : 'neutral'}>{cfg?.configured ? 'Enabled' : form.enabled ? 'Incomplete' : 'Off'}</Badge>
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">
              Give ICC a domain name and one approved account. Domain controllers, the search base and TLS are discovered.
              Link AD groups below, then grant them platform access on the Groups tab. Local accounts keep working as break-glass.
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
                <input type="checkbox" checked={form.deactivateRemoved} onChange={set('deactivateRemoved')} className="accent-brand cursor-pointer" /> Deactivate users removed from every linked group
              </label>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-semibold text-ink mb-1 block">CA certificate (PEM) <span className="text-ink-faint font-normal">(optional, for a private CA)</span></label>
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

      <div className="panel p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Section title="Linked AD groups" hint="Each linked group becomes an ICC group whose members are pulled from the domain. Access is granted per group on the Groups tab." />
          <div className="flex items-center gap-2">
            {lastRun && (
              <span className="text-[11px] text-ink-faint tnum">
                Last sync {lastRun.status === 'ok' ? 'ok' : lastRun.status}{lastRun.finished_at ? <> <LastUpdated date={lastRun.finished_at} prefix="" /></> : ''}
                {lastRun.status === 'ok' ? `, ${lastRun.users_seen} users` : ''}
              </span>
            )}
            <button onClick={runSync} disabled={syncing || sync.running || !cfg?.configured}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
              <RefreshCw size={12} className={syncing || sync.running ? 'animate-spin' : ''} /> Sync now
            </button>
          </div>
        </div>
        {lastRun?.status === 'error' && <p className="text-xs text-status-crit bg-status-crit/10 border border-status-crit/30 rounded-lg px-3 py-2">{lastRun.message}</p>}
        {lastRun?.status === 'ok' && lastRun.message && <p className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-lg px-3 py-2">{lastRun.message}</p>}

        {links.length === 0 ? (
          <p className="text-[11px] text-ink-faint">No AD groups linked yet.</p>
        ) : (
          <div className="border border-cohesity-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-cohesity-border text-ink-faint text-[10px] uppercase tracking-wider">
                  <th className="text-left px-3 py-2 font-semibold">ICC group</th>
                  <th className="text-left px-3 py-2 font-semibold">AD group</th>
                  <th className="text-left px-3 py-2 font-semibold">Members</th>
                  <th className="text-left px-3 py-2 font-semibold">Synced</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id} className="border-b border-cohesity-border/50 last:border-0">
                    <td className="px-3 py-2 text-ink font-medium">{l.name}</td>
                    <td className="px-3 py-2 text-ink-muted" title={l.externalDn}>{l.externalName}</td>
                    <td className="px-3 py-2 text-ink-muted tnum">{l.memberCount}</td>
                    <td className="px-3 py-2 text-ink-faint">{l.syncedAt ? <LastUpdated date={l.syncedAt} prefix="" /> : 'pending'}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => unlink(l)} aria-label={`Unlink ${l.name}`} className="text-ink-faint hover:text-status-crit cursor-pointer"><Link2Off size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-cohesity-border/60 pt-3">
          <p className="text-xs font-semibold text-ink mb-1.5">Add an AD group</p>
          <div className="flex items-center gap-2 max-w-lg">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
              <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
                placeholder="Group name contains..." className={`${inputClass} pl-8`} disabled={!cfg?.configured} />
            </div>
            <button onClick={search} disabled={searching || !cfg?.configured}
              className="text-xs font-medium px-3 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>
          {!cfg?.configured && <p className="text-[11px] text-ink-faint mt-1.5">Save a working connection first.</p>}
          {results && (
            <div className="mt-2 border border-cohesity-border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
              {results.length === 0 && <p className="text-[11px] text-ink-faint px-3 py-2">No groups matched.</p>}
              {results.map((g) => (
                <div key={g.dn} className="flex items-center gap-3 px-3 py-2 border-b border-cohesity-border/50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-ink font-medium truncate">{g.name}</p>
                    <p className="text-[10px] text-ink-faint truncate" title={g.dn}>{g.description || g.dn}</p>
                  </div>
                  {g.linked ? (
                    <Badge tone="ok">linked</Badge>
                  ) : (
                    <button onClick={() => link(g)} className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
                      <Link2 size={11} /> Link
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
