import { useEffect, useState } from 'react';
import { Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Building2, Layers, ArrowLeftRight, Database, Tags } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import { BRAND, fmtWhen } from './helpers';
import { SitesSection, ClusterAssignmentsSection, FailoverPairsSection } from './VcSitesPanel';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';

const SECTIONS = [
  { key: 'registration', label: 'Registration', icon: Server },
  { key: 'groups', label: 'Groups', icon: Tags },
  { key: 'sites', label: 'Sites', icon: Building2 },
  { key: 'clusters', label: 'Cluster assignments', icon: Layers },
  { key: 'pairs', label: 'Failover pairs', icon: ArrowLeftRight },
  { key: 'alerts', label: 'Alert thresholds', icon: BellRing },
  { key: 'notify', label: 'Alert Notifications', icon: BellRing },
  { key: 'data', label: 'Data retention', icon: Database },
];

// Retention windows: [config key, label, what it keeps, min, max, default].
const RETENTION_FIELDS = [
  ['vmHistoryDays', 'VM samples', 'Hourly CPU and memory per VM, used for the 24 hour and 7 day charts.', 30, 365, 90],
  ['hostHistoryDays', 'Host samples', 'Hourly CPU, memory and connection state per host.', 30, 365, 90],
  ['clusterHistoryDays', 'Cluster samples', 'Hourly cluster totals behind Capacity Trends.', 90, 1095, 365],
  ['datastoreHistoryDays', 'Datastore samples', 'Hourly capacity and free space, behind the growth and days-to-full figures.', 30, 1095, 365],
  ['dailyHistoryDays', 'Daily rollups', 'One row per VM and per host per day (average, min, max). Drives the 30, 90 and 365 day charts.', 90, 1095, 730],
  ['eventRetentionDays', 'Events', 'vCenter events kept for the Events page and VM detail.', 7, 365, 90],
];
// Sustained-usage lines the Ops Agent watches: [config key, label, default, max].
const USAGE_ROWS = [
  ['VM CPU', 'vmCpuWarnPct', 90, 'vmCpuCritPct', 100, 200],
  ['VM memory', 'vmMemWarnPct', 90, 'vmMemCritPct', 95, 100],
  ['ESX host CPU', 'hostCpuWarnPct', 85, 'hostCpuCritPct', 95, 200],
  ['ESX host memory', 'hostMemWarnPct', 85, 'hostMemCritPct', 95, 100],
];
const USAGE_DEFAULTS = Object.fromEntries(USAGE_ROWS.flatMap(([, wk, wd, ck, cd]) => [[wk, String(wd)], [ck, String(cd)]]));
const tabFromHash = () => {
  if (typeof window === 'undefined') return 'registration';
  const h = window.location.hash.replace('#', '');
  if (SECTIONS.some((x) => x.key === h)) return h;
  let q = '';
  try { q = new URLSearchParams(window.location.search).get('section') || ''; } catch { /* ignore */ }
  return SECTIONS.some((x) => x.key === q) ? q : 'registration';
};

function GroupDot({ color }) {
  return <span className="inline-block h-[7px] w-[7px] rounded-full shrink-0" style={{ background: color || BRAND }} />;
}

function GroupsSection({ vcs, groups, reload, flash }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0091DA');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal] = useState('');
  const errText = (err, fallback) => (err?.response?.status === 409 ? 'A group with that name exists' : (err?.response?.data?.error || fallback));

  const create = async () => {
    setCreating(true);
    try {
      await client.post('/vcenter/groups', { name: name.trim(), color });
      setName('');
      await reload();
    } catch (err) {
      flash('error', 'Could not create the group', errText(err, 'Check the name (1 to 80 characters).'));
    } finally {
      setCreating(false);
    }
  };

  const toggleMember = async (g, vcId, on) => {
    const ids = new Set(g.vcenterIds || []);
    if (on) ids.add(vcId); else ids.delete(vcId);
    setBusyId(g.id);
    try {
      await client.put(`/vcenter/groups/${g.id}`, { vcenterIds: [...ids] });
      await reload();
    } catch (err) {
      flash('error', `Could not save ${g.name}`, errText(err, 'Save failed.'));
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (g) => {
    const next = renameVal.trim();
    setRenamingId(null);
    if (!next || next === g.name) return;
    setBusyId(g.id);
    try {
      await client.put(`/vcenter/groups/${g.id}`, { name: next });
      await reload();
    } catch (err) {
      flash('error', `Could not rename ${g.name}`, errText(err, 'Rename failed.'));
    } finally {
      setBusyId(null);
    }
  };

  const removeGroup = async (g) => {
    if (!window.confirm(`Delete group "${g.name}"? The vCenters stay registered; only the grouping is removed.`)) return;
    setBusyId(g.id);
    try {
      await client.delete(`/vcenter/groups/${g.id}`);
      await reload();
    } catch (err) {
      flash('error', `Could not delete ${g.name}`, errText(err, 'Delete failed.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Tags size={15} className="text-brand" /> Groups</p>
      <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
        A group is a free tag. Tick the vCenters that belong to it; a vCenter can sit in several groups. On Guest OS, picking a group
        selects its vCenters. Capacity sites are listed there too but are edited under Sites.
      </p>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <div className="w-56">
          <label className="block text-xs font-semibold text-ink mb-1">New group</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Site1" className={inp} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !creating) create(); }} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-ink mb-1">Colour</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
            className="h-[38px] w-14 bg-surface-overlay border border-cohesity-border rounded-lg p-1 cursor-pointer" />
        </div>
        <button onClick={create} disabled={creating || !name.trim()}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
          {creating ? 'Creating...' : 'Create'}
        </button>
      </div>

      {groups == null ? (
        <LoadingPanel label="Loading..." height={80} />
      ) : groups.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No groups yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-cohesity-border p-3">
              <div className="flex items-center gap-2 mb-2">
                <GroupDot color={g.color} />
                {renamingId === g.id ? (
                  <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)} maxLength={80}
                    onKeyDown={(e) => { if (e.key === 'Enter') rename(g); else if (e.key === 'Escape') setRenamingId(null); }}
                    onBlur={() => setRenamingId(null)}
                    className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-sm text-ink focus:border-brand/60 outline-none" />
                ) : (
                  <span className="text-sm font-semibold text-ink">{g.name}</span>
                )}
                <span className="tnum text-[11px] text-ink-faint">{(g.vcenterIds || []).length} of {vcs.length} vCenters</span>
                {busyId === g.id && <Spinner size={12} />}
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => { setRenamingId(g.id); setRenameVal(g.name); }} title="Rename" aria-label={`Rename ${g.name}`}
                    className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => removeGroup(g)} title="Delete group" aria-label={`Delete ${g.name}`}
                    className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-1">
                {vcs.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
                    <input type="checkbox" className="accent-brand cursor-pointer" disabled={busyId === g.id}
                      checked={(g.vcenterIds || []).includes(v.id)} onChange={(e) => toggleMember(g, v.id, e.target.checked)} />
                    <span className="text-ink">{v.name}</span>
                    <span className="text-ink-faint tnum truncate">{v.host}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export default function VcSettingsPage() {
  const { toast } = useToast();
  const [vcs, setVcs] = useState(null);
  const [form, setForm] = useState({ name: '', host: '', username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [refreshingId, setRefreshingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [certWarnDays, setCertWarnDays] = useState('');
  const [guestWarnPct, setGuestWarnPct] = useState('');
  const [guestCritPct, setGuestCritPct] = useState('');
  const [usage, setUsage] = useState(USAGE_DEFAULTS);
  const [savingConfig, setSavingConfig] = useState(false);
  const [ret, setRet] = useState({});
  const [savingRet, setSavingRet] = useState(false);
  const [tagCategories, setTagCategories] = useState([]);
  const [savingOwnerId, setSavingOwnerId] = useState(null);
  const flash = (type, title, message) => toast({ type, title, message });
  // Sub-menu (Zerto settings pattern). Deep links: /vcenter/settings#sites, #clusters, #alerts.
  const [tab, setTab] = useState(tabFromHash);
  const selectTab = (key) => { setTab(key); try { window.history.replaceState(null, '', `#${key}`); } catch { /* ignore */ } };
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const loadVcs = () => client.get('/vcenter/vcenters')
    .then(({ data }) => setVcs(data))
    .catch(() => setVcs([]));
  const [groups, setGroups] = useState(null);
  const loadGroups = () => client.get('/vcenter/groups', { params: { _: Date.now() } })
    .then(({ data }) => setGroups(Array.isArray(data?.groups) ? data.groups : []))
    .catch(() => setGroups([]));
  const reloadGroups = async () => { await Promise.all([loadGroups(), loadVcs()]); };

  useEffect(() => {
    loadVcs();
    loadGroups();
    client.get('/vcenter/config')
      .then(({ data }) => {
        setCertWarnDays(String(data.certWarnDays));
        setGuestWarnPct(String(data.guestDiskWarnPct ?? 80));
        setGuestCritPct(String(data.guestDiskCritPct ?? 90));
        setRet(Object.fromEntries(RETENTION_FIELDS.map(([k, , , , , d]) => [k, String(data[k] ?? d)])));
        setUsage(Object.fromEntries(Object.entries(USAGE_DEFAULTS).map(([k, d]) => [k, String(data[k] ?? d)])));
      })
      .catch(() => { setCertWarnDays('60'); setGuestWarnPct('80'); setGuestCritPct('90'); });
    client.get('/vcenter/tag-categories')
      .then(({ data }) => setTagCategories(data || []))
      .catch(() => setTagCategories([]));
  }, []);

  const thresholdsValid = Number(certWarnDays) >= 1 && Number(certWarnDays) <= 365
    && Number(guestWarnPct) >= 1 && Number(guestWarnPct) <= 100
    && Number(guestCritPct) >= Number(guestWarnPct) && Number(guestCritPct) <= 100
    && USAGE_ROWS.every(([, wk, , ck, , max]) => Number(usage[wk]) >= 1 && Number(usage[wk]) <= max
      && Number(usage[ck]) >= Number(usage[wk]) && Number(usage[ck]) <= max);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const { data } = await client.put('/vcenter/config', {
        certWarnDays: Number(certWarnDays),
        guestDiskWarnPct: Number(guestWarnPct),
        guestDiskCritPct: Number(guestCritPct),
        ...Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Number(v)])),
      });
      setCertWarnDays(String(data.certWarnDays));
      setGuestWarnPct(String(data.guestDiskWarnPct));
      setGuestCritPct(String(data.guestDiskCritPct));
      setUsage(Object.fromEntries(Object.entries(USAGE_DEFAULTS).map(([k, d]) => [k, String(data[k] ?? d)])));
      toast({ type: 'success', title: 'Thresholds saved', message: `Certificate warnings at ${data.certWarnDays} days; guest volumes warn at ${data.guestDiskWarnPct}%, critical at ${data.guestDiskCritPct}%.` });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Check the values: days 1 to 365, percentages 1 to 100 with critical at or above warning.' });
    } finally {
      setSavingConfig(false);
    }
  };

  const retValid = RETENTION_FIELDS.every(([k, , , min, max]) => {
    const n = Number(ret[k]);
    return Number.isInteger(n) && n >= min && n <= max;
  });

  const saveRetention = async () => {
    setSavingRet(true);
    try {
      const body = Object.fromEntries(RETENTION_FIELDS.map(([k]) => [k, Number(ret[k])]));
      const { data } = await client.put('/vcenter/config', body);
      setRet(Object.fromEntries(RETENTION_FIELDS.map(([k, , , , , d]) => [k, String(data[k] ?? d)])));
      toast({ type: 'success', title: 'Retention saved', message: 'Older rows are removed at the next hourly sample.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Check each value against its range.' });
    } finally {
      setSavingRet(false);
    }
  };

  const saveOwnerTag = async (vc, category) => {
    setSavingOwnerId(vc.id);
    try {
      await client.put(`/vcenter/vcenters/${vc.id}/owner-tag`, { category: category || null });
      await loadVcs();
      toast({ type: 'success', title: `Owner tag for ${vc.name}`, message: category ? `VM owners now read from the "${category}" tag category.` : 'Owner tag cleared.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSavingOwnerId(null);
    }
  };

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
        await client.put(`/vcenter/vcenters/${editingId}`, body);
        toast({ type: 'success', title: 'vCenter updated', message: form.password ? 'Credentials replaced — next poll uses them.' : 'Saved. Stored password unchanged.' });
      } else {
        body.password = form.password;
        await client.post('/vcenter/vcenters', body);
        toast({ type: 'success', title: 'vCenter registered', message: 'First poll started — data appears shortly.' });
      }
      setEditingId(null);
      blankForm();
      await loadVcs();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
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

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="vCenter Settings" description="vCenter registration, capacity sites and cluster assignments, alert thresholds" />

      <PlatformSettingsLayout brand={BRAND} label="vCenter" sections={SECTIONS} active={tab} onSelect={selectTab}>

        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {tab === 'registration' && (
            <>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'vCenter'}` : 'Add a vCenter'}</p>
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
                <th className="py-2 pr-3" title="Tag category that names the VM owner on this vCenter (shown on Guest Storage and in alerts)">Owner Tag</th>
                <th className="py-2 pr-3" title="Groups this vCenter belongs to (edit under Groups)">Groups</th>
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
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(v.lastPollAt)}</td>
                    <td className="py-2 pr-3">
                      <select value={v.ownerTagCategory || ''} disabled={savingOwnerId === v.id}
                        onChange={(e) => saveOwnerTag(v, e.target.value)}
                        className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer disabled:opacity-50"
                        title="Categories come from the tags seen on VMs at the last poll">
                        <option value="">None</option>
                        {v.ownerTagCategory && !tagCategories.some((c) => c.category === v.ownerTagCategory) && (
                          <option value={v.ownerTagCategory}>{v.ownerTagCategory}</option>
                        )}
                        {tagCategories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      {Array.isArray(v.groups) && v.groups.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {v.groups.map((g) => (
                            <button key={g.id} type="button" onClick={() => selectTab('groups')} title="Edit under Groups"
                              className="chip cursor-pointer bg-surface-overlay text-ink-muted border-cohesity-border hover:text-ink inline-flex items-center gap-1.5">
                              <GroupDot color={g.color} />{g.name}
                            </button>
                          ))}
                        </div>
                      ) : <span className="text-ink-faint">-</span>}
                    </td>
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

            </>
          )}
          {tab === 'groups' && <GroupsSection vcs={vcs || []} groups={groups} reload={reloadGroups} flash={flash} />}
          {tab === 'sites' && <SitesSection flash={flash} />}
          {tab === 'clusters' && <ClusterAssignmentsSection flash={flash} />}
          {tab === 'pairs' && <FailoverPairsSection flash={flash} />}
          {tab === 'alerts' && (
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
          How far ahead of a vCenter TLS certificate's expiry the Overview raises a warning (expiry within 14 days, or past due, is always critical),
          and how full a guest volume (C:, /var) may get before Guest Storage flags it. Each volume over the warning line is an open
          issue; turn on the "guest-volume-full" type under Alert Notifications to have it emailed.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <label className="block text-xs font-semibold text-ink mb-1">Certificate warning (days before expiry)</label>
            <input type="number" min={1} max={365} value={certWarnDays}
              onChange={(e) => setCertWarnDays(e.target.value)} className={inp} />
          </div>
          <div className="w-44">
            <label className="block text-xs font-semibold text-ink mb-1">Guest volume warning (% used)</label>
            <input type="number" min={1} max={100} value={guestWarnPct}
              onChange={(e) => setGuestWarnPct(e.target.value)} className={inp} />
          </div>
          <div className="w-44">
            <label className="block text-xs font-semibold text-ink mb-1">Guest volume critical (% used)</label>
            <input type="number" min={1} max={100} value={guestCritPct}
              onChange={(e) => setGuestCritPct(e.target.value)} className={inp} />
          </div>
        </div>
        <p className="text-[11px] text-ink-muted mt-4 mb-2 leading-relaxed">
          Sustained usage the Ops Agent watches, as a percent of the VM's or host's own allocation. A subject over the warning line is
          sampled each poll and only becomes an incident once it stays there (see Global Settings &gt; Intelligence &gt; Operations Agent &gt; Observations).
          CPU can read above 100% on turbo, so its lines go to 200; memory stops at 100. Critical is held at or above warning.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {USAGE_ROWS.map(([label, wk, wd, ck, cd, max]) => (
            <div key={wk} className="flex items-end gap-2">
              <div className="w-40">
                <label className="block text-xs font-semibold text-ink mb-1">{label} warning (%)</label>
                <input type="number" min={1} max={max} value={usage[wk]} aria-describedby={`${wk}-help`}
                  onChange={(e) => setUsage((u) => ({ ...u, [wk]: e.target.value }))} className={inp} />
              </div>
              <div className="w-40">
                <label className="block text-xs font-semibold text-ink mb-1">{label} critical (%)</label>
                <input type="number" min={1} max={max} value={usage[ck]}
                  onChange={(e) => setUsage((u) => ({ ...u, [ck]: e.target.value }))} className={inp} />
              </div>
              <span id={`${wk}-help`} className="text-[10px] text-ink-faint pb-2.5 whitespace-nowrap">default {wd} / {cd}</span>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <button onClick={saveConfig} disabled={savingConfig || !thresholdsValid}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
            {savingConfig ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
          )}
          {tab === 'notify' && <PlatformAlertNotifications platform="vcenter" label="vCenter" />}
          {tab === 'data' && (
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Database size={15} className="text-brand" /> Data retention</p>
              <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">
                How long each kind of history stays in the database. Hourly samples are kept for a short window; the daily rollups
                keep one row per VM and host per day for long-term trends. Lowering a value deletes the older rows at the next hourly sample.
              </p>
              <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">
                {RETENTION_FIELDS.map(([k, label, what, min, max, dflt]) => (
                  <div key={k}>
                    <label className="block text-xs font-semibold text-ink mb-1">{label} (days)</label>
                    <input type="number" min={min} max={max} value={ret[k] ?? ''} onChange={(e) => setRet((r) => ({ ...r, [k]: e.target.value }))} className={inp} />
                    <p className="text-[11px] text-ink-faint mt-1 leading-snug">{what} Range {min} to {max} days, default {dflt}.</p>
                  </div>
                ))}
              </div>
              <button onClick={saveRetention} disabled={savingRet || !retValid}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
                {savingRet ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </PlatformSettingsLayout>
    </div>
  );
}
