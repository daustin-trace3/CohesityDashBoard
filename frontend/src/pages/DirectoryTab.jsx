import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plug, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import client from '../api/client';
import { Badge, LastUpdated } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { Drawer, btnPrimary, btnPlain } from './idpShared';

// Active Directory section of Users & Access > Identity providers. Presented
// like the Okta section (2026-11-08): a header with an Add button, an empty
// state, and one card for the configured domain whose Enabled toggle, edit
// pencil and remove icon match the Okta cards. The connection form (domain +
// one approved account, everything else discovered) lives in the drawer.
// AD users and groups are added from the Users and Groups tabs by name.

const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
const errorMessage = (err, fallback) => err?.response?.data?.error || fallback;

function formFromConfig(data) {
  return {
    domain: data.domain || '', bindUser: data.bindUser || '', bindPassword: '',
    servers: (data.servers || []).join(', '), baseDn: data.baseDn || '', tlsMode: data.tlsMode || 'auto',
    tlsVerify: data.tlsVerify !== false, caCert: data.caCert || '', syncIntervalMinutes: data.syncIntervalMinutes || 60,
    deactivateRemoved: data.deactivateRemoved !== false,
  };
}

function bindLabel(cfg) {
  if (!cfg.bindUser) return '';
  return cfg.bindUser.includes('@') || cfg.bindUser.includes('\\') || cfg.bindUser.includes('=') ? cfg.bindUser : `${cfg.bindUser}@${cfg.domain}`;
}

/* Drawer with the connection form. Save keeps the drawer open and refreshes the card behind it. */
function DirectoryDrawer({ cfg, isNew, onClose, onChanged }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => formFromConfig(cfg));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [saved, setSaved] = useState(cfg);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...form, servers: form.servers.split(/[\s,;]+/).filter(Boolean) };
      if (!body.bindPassword) delete body.bindPassword;
      const { data } = await client.put('/directory/config', body);
      setSaved(data);
      setForm((f) => ({ ...f, bindPassword: '' }));
      toast({ type: 'success', title: isNew ? 'Active Directory added' : 'Active Directory saved' });
      onChanged();
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

  return (
    <Drawer title={isNew ? 'Add Active Directory' : `Edit ${saved.domain || 'Active Directory'}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[11px] text-ink-muted leading-relaxed">
          Give ICC a domain name and one approved account. Domain controllers, the search base and TLS are discovered.
          Then add domain users and groups by name from the Users and Groups tabs. Local accounts keep working as break-glass.
        </p>

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
              Password {saved?.bindPasswordSource === 'settings' && <span className="text-ink-faint font-normal">(saved, leave blank to keep)</span>}
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
          <button onClick={save} disabled={saving} className={btnPrimary}>
            <Save size={13} /> {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={test} disabled={testing || saving || !form.domain || !form.bindUser} className={btnPlain}>
            <Plug size={13} /> {testing ? 'Testing...' : 'Save and test connection'}
          </button>
          <button onClick={onClose} className={btnPlain}>Close</button>
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
    </Drawer>
  );
}

function StateBadge({ cfg, ready }) {
  if (cfg.configured) return <Badge tone="ok">Connected</Badge>;
  if (!ready) return <Badge tone="warn">Incomplete</Badge>;
  return <Badge tone="neutral">Disabled</Badge>;
}

export default function DirectoryTab() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [sync, setSync] = useState({ running: false, runs: [] });
  const [syncing, setSyncing] = useState(false);
  const [linkCount, setLinkCount] = useState(0);
  const [drawer, setDrawer] = useState(null); // 'new' | 'edit'

  const loadAll = useCallback(() => {
    client.get('/directory/config').then(({ data }) => setCfg(data)).catch(() => {});
    client.get('/directory/links').then(({ data }) => setLinkCount(data.length)).catch(() => {});
    client.get('/directory/sync/status').then(({ data }) => setSync(data)).catch(() => {});
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggleEnabled = async () => {
    try {
      const { data } = await client.put('/directory/config', { enabled: !cfg.enabled });
      setCfg(data);
    } catch (err) {
      toast({ type: 'error', title: 'Could not change domain sign-in', message: errorMessage(err, '') });
    }
  };

  // Clears the connection fields and turns sign-in off. The saved password
  // cannot be blanked through the API; a new domain replaces it on save.
  const remove = async () => {
    if (!window.confirm(`Remove Active Directory ${cfg.domain}? Domain sign-in stops. Linked groups and accounts stay.`)) return;
    try {
      const { data } = await client.put('/directory/config', { enabled: false, domain: '', bindUser: '', servers: [], baseDn: '', caCert: '' });
      setCfg(data);
      toast({ type: 'success', title: 'Active Directory removed' });
    } catch (err) {
      toast({ type: 'error', title: 'Could not remove Active Directory', message: errorMessage(err, '') });
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

  if (!cfg) return <p className="text-xs text-ink-faint">Loading...</p>;
  const present = !!(cfg.domain || cfg.bindUser);
  const ready = !!(cfg.domain && cfg.bindUser && cfg.bindPasswordSource !== 'none');
  const lastRun = sync.runs?.[0];

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-ink">Active Directory</p>
          <p className="text-[11px] text-ink-muted mt-0.5">Domain sign-in with one approved account; domain users and groups are added by name from the Users and Groups tabs.</p>
        </div>
        {!present && (
          <button onClick={() => setDrawer('new')} className={btnPrimary}><Plus size={13} /> Add Active Directory</button>
        )}
      </div>

      {!present && (
        <div className="panel p-6 text-center text-xs text-ink-faint">No Active Directory domain yet. Local sign-in keeps working without one.</div>
      )}

      {present && (
        <div className="panel p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <p className="text-sm font-bold text-ink">{cfg.domain || 'Domain not set'}</p>
              <Badge tone="info">Active Directory</Badge>
              <span className="text-[10px] text-ink-faint">LDAP over TLS</span>
              {cfg.bindUser && <span className="text-[11px] text-ink-faint font-mono">{bindLabel(cfg)}</span>}
              <StateBadge cfg={cfg} ready={ready} />
            </div>
            <div className="flex items-center gap-3">
              <label className={`inline-flex items-center gap-2 select-none ${ready || cfg.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                title={ready || cfg.enabled ? '' : 'Save a domain, an approved account and its password before enabling domain sign-in.'}>
                <input type="checkbox" checked={!!cfg.enabled} disabled={!ready && !cfg.enabled}
                  onChange={toggleEnabled} className="accent-brand cursor-pointer" />
                <span className="text-xs text-ink-muted">{cfg.enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
              <button onClick={() => setDrawer('edit')} aria-label="Edit Active Directory" className="text-ink-faint hover:text-brand cursor-pointer"><Pencil size={13} /></button>
              <button onClick={remove} aria-label="Remove Active Directory" className="text-ink-faint hover:text-status-crit cursor-pointer"><Trash2 size={13} /></button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-[11px] text-ink-muted">
                {linkCount} domain group{linkCount === 1 ? '' : 's'} mirrored from the Groups tab.
                {lastRun ? (
                  <> Last sync {lastRun.status === 'ok' ? 'succeeded' : lastRun.status}{lastRun.finished_at ? <> <LastUpdated date={lastRun.finished_at} prefix="" /></> : ''}{lastRun.status === 'ok' ? `, ${lastRun.users_seen} users across ${lastRun.groups_synced} groups.` : '.'}</>
                ) : ' No sync has run yet.'}
              </p>
              {lastRun?.status === 'error' && <p className="text-xs text-status-crit mt-1">{lastRun.message}</p>}
              {lastRun?.status === 'ok' && lastRun.message && <p className="text-xs text-status-warn mt-1">{lastRun.message}</p>}
            </div>
            <button onClick={runSync} disabled={syncing || sync.running || !cfg.configured}
              title={cfg.configured ? '' : 'Enable domain sign-in first.'}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40 cursor-pointer">
              <RefreshCw size={12} className={syncing || sync.running ? 'animate-spin' : ''} /> Sync now
            </button>
          </div>
        </div>
      )}

      {drawer && (
        <DirectoryDrawer key={drawer} cfg={cfg} isNew={drawer === 'new'} onClose={() => setDrawer(null)} onChanged={loadAll} />
      )}
    </>
  );
}
