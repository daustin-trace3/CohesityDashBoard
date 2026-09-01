import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, Search, X, CalendarClock, ShieldCheck, Plus,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, Spinner } from '../../components/ui/primitives';
import { BRAND, fmtWhen } from './helpers';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer';
const btnGhost = 'px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer';
const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

const SECTIONS = [
  { key: 'sources', label: 'SANnav Servers', icon: Server, group: 'Connections' },
  { key: 'thresholds', label: 'Alert Thresholds', icon: BellRing, group: 'Tuning' },
];

const THRESHOLD_FIELDS = [
  { key: 'healthWarnScore', label: 'Health score warn (below)', min: 1, max: 100 },
  { key: 'healthCritScore', label: 'Health score critical (below)', min: 1, max: 100 },
  { key: 'certWarnDays', label: 'Certificate expiry warn (days)', min: 1, max: 365 },
  { key: 'eventStormCount', label: 'Event storm threshold (per hour)', min: 1, max: 1000 },
  { key: 'eventRetentionDays', label: 'Event retention (days)', min: 1, max: 365 },
  { key: 'portStatsRetentionDays', label: 'Port stats retention (days)', min: 1, max: 90 },
];

const PROBE_SECTIONS = ['fabrics', 'switches', 'switchports', 'deviceports', 'enclosures', 'chassis', 'health', 'events', 'zoning', 'fcr', 'about', 'fos-direct'];

const blankForm = () => ({
  name: '', host: '', port: 443, username: '', password: '', verifySsl: false,
  fosProxyEnabled: true, pollingIntervalMinutes: 60, eventPollMinutes: 5, portStatsIntervalMinutes: 15,
  fosDirectEnabled: false, fosUsername: '', fosPassword: '', fosPort: 443, fosAllowHttp: false,
});

const blankOverride = () => ({ switchWwn: '', ipAddress: '', username: '', password: '', port: '' });

// Portal to <body> — matches AWS/UniFi settings modal convention.
function ProbeModal({ source, onClose }) {
  const [section, setSection] = useState('fabrics');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const runProbe = (sec) => {
    setLoading(true);
    setError(false);
    setResult(null);
    client.get(`/brocade/sources/${source.id}/probe`, { params: { section: sec }, timeout: 60000 })
      .then(({ data }) => setResult(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { runProbe(section); }, [source.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Search size={15} className="text-brand" /> Raw probe — {source.name}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Live per-section fetch against SANnav — read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <select value={section} onChange={(e) => { setSection(e.target.value); runProbe(e.target.value); }}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
            {PROBE_SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={() => runProbe(section)} disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5">
            {loading && <Spinner size={12} />} Run
          </button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Probe failed — the source may be unreachable.</div>
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

function FosOverridesPanel({ sourceId, switches, toast }) {
  const [overrides, setOverrides] = useState(null);
  const [form, setForm] = useState(blankOverride());
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => client.get(`/brocade/sources/${sourceId}/fos-overrides`)
    .then(({ data }) => setOverrides(data.overrides || []))
    .catch(() => setOverrides([])), [sourceId]);

  useEffect(() => { load(); }, [load]);

  const setO = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const addOverride = async () => {
    if (!form.switchWwn) return;
    setSaving(true);
    try {
      const body = { switchWwn: form.switchWwn };
      if (form.ipAddress.trim()) body.ipAddress = form.ipAddress.trim();
      if (form.username.trim()) body.username = form.username.trim();
      if (form.password) body.password = form.password;
      if (form.port) body.port = Number(form.port);
      await client.post(`/brocade/sources/${sourceId}/fos-overrides`, body);
      setForm(blankOverride());
      await load();
      toast({ type: 'success', title: 'Override saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Override save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const removeOverride = async (o) => {
    if (!window.confirm(`Remove FOS override for ${o.switchWwn}?`)) return;
    try {
      await client.delete(`/brocade/sources/${sourceId}/fos-overrides/${o.id}`);
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-cohesity-border">
      <p className="text-xs font-semibold text-ink mb-1">Per-switch overrides</p>
      <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Override the shared IP/credentials/port for one switch. Blank fields inherit from above.</p>
      {overrides == null ? (
        <LoadingPanel label="Loading…" height={60} />
      ) : (
        <div className="overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <th className="py-1.5 pr-3">Switch</th>
              <th className="py-1.5 pr-3">IP</th>
              <th className="py-1.5 pr-3">Username</th>
              <th className="py-1.5 pr-3">Password</th>
              <th className="py-1.5 pr-3">Port</th>
              <th className="py-1.5 pr-3 text-right">Actions</th>
            </tr></thead>
            <tbody>
              {overrides.length === 0 ? (
                <tr><td colSpan={6} className="py-3 text-center text-ink-muted text-xs">No overrides.</td></tr>
              ) : overrides.map((o) => (
                <tr key={o.id} className="border-b border-cohesity-border/50">
                  <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{switches.find((s) => s.wwn === o.switchWwn)?.name || o.switchWwn}</td>
                  <td className="py-1.5 pr-3 text-ink-muted">{o.ipAddress || <span className="text-ink-faint">inherit</span>}</td>
                  <td className="py-1.5 pr-3 text-ink-muted">{o.username || <span className="text-ink-faint">inherit</span>}</td>
                  <td className="py-1.5 pr-3 text-ink-muted">{o.hasPassword ? '••••••' : <span className="text-ink-faint">inherit</span>}</td>
                  <td className="py-1.5 pr-3 text-ink-muted tnum">{o.port || <span className="text-ink-faint">inherit</span>}</td>
                  <td className="py-1.5 pr-3 text-right">
                    <button onClick={() => removeOverride(o)} title="Remove override" aria-label={`Remove override for ${o.switchWwn}`}
                      className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="grid md:grid-cols-5 gap-2 items-end">
        <div>
          <label className="block text-[11px] font-semibold text-ink mb-1">Switch</label>
          <select value={form.switchWwn} onChange={setO('switchWwn')}
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1.5 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer">
            <option value="">Select…</option>
            {switches.map((s) => <option key={s.wwn} value={s.wwn}>{s.name} ({s.wwn})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-ink mb-1">IP (optional)</label>
          <input value={form.ipAddress} onChange={setO('ipAddress')} className={inp + ' py-1.5 text-xs'} spellCheck={false} />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-ink mb-1">Username (optional)</label>
          <input value={form.username} onChange={setO('username')} className={inp + ' py-1.5 text-xs'} spellCheck={false} />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-ink mb-1">Password (optional)</label>
          <input type="password" value={form.password} onChange={setO('password')} className={inp + ' py-1.5 text-xs'} />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-ink mb-1">Port (optional)</label>
          <input type="number" value={form.port} onChange={setO('port')} className={inp + ' py-1.5 text-xs'} />
        </div>
      </div>
      <button onClick={addOverride} disabled={saving || !form.switchWwn}
        className="mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5">
        <Plus size={13} /> Add override
      </button>
    </div>
  );
}

function SourceTable({ sources, onEdit, onDelete, onPoll, onPollEvents, onProbe, pollingId }) {
  if (sources.length === 0) return <div className="text-sm text-ink-muted py-6 text-center">No SANnav servers registered.</div>;
  return (
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
              <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{s.host}:{s.port || 443}</td>
              <td className="py-2 pr-3">
                <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                  {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                </Badge>
                {s.lastPollStatus === 'error' && s.lastPollError && (
                  <p className="text-[10px] text-status-crit mt-0.5 max-w-[220px] truncate" title={s.lastPollError}>{s.lastPollError}</p>
                )}
              </td>
              <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.lastPollAt)}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => onProbe(s)} title="Raw probe" aria-label={`Probe ${s.name}`} className={iconBtn}><Search size={13} /></button>
                  <button onClick={() => onEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} className={iconBtn}><Pencil size={13} /></button>
                  <button onClick={() => onPollEvents(s)} title="Poll events" aria-label={`Poll events for ${s.name}`} className={iconBtn}>
                    <CalendarClock size={13} className={pollingId === `${s.id}:events` ? 'animate-pulse' : ''} />
                  </button>
                  <button onClick={() => onPoll(s)} disabled={pollingId === `${s.id}:inventory`} title="Poll now" aria-label={`Poll ${s.name} now`} className={iconBtn}>
                    <RefreshCw size={13} className={pollingId === `${s.id}:inventory` ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => onDelete(s)} title="Remove" aria-label={`Remove ${s.name}`}
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
  );
}

export default function BrocadeSettingsPage() {
  const { toast } = useToast();
  const [section, setSection] = useState('sources');
  const [sources, setSources] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pollingId, setPollingId] = useState(null);
  const [probeSource, setProbeSource] = useState(null);
  const [testingFos, setTestingFos] = useState(false);
  const [fosTestResult, setFosTestResult] = useState(null);
  const [switches, setSwitches] = useState([]);

  const [config, setConfig] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadSources = useCallback(() => client.get('/brocade/sources')
    .then(({ data }) => setSources(data.sources || data || []))
    .catch(() => setSources([])), []);

  useEffect(() => {
    loadSources();
    client.get('/brocade/config')
      .then(({ data }) => setConfig(data))
      .catch(() => setConfig({}));
    client.get('/brocade/switches')
      .then(({ data }) => setSwitches(data.switches || data || []))
      .catch(() => setSwitches([]));
  }, [loadSources]);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 443, username: s.username || '', password: '',
      verifySsl: !!s.verifySsl, fosProxyEnabled: s.fosProxyEnabled !== false,
      pollingIntervalMinutes: s.pollingIntervalMinutes || 60, eventPollMinutes: s.eventPollMinutes || 5,
      portStatsIntervalMinutes: s.portStatsIntervalMinutes || 15,
      fosDirectEnabled: !!s.fosDirectEnabled, fosUsername: s.fosUsername || '', fosPassword: '',
      fosPort: s.fosPort || 443, hasFosPassword: !!s.hasFosPassword, fosAllowHttp: !!s.fosAllowHttp,
    });
    setTestResult(null);
    setFosTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); setForm(blankForm()); setTestResult(null); setFosTestResult(null); };

  const testFos = async () => {
    setTestingFos(true);
    setFosTestResult(null);
    try {
      const { data } = await client.post(`/brocade/sources/${editingId}/fos-test`, {});
      setFosTestResult(data);
    } catch (err) {
      setFosTestResult(err?.response?.data || { ok: false, error: 'FOS test failed.' });
    } finally {
      setTestingFos(false);
    }
  };

  const testSource = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = { host: form.host.trim(), port: Number(form.port) || 443, username: form.username };
      if (form.password) body.password = form.password;
      const { data } = await client.post(`/brocade/sources/${editingId || 0}/test`, body);
      setTestResult(data);
    } catch (err) {
      setTestResult(err?.response?.data || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const saveSource = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), host: form.host.trim(), port: Number(form.port) || 443,
        username: form.username.trim(), verifySsl: form.verifySsl, fosProxyEnabled: form.fosProxyEnabled,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 60,
        eventPollMinutes: Number(form.eventPollMinutes) || 5,
        portStatsIntervalMinutes: Number(form.portStatsIntervalMinutes) || 15,
        fosDirectEnabled: form.fosDirectEnabled, fosUsername: form.fosUsername.trim(),
        fosPort: Number(form.fosPort) || 443, fosAllowHttp: form.fosAllowHttp,
      };
      // Blank FOS password = keep the stored one (omit from the request body).
      if (form.fosPassword) body.fosPassword = form.fosPassword;
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await client.put(`/brocade/sources/${editingId}`, body);
        toast({ type: 'success', title: 'SANnav server updated', message: form.password ? 'Password replaced — next poll uses it.' : 'Saved. Stored password unchanged.' });
      } else {
        body.password = form.password;
        await client.post('/brocade/sources', body);
        toast({ type: 'success', title: 'SANnav server registered', message: 'First poll started — data appears shortly.' });
      }
      cancelEdit();
      await loadSources();
    } catch (err) {
      toast({ type: 'error', title: editingId ? 'Update failed' : 'Registration failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (s) => {
    if (!window.confirm(`Remove SANnav server "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/brocade/sources/${s.id}`);
      await loadSources();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const pollSource = async (s) => {
    setPollingId(`${s.id}:inventory`);
    try {
      await client.post(`/brocade/sources/${s.id}/poll`, {}, { timeout: 300000 });
      await loadSources();
      toast({ type: 'success', title: `${s.name} polled` });
    } catch (err) {
      toast({ type: 'error', title: `Poll failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setPollingId(null);
    }
  };

  const pollEvents = async (s) => {
    setPollingId(`${s.id}:events`);
    try {
      await client.post(`/brocade/sources/${s.id}/poll-events`, {}, { timeout: 120000 });
      toast({ type: 'success', title: `${s.name} event poll triggered` });
    } catch (err) {
      toast({ type: 'error', title: `Event poll failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setPollingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const body = {};
      for (const f of THRESHOLD_FIELDS) body[f.key] = Number(config[f.key]);
      const { data } = await client.put('/brocade/config', body);
      setConfig(data);
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="Brocade SAN Settings" description="Register SANnav Management Portal servers and tune alert thresholds" />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav className="w-full md:w-48 shrink-0 flex flex-row md:flex-col flex-wrap gap-x-6" aria-label="Brocade settings sections">
          {['Connections', 'Tuning'].map((g) => (
            <div key={g} className="flex flex-col gap-0.5 min-w-[10rem] mb-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 mb-1">{g}</p>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = section === s.key;
                return (
                  <button key={s.key} onClick={() => setSection(s.key)} aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] font-medium text-left transition-colors duration-150 cursor-pointer ${
                      active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                    }`}>
                    <Icon size={13} className={active ? 'text-brand' : ''} /> {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0 max-w-3xl">
          {section === 'sources' && (
            <>
              <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
                  <Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'server'}` : 'Add a SANnav Server'}
                </p>
                <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
                  Use a read-only SANnav account. Credentials are encrypted at rest; self-signed certificates are accepted unless "Verify TLS" is on.
                </p>
                <div className="grid md:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
                    <input value={form.name} onChange={setF('name')} placeholder="SanNav Prod" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
                    <input value={form.host} onChange={setF('host')} placeholder="sannav.example.com" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Port</label>
                    <input type="number" value={form.port} onChange={setF('port')} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Username</label>
                    <input value={form.username} onChange={setF('username')} className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> — leave blank to keep current</span> : ''}</label>
                    <input type="password" value={form.password} onChange={setF('password')} placeholder={editingId ? 'leave blank to keep current' : ''} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Inventory poll interval (minutes)</label>
                    <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Event poll interval (minutes)</label>
                    <input type="number" min={1} max={60} value={form.eventPollMinutes} onChange={setF('eventPollMinutes')} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Port stats interval (minutes)</label>
                    <input type="number" min={5} max={1440} value={form.portStatsIntervalMinutes} onChange={setF('portStatsIntervalMinutes')} className={inp} />
                  </div>
                  <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.verifySsl} onChange={setF('verifySsl')} className="accent-brand cursor-pointer" />
                    <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
                  </label>
                  <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.fosProxyEnabled} onChange={setF('fosProxyEnabled')} className="accent-brand cursor-pointer" />
                    <span className="text-xs text-ink-muted">Enable FOS proxy zoning collection</span>
                  </label>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={saveSource} disabled={saving || !canSubmit} className={btnPrimary}>
                    {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add server'}
                  </button>
                  {editingId && <button onClick={cancelEdit} className={btnGhost}>Cancel</button>}
                  <button onClick={testSource} disabled={testing || !form.host.trim()}
                    className={`${btnGhost} hover:border-brand/40 inline-flex items-center gap-2`}>
                    {testing && <Spinner size={13} />} Test connection
                  </button>
                  {testResult && (
                    <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
                      {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {testResult.ok
                        ? `Connected${testResult.version ? ` — v${testResult.version}` : ' — login OK (version reporting needs SANnav 2.3.1+)'}${testResult.oemName ? ` (${testResult.oemName})` : ''}`
                        : testResult.error}
                    </span>
                  )}
                </div>
              </div>

              {editingId && (
                <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                  <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
                    <ShieldCheck size={15} className="text-brand" /> Direct FOS access (switch REST)
                  </p>
                  <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
                    Reads zoning + port IO directly from the switches — required when SanNav is older than 2.4.
                  </p>
                  <div className="grid md:grid-cols-2 gap-3 mb-3">
                    <label className="flex items-end gap-2 pb-2 cursor-pointer select-none md:col-span-2">
                      <input type="checkbox" checked={form.fosDirectEnabled} onChange={setF('fosDirectEnabled')} className="accent-brand cursor-pointer" />
                      <span className="text-xs text-ink-muted">Enable direct FOS access</span>
                    </label>
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1">Shared username</label>
                      <input value={form.fosUsername} onChange={setF('fosUsername')} className={inp} spellCheck={false} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1">Shared password{form.hasFosPassword ? <span className="font-normal text-ink-faint"> — leave blank to keep current</span> : ''}</label>
                      <input type="password" value={form.fosPassword} onChange={setF('fosPassword')} placeholder={form.hasFosPassword ? 'leave blank to keep current' : ''} className={inp} />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-ink mb-1">Port</label>
                      <input type="number" value={form.fosPort} onChange={setF('fosPort')} className={inp} />
                    </div>
                    <label className="flex items-start gap-2 pt-1 cursor-pointer select-none md:col-span-2">
                      <input type="checkbox" checked={form.fosAllowHttp} onChange={setF('fosAllowHttp')} className="accent-status-crit cursor-pointer mt-0.5" />
                      <span className="text-xs text-ink-muted">
                        Allow HTTP <span className="text-status-crit font-semibold">(insecure)</span> — for switches without an HTTPS
                        certificate; switch credentials travel in cleartext on the management network. Port 443 is treated as 80 when
                        this is on. Prefer <code className="text-[10px]">seccertmgmt generate -cert https</code> per switch, then turn this off.
                      </span>
                    </label>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={testFos} disabled={testingFos}
                      className={`${btnGhost} hover:border-brand/40 inline-flex items-center gap-2`}>
                      {testingFos && <Spinner size={13} />} Test FOS
                    </button>
                    {fosTestResult && (
                      <span className={`inline-flex items-center gap-1.5 text-xs ${fosTestResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
                        {fosTestResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                        {fosTestResult.ok ? 'FOS session OK' : fosTestResult.error}
                      </span>
                    )}
                  </div>
                  <FosOverridesPanel sourceId={editingId} switches={switches} toast={toast} />
                </div>
              )}

              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Registered SANnav Servers</p>
                {sources == null ? (
                  <LoadingPanel label="Loading…" height={100} />
                ) : (
                  <SourceTable sources={sources} onEdit={startEdit} onDelete={deleteSource} onPoll={pollSource} onPollEvents={pollEvents} onProbe={setProbeSource} pollingId={pollingId} />
                )}
              </div>
            </>
          )}

          {section === 'thresholds' && (
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
              <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Tune the warning levels used by Brocade issue detection (health scores, certificate expiry, event storms, retention).</p>
              {config == null ? (
                <LoadingPanel label="Loading…" height={80} />
              ) : (
                <>
                  <div className="grid md:grid-cols-2 gap-3 mb-3">
                    {THRESHOLD_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label className="block text-xs font-semibold text-ink mb-1">{f.label}</label>
                        <input type="number" min={f.min} max={f.max} value={config[f.key] ?? ''}
                          onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} className={inp} />
                      </div>
                    ))}
                  </div>
                  <button onClick={saveConfig} disabled={savingConfig} className={btnPrimary}>
                    {savingConfig ? 'Saving…' : 'Save'}
                  </button>
                </>
              )}
            </div>
          )}

          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The Brocade SAN platform tab itself is enabled from Global Settings (gear icon → Platforms).
          </p>
        </div>
      </div>

      {probeSource && <ProbeModal source={probeSource} onClose={() => setProbeSource(null)} />}
    </div>
  );
}
