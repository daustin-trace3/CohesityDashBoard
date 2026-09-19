// Settings - ported from the built-in BluecatSettingsPage.jsx (Address
// Manager CRUD + test + enumerate + thresholds), plus a raw Probe action
// against the backend's live-debug /sources/:id/probe route (the built-in
// page has no UI for it; exposing it here follows the dell/brocade pack
// convention of surfacing the probe endpoint for connection troubleshooting).
import {
  Settings, Server, CheckCircle2, XCircle, Trash2, RefreshCw, BellRing, Pencil, ListTree, Search, X,
} from '../icons.jsx';
import client from '../api.js';
import { useToast, PageHeader, Badge, LoadingPanel, Spinner, portalOrInline, BRAND, fmtWhen } from '../ui.jsx';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer';
const btnGhost = 'px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer';
const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

const SECTIONS = [
  { key: 'sources', label: 'Address Managers', icon: Server, group: 'Connections' },
  { key: 'thresholds', label: 'Alert Thresholds', icon: BellRing, group: 'Tuning' },
];

const THRESHOLD_FIELDS = [
  { key: 'lowFreeWarn', label: 'Low free-address warn (count)', min: 1, max: 10000 },
  { key: 'lowFreePct', label: 'Low free-address warn (%)', min: 1, max: 90 },
];

const blankForm = () => ({
  name: '', host: '', port: 443, username: '', password: '', sslVerify: false,
  pollingIntervalMinutes: 30, enumerateIntervalMinutes: 60,
});

// Raw probe - portal to <body>, matches the dell/brocade settings modal
// convention. GET /bluecat/sources/:id/probe runs every section fetcher the
// poller uses and returns { sections }; no per-section query param exists on
// this route (unlike brocade's), so this just runs the whole thing once.
function ProbeModal({ source, onClose }) {
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);

  const runProbe = React.useCallback(() => {
    setLoading(true);
    setError(false);
    setResult(null);
    client.get(`/bluecat/sources/${source.id}/probe`, { timeout: 60000 })
      .then(({ data }) => setResult(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [source.id]);

  React.useEffect(() => { runProbe(); }, [runProbe]);

  return portalOrInline(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="panel w-full max-w-3xl p-5 max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-ink truncate flex items-center gap-2">
              <Search size={15} className="text-brand" /> Raw probe - {source.name}
            </h2>
            <p className="text-[11px] text-ink-muted mt-0.5">Live per-section fetch against the BAM API - read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0 cursor-pointer"><X size={16} /></button>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={runProbe} disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5">
            {loading && <Spinner size={12} />} Run again
          </button>
        </div>
        <div className="overflow-y-auto pr-1 min-h-0 flex-1">
          {error ? (
            <div className="text-sm text-status-crit py-6 text-center">Probe failed - the source may be unreachable.</div>
          ) : loading || result == null ? (
            <div className="py-10 flex justify-center"><Spinner size={20} /></div>
          ) : (
            <pre className="bg-surface-overlay rounded-lg p-3 text-[11px] text-ink-muted whitespace-pre-wrap break-all">
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceTable({ sources, onEdit, onDelete, onPoll, onEnumerate, onProbe, pollingId, enumeratingId }) {
  if (sources.length === 0) return <div className="text-sm text-ink-muted py-6 text-center">No Address Managers registered.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-2 pr-3">Name</th>
          <th className="py-2 pr-3">Host</th>
          <th className="py-2 pr-3">Status</th>
          <th className="py-2 pr-3">Last Poll</th>
          <th className="py-2 pr-3">Last Enumerate</th>
          <th className="py-2 pr-3 text-right">Actions</th>
        </tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id} className="border-b border-cohesity-border/50">
              <td className="py-2 pr-3 text-ink whitespace-nowrap">{s.name}</td>
              <td className="py-2 pr-3 text-ink-muted tnum whitespace-nowrap">{s.host}:{s.port || 443}</td>
              <td className="py-2 pr-3">
                <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' || s.lastPollStatus === 'ok' ? 'ok' : 'neutral'}>
                  {s.lastPollStatus === 'error' ? 'Unreachable' : (s.lastPollStatus === 'success' || s.lastPollStatus === 'ok') ? 'Up' : 'Pending'}
                </Badge>
                {s.lastPollStatus === 'error' && s.lastPollError && (
                  <p className="text-[10px] text-status-crit mt-0.5 max-w-[220px] truncate" title={s.lastPollError}>{s.lastPollError}</p>
                )}
              </td>
              <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(s.lastPollAt)}</td>
              <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">
                {fmtWhen(s.lastEnumerateAt)}
                {s.lastEnumerateError && (
                  <p className="text-[10px] text-status-warn mt-0.5 max-w-[260px] truncate" title={s.lastEnumerateError}>{s.lastEnumerateError}</p>
                )}
              </td>
              <td className="py-2 pr-3">
                <div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => onProbe(s)} title="Raw probe" aria-label={`Probe ${s.name}`} className={iconBtn}><Search size={13} /></button>
                  <button onClick={() => onEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} className={iconBtn}><Pencil size={13} /></button>
                  <button onClick={() => onPoll(s)} disabled={pollingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`} className={iconBtn}>
                    <RefreshCw size={13} className={pollingId === s.id ? 'animate-spin' : ''} />
                  </button>
                  <button onClick={() => onEnumerate(s)} disabled={enumeratingId === s.id} title="Enumerate addresses now (per-network address listing; several minutes on large estates)" aria-label={`Enumerate ${s.name} addresses now`} className={iconBtn}>
                    <ListTree size={13} className={enumeratingId === s.id ? 'animate-pulse' : ''} />
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

export default function BluecatSettingsPage() {
  const { toast } = useToast();
  const [section, setSection] = React.useState('sources');
  const [sources, setSources] = React.useState(null);
  const [form, setForm] = React.useState(blankForm());
  const [editingId, setEditingId] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [pollingId, setPollingId] = React.useState(null);
  const [probeSource, setProbeSource] = React.useState(null);

  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);

  const loadSources = React.useCallback(() => client.get('/bluecat/sources')
    .then(({ data }) => setSources(Array.isArray(data) ? data : data?.sources || []))
    .catch(() => setSources([])), []);

  React.useEffect(() => {
    loadSources();
    client.get('/bluecat/config')
      .then(({ data }) => setConfig(data || {}))
      .catch(() => setConfig({}));
  }, [loadSources]);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 443, username: '', password: '',
      sslVerify: !!s.sslVerify,
      pollingIntervalMinutes: s.pollingIntervalMinutes || 30,
      enumerateIntervalMinutes: s.enumerateIntervalMinutes || 60,
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
      if (form.username) body.username = form.username;
      if (form.password) body.password = form.password;
      const id = editingId || 0;
      const { data } = await client.post(`/bluecat/sources/${id}/test`, body);
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
        username: form.username.trim(),
        sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 30,
        enumerateIntervalMinutes: Number(form.enumerateIntervalMinutes) || 60,
      };
      if (editingId) {
        // Blank password = keep the stored one (omit from the PUT body).
        if (form.password) body.password = form.password;
        await client.put(`/bluecat/sources/${editingId}`, body);
        toast({ type: 'success', title: 'Address Manager updated', message: form.password ? 'Password replaced - next poll uses it.' : 'Saved. Stored password unchanged.' });
      } else {
        body.password = form.password;
        await client.post('/bluecat/sources', body);
        toast({ type: 'success', title: 'Address Manager registered', message: 'First poll started - data appears shortly.' });
      }
      cancelEdit();
      await loadSources();
    } catch (err) {
      const status = err?.status;
      const message = err?.response?.data?.error || err?.response?.data?.message;
      toast({
        type: 'error',
        title: status === 409 ? 'Already registered' : (editingId ? 'Update failed' : 'Registration failed'),
        message: message || (status === 409 ? 'A BlueCat source with that name or host is already registered.' : undefined),
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (s) => {
    if (!window.confirm(`Remove Address Manager "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await client.delete(`/bluecat/sources/${s.id}`);
      await loadSources();
      toast({ type: 'success', title: `Removed ${s.name}` });
    } catch (err) {
      toast({ type: 'error', title: 'Remove failed', message: err?.response?.data?.error });
    }
  };

  const [enumeratingId, setEnumeratingId] = React.useState(null);
  const enumerateSource = async (s) => {
    setEnumeratingId(s.id);
    try {
      await client.post(`/bluecat/sources/${s.id}/enumerate`, {}, { timeout: 30000 });
      toast({ type: 'success', title: `${s.name} address enumeration started`, message: 'Runs in the background; counts update as each network completes.' });
    } catch (err) {
      toast({ type: 'error', title: `Enumerate failed for ${s.name}`, message: err?.response?.data?.error });
    } finally {
      setEnumeratingId(null);
    }
  };

  const pollSource = async (s) => {
    setPollingId(s.id);
    try {
      await client.post(`/bluecat/sources/${s.id}/poll`, {}, { timeout: 300000 });
      await loadSources();
      toast({ type: 'success', title: `${s.name} poll triggered` });
    } catch (err) {
      toast({ type: 'error', title: `Poll failed for ${s.name}`, message: err?.response?.data?.error });
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
      const { data } = await client.put('/bluecat/config', body);
      setConfig(data || body);
      toast({ type: 'success', title: 'Thresholds saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="BlueCat Settings" description="Register BlueCat Address Managers and tune alert thresholds" />

      <div className="flex flex-col md:flex-row gap-6 items-start">
        <nav className="w-full md:w-48 shrink-0 flex flex-row md:flex-col flex-wrap gap-x-6" aria-label="BlueCat settings sections">
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
                  <Server size={15} className="text-brand" /> {editingId ? `Edit - ${form.name || 'Address Manager'}` : 'Add an Address Manager'}
                </p>
                <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
                  Credentials are used to obtain a BAM API session token and are encrypted at rest.
                </p>
                <div className="grid md:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Display name</label>
                    <input value={form.name} onChange={setF('name')} placeholder="BAM-Prod" className={inp} spellCheck={false} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Host / IP</label>
                    <input value={form.host} onChange={setF('host')} placeholder="bam.example.com" className={inp} spellCheck={false} />
                    {editingId && <p className="text-[11px] text-ink-faint mt-1">Changing the address needs the password (or token) entered again.</p>}
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
                    <label className="block text-xs font-semibold text-ink mb-1">Password{editingId ? <span className="font-normal text-ink-faint"> - stored, leave blank to keep</span> : ''}</label>
                    <input type="password" value={form.password} onChange={setF('password')} placeholder={editingId ? '(stored)' : ''} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Poll interval (minutes)</label>
                    <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} className={inp} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-ink mb-1">Enumerate interval (minutes)</label>
                    <input type="number" min={5} max={1440} value={form.enumerateIntervalMinutes} onChange={setF('enumerateIntervalMinutes')} className={inp} />
                  </div>
                  <label className="flex items-end gap-2 pb-2 cursor-pointer select-none">
                    <input type="checkbox" checked={form.sslVerify} onChange={setF('sslVerify')} className="accent-brand cursor-pointer" />
                    <span className="text-xs text-ink-muted">Verify TLS certificate (off = accept self-signed)</span>
                  </label>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={saveSource} disabled={saving || !canSubmit} className={btnPrimary}>
                    {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add Address Manager'}
                  </button>
                  {editingId && <button onClick={cancelEdit} className={btnGhost}>Cancel</button>}
                  <button onClick={testSource} disabled={testing || !form.host.trim()}
                    className={`${btnGhost} hover:border-brand/40 inline-flex items-center gap-2`}>
                    {testing && <Spinner size={13} />} Test connection
                  </button>
                  {testResult && (
                    <span className={`inline-flex items-center gap-1.5 text-xs ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
                      {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {testResult.ok ? `Connected - v${testResult.bamVersion || 'unknown'} - ${testResult.configurations?.length ?? 0} configuration(s)` : (testResult.error || testResult.message)}
                    </span>
                  )}
                </div>
              </div>

              <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-3">Registered Address Managers</p>
                {sources == null ? (
                  <LoadingPanel label="Loading..." height={100} />
                ) : (
                  <SourceTable sources={sources} onEdit={startEdit} onDelete={deleteSource} onPoll={pollSource} onEnumerate={enumerateSource} onProbe={setProbeSource} pollingId={pollingId} enumeratingId={enumeratingId} />
                )}
              </div>
            </>
          )}

          {section === 'thresholds' && (
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><BellRing size={15} className="text-brand" /> Alert Thresholds</p>
              <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">Tune the low free-space warning levels used by BlueCat network and DHCP range issue detection.</p>
              {config == null ? (
                <LoadingPanel label="Loading..." height={80} />
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
                    {savingConfig ? 'Saving...' : 'Save'}
                  </button>
                </>
              )}
            </div>
          )}

          <p className="text-[11px] text-ink-faint mt-3 leading-relaxed">
            The BlueCat platform tab itself is enabled from Global Settings (gear icon -&gt; Platforms).
          </p>
        </div>
      </div>

      {probeSource && <ProbeModal source={probeSource} onClose={() => setProbeSource(null)} />}
    </div>
  );
}
