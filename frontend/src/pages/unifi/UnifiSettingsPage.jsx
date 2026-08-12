import { useEffect, useState, useCallback } from 'react';
import {
  Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, ToggleLeft,
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
  { key: 'sources', label: 'Controllers', icon: Server, group: 'Connections' },
  { key: 'features', label: 'Feature Modules', icon: ToggleLeft, group: 'Tuning' },
  { key: 'thresholds', label: 'Alert Thresholds', icon: BellRing, group: 'Tuning' },
];

const FEATURE_FIELDS = [
  { key: 'protect', label: 'Protect (cameras)', description: 'Poll UniFi Protect cameras, NVR arm state and live snapshots. Turn off if no controller runs Protect — the endpoints are not queried at all while disabled.' },
  { key: 'wifi', label: 'WiFi', description: 'Poll WLANs, radios and neighboring/rogue APs; shows the WiFi page, congestion insight and WiFi issue rules.' },
  { key: 'security', label: 'Security', description: 'Poll IPS/threat-management state and firewall rules; shows the Security page, security insight card and IPS issue rule.' },
];

const THRESHOLD_FIELDS = [
  { key: 'unifiWanLatencyWarnMs', label: 'WAN latency warn (ms)', min: 1, max: 5000 },
  { key: 'unifiWanAvailWarnPct', label: 'WAN availability warn (%)', min: 0, max: 100 },
  { key: 'unifiPortErrDeltaWarn', label: 'Port error delta warn (24h)', min: 1, max: 100000 },
  { key: 'unifiPortFlapWarn', label: 'Port flap warn (24h transitions)', min: 1, max: 100 },
  { key: 'unifiDeviceCpuWarnPct', label: 'Device CPU warn (%)', min: 1, max: 100 },
  { key: 'unifiDeviceMemWarnPct', label: 'Device memory warn (%)', min: 1, max: 100 },
  { key: 'unifiTempWarnC', label: 'Device temperature warn (°C)', min: 1, max: 150 },
  { key: 'unifiSatisfactionWarn', label: 'Client satisfaction warn (%)', min: 1, max: 100 },
  { key: 'unifiNewDeviceDays', label: 'New-device alert window (days)', min: 1, max: 30 },
];

const blankForm = () => ({ name: '', host: '', port: 443, apiKey: '', sslVerify: false, pollingIntervalMinutes: 10 });

function SourceTable({ sources, onEdit, onDelete, onPoll, pollingId }) {
  if (sources.length === 0) return <div className="text-sm text-ink-muted py-6 text-center">No controllers registered.</div>;
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
                  <button onClick={() => onEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} className={iconBtn}><Pencil size={13} /></button>
                  <button onClick={() => onPoll(s)} disabled={pollingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`} className={iconBtn}>
                    <RefreshCw size={13} className={pollingId === s.id ? 'animate-spin' : ''} />
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

export default function UnifiSettingsPage() {
  const { toast } = useToast();
  const [section, setSection] = useState('sources');
  const [sources, setSources] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pollingId, setPollingId] = useState(null);

  const [config, setConfig] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [features, setFeatures] = useState(null);
  const [savingFeature, setSavingFeature] = useState(null);

  const loadSources = useCallback(() => client.get('/unifi/sources')
    .then(({ data }) => setSources(data.sources || data || []))
    .catch(() => setSources([])), []);

  useEffect(() => {
    loadSources();
    client.get('/unifi/config')
      .then(({ data }) => setConfig(data.thresholds || {}))
      .catch(() => setConfig({}));
    client.get('/unifi/features')
      .then(({ data }) => setFeatures(data.features || {}))
      .catch(() => setFeatures({}));
  }, [loadSources]);

  const toggleFeature = async (key) => {
    const next = !(features?.[key] !== false);
    setSavingFeature(key);
    try {
      const { data } = await client.put('/unifi/features', { [key]: next });
      setFeatures(data.features || { ...features, [key]: next });
      window.dispatchEvent(new Event('platforms-changed'));
      toast({ type: 'success', title: `${key.charAt(0).toUpperCase() + key.slice(1)} module ${next ? 'enabled — polls on the next cycle' : 'disabled'}` });
    } catch {
      toast({ type: 'error', title: 'Failed to update feature module' });
    } finally {
      setSavingFeature(null);
    }
  };

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 443, apiKey: '',
      sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 10,
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); setForm(blankForm()); setTestResult(null); };

  const testSource = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = { host: form.host.trim(), port: Number(form.port) || 443, sslVerify: form.sslVerify };
      if (form.apiKey) body.apiKey = form.apiKey;
      if (editingId) body.id = editingId;
      const { data } = await client.post('/unifi/sources/test', body);
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
        sslVerify: form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 10,
      };
      if (editingId) {
        // Blank API key = keep the stored one (omit from the PUT body).
        if (form.apiKey) body.apiKey = form.apiKey;
        await client.put(`/unifi/sources/${editingId}`, body);
        toast({ type: 'success', title: 'Controller updated', message: form.apiKey ? 'API key replaced — next poll uses it.' : 'Saved. Stored key unchanged.' });
      } else {
        body.apiKey = form.apiKey;
        await client.post('/unifi/sources', body);
        toast({ type: 'success', title: 'Controller registered', message: 'First poll started — data appears shortly.' });
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
    if (!window.confirm(`Remove controller "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/unifi/sources/${s.id}`);
      await loadSources();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const pollSource = async (s) => {
    setPollingId(s.id);
    try {
      await client.post(`/unifi/sources/${s.id}/poll`, {}, { timeout: 300000 });
      await loadSources();
      toast({ type: 'success', title: `${s.name} polled` });
    } catch (err) {
      toast({ type: 'error', title: `Poll failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setPollingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && (editingId || form.apiKey);

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const body = {};
      for (const f of THRESHOLD_FIELDS) body[f.key] = Number(config[f.key]);
      const { data } = await client.put('/unifi/config', body);
      setConfig(data.thresholds || data);
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="UniFi Settings" description="Register UniFi Network controllers and tune alert thresholds" />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav className="w-full md:w-48 shrink-0 flex flex-row md:flex-col flex-wrap gap-x-6" aria-label="UniFi settings sections">
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
                  <Server size={15} className="text-brand" /> {editingId ? `Edit — ${form.name || 'controller'}` : 'Add a Controller'}
                </p>
                <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
                  Create a read-only local API key on the UniFi controller (Settings → Control Plane → Integrations). The key is encrypted at rest.
                </p>
                <div className="grid md:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
                    <input value={form.name} onChange={setF('name')} placeholder="AustinHome" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
                    <input value={form.host} onChange={setF('host')} placeholder="192.168.1.1" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Port</label>
                    <input type="number" value={form.port} onChange={setF('port')} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
                    <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} className={inp} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-semibold text-ink mb-1">API Key{editingId ? <span className="font-normal text-ink-faint"> — stored, leave blank to keep</span> : ''}</label>
                    <input type="password" value={form.apiKey} onChange={setF('apiKey')} placeholder={editingId ? '•••••• (stored)' : ''} className={inp} />
                  </div>
                  <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.sslVerify} onChange={setF('sslVerify')} className="accent-brand cursor-pointer" />
                    <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
                  </label>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={saveSource} disabled={saving || !canSubmit} className={btnPrimary}>
                    {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add controller'}
                  </button>
                  {editingId && <button onClick={cancelEdit} className={btnGhost}>Cancel</button>}
                  <button onClick={testSource} disabled={testing || !form.host.trim()}
                    className={`${btnGhost} hover:border-brand/40 inline-flex items-center gap-2`}>
                    {testing && <Spinner size={13} />} Test connection
                  </button>
                  {testResult && (
                    <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
                      {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {testResult.ok ? `Connected — ${testResult.sites?.length ?? 0} site(s)${testResult.applicationVersion ? ` · v${testResult.applicationVersion}` : ''}` : testResult.error}
                    </span>
                  )}
                </div>
              </div>

              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Registered Controllers</p>
                {sources == null ? (
                  <LoadingPanel label="Loading…" height={100} />
                ) : (
                  <SourceTable sources={sources} onEdit={startEdit} onDelete={deleteSource} onPoll={pollSource} pollingId={pollingId} />
                )}
              </div>
            </>
          )}

          {section === 'thresholds' && (
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
              <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Tune the warning levels used by UniFi issue detection (WAN quality, port errors/flapping, device load and temperature, client satisfaction).</p>
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

          {section === 'features' && (
            <div className="panel p-4">
              <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><ToggleLeft size={15} className="text-brand" /> Feature Modules</p>
              <p className="text-xs text-ink-muted mb-4">
                Turn off modules you don't use — disabled modules are not queried on the controller, their
                pages and menu items disappear, and their insight cards and issue rules go quiet. Re-enabling
                starts polling again on the next cycle.
              </p>
              {features == null ? (
                <LoadingPanel label="Loading feature modules…" height={80} />
              ) : (
                <div className="flex flex-col gap-3">
                  {FEATURE_FIELDS.map((f) => {
                    const on = features[f.key] !== false;
                    return (
                      <div key={f.key} className="flex items-start justify-between gap-4 bg-surface-overlay rounded-lg px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-ink">{f.label}</p>
                          <p className="text-[11px] text-ink-faint mt-0.5">{f.description}</p>
                        </div>
                        <button onClick={() => toggleFeature(f.key)} disabled={savingFeature === f.key}
                          role="switch" aria-checked={on} aria-label={`Toggle ${f.label}`}
                          className={`relative shrink-0 w-11 h-6 rounded-full transition-colors cursor-pointer disabled:opacity-50 ${on ? 'bg-brand' : 'bg-cohesity-border'}`}>
                          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The UniFi platform tab itself is enabled from Global Settings (gear icon → Platforms).
          </p>
        </div>
      </div>
    </div>
  );
}
