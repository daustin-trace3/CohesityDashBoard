// Proxmox Settings — ports host frontend/src/pages/proxmox/PxSettingsPage.jsx.
// The host's useToast()/Toaster isn't available in a plugin bundle, so
// feedback is surfaced via inline status text next to each action instead of
// toasts — a deliberate simplification, noted in the build report.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, Spinner,
  GearIcon, ServerIcon, CheckCircleIcon, XCircleIcon, TrashIcon, RefreshIcon, BellIcon, PencilIcon, SearchIcon, XIcon,
  fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#E57000';
const PROBE_SECTIONS = ['version', 'nodes', 'resources', 'guests', 'storage', 'tasks', 'backup', 'cluster', 'certificates', 'subscription'];

const inputStyle = {
  width: '100%',
  background: 'var(--px-surface-overlay)',
  border: '1px solid var(--px-border)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--px-ink)',
  outline: 'none',
  boxSizing: 'border-box',
};

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) return res.json().catch(() => ({})).then((body) => { throw Object.assign(new Error(body.error || `request failed: ${res.status}`), { body }); });
    return res.json();
  });
}
function apiSend(path, method, body) {
  // Session mutations must carry the host's CSRF token (middleware/csrf.js)
  // or they come back as a bare 403. The host publishes it on window.
  const csrf = typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null;
  return fetch(`/api/proxmox${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  }).then((res) => {
    if (!res.ok) return res.json().catch(() => ({})).then((b) => { throw Object.assign(new Error(b.error || `request failed: ${res.status}`), { body: b }); });
    return res.status === 204 ? null : res.json();
  });
}

function ProbeModal({ server, onClose }) {
  const [result, setResult] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);

  const runProbe = React.useCallback(() => {
    setLoading(true);
    setError(false);
    setResult(null);
    apiGet(`/servers/${server.id}/probe`, { sections: PROBE_SECTIONS.join(',') })
      .then((data) => setResult(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [server.id]);

  React.useEffect(() => { runProbe(); }, [runProbe]);

  return ReactDOM.createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', padding: 16 }}>
      <div className="px-panel" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 860, padding: 20, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--px-ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SearchIcon size={15} style={{ color: 'var(--px-brand)' }} /> Raw probe — {server.name}
            </h2>
            <p style={{ fontSize: 11, color: 'var(--px-ink-muted)', margin: '2px 0 0' }}>Live fetch of every section against the Proxmox API — read-only, does not touch stored data.</p>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--px-ink-faint)', cursor: 'pointer', flexShrink: 0 }}><XIcon size={16} /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <button onClick={runProbe} disabled={loading} className="px-btn-ghost" style={{ fontSize: 12 }}>
            {loading && <Spinner size={12} />} Re-run
          </button>
        </div>
        <div className="px-scroll" style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {error ? (
            <div style={{ fontSize: 13, color: 'var(--px-crit)', padding: '24px 0', textAlign: 'center' }}>Probe failed — the server may be unreachable.</div>
          ) : loading || result == null ? (
            <div style={{ padding: '40px 0', display: 'flex', justifyContent: 'center' }}><Spinner size={20} /></div>
          ) : (
            <pre style={{ background: 'var(--px-surface-overlay)', borderRadius: 8, padding: 12, fontSize: 11, color: 'var(--px-ink-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default function PxSettingsPage() {
  const [servers, setServers] = React.useState(null);
  const [form, setForm] = React.useState({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', sslVerify: false, pollingIntervalMinutes: 10 });
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [probeServer, setProbeServer] = React.useState(null);
  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [configMsg, setConfigMsg] = React.useState(null);
  const [rowMsg, setRowMsg] = React.useState({});

  const loadServers = () => apiGet('/servers').then((d) => setServers(d)).catch(() => setServers([]));

  React.useEffect(() => {
    loadServers();
    apiGet('/config')
      .then((d) => setConfig({
        storageWarnPct: String(d.storageWarnPct),
        storageCritPct: String(d.storageCritPct),
        backupStaleDays: String(d.backupStaleDays),
        certWarnDays: String(d.certWarnDays),
        snapshotAgeDays: String(d.snapshotAgeDays),
      }))
      .catch(() => setConfig({ storageWarnPct: '85', storageCritPct: '95', backupStaleDays: '3', certWarnDays: '30', snapshotAgeDays: '30' }));
  }, []);

  const saveConfig = async () => {
    setSavingConfig(true);
    setConfigMsg(null);
    try {
      const body = {
        storageWarnPct: Number(config.storageWarnPct),
        storageCritPct: Number(config.storageCritPct),
        backupStaleDays: Number(config.backupStaleDays),
        certWarnDays: Number(config.certWarnDays),
        snapshotAgeDays: Number(config.snapshotAgeDays),
      };
      const data = await apiSend('/config', 'PUT', body);
      setConfig({
        storageWarnPct: String(data.storageWarnPct),
        storageCritPct: String(data.storageCritPct),
        backupStaleDays: String(data.backupStaleDays),
        certWarnDays: String(data.certWarnDays),
        snapshotAgeDays: String(data.snapshotAgeDays),
      });
      setConfigMsg({ ok: true, text: 'Thresholds saved' });
    } catch (err) {
      setConfigMsg({ ok: false, text: err.body?.error || 'Enter valid threshold values.' });
    } finally {
      setSavingConfig(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiSend('/servers/test', 'POST', {
        id: editingId || undefined,
        host: form.host.trim(), port: Number(form.port) || 8006, tokenId: form.tokenId.trim(),
        tokenSecret: form.tokenSecret || undefined, sslVerify: form.sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err.body || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const blankForm = () => {
    setForm({ name: '', host: '', port: 8006, tokenId: '', tokenSecret: '', sslVerify: false, pollingIntervalMinutes: 10 });
    setTestResult(null);
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 8006, tokenId: s.tokenId || '', tokenSecret: '',
      sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 10,
    });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const add = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body = {
        name: form.name.trim(), host: form.host.trim(), port: Number(form.port) || 8006,
        tokenId: form.tokenId.trim(), sslVerify: form.sslVerify,
        pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 10,
      };
      if (editingId) {
        if (form.tokenSecret) body.tokenSecret = form.tokenSecret;
        await apiSend(`/servers/${editingId}`, 'PUT', body);
        setSaveMsg({ ok: true, text: form.tokenSecret ? 'Server updated — credentials replaced.' : 'Saved. Stored token secret unchanged.' });
      } else {
        body.tokenSecret = form.tokenSecret;
        await apiSend('/servers', 'POST', body);
        setSaveMsg({ ok: true, text: 'Server registered — first poll started.' });
      }
      setEditingId(null);
      blankForm();
      await loadServers();
    } catch (err) {
      setSaveMsg({ ok: false, text: err.body?.error || (editingId ? 'Update failed' : 'Registration failed') });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Unregister Proxmox server "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiSend(`/servers/${s.id}`, 'DELETE');
      await loadServers();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [s.id]: err.body?.error || 'Remove failed' }));
    }
  };

  const refresh = async (s) => {
    setRefreshingId(s.id);
    try {
      await apiSend(`/servers/${s.id}/refresh`, 'POST', {});
      await loadServers();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [s.id]: err.body?.error || 'Refresh failed' }));
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.tokenId.trim() && (editingId || form.tokenSecret);

  return (
    <div className="px-root px-fade-in" style={{ maxWidth: 860 }}>
      <PageHeader icon={GearIcon} title="Proxmox VE Settings" description="Register Proxmox VE servers — each is polled directly with its own API token" />

      <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ServerIcon size={15} style={{ color: 'var(--px-brand)' }} /> {editingId ? `Edit — ${form.name || 'server'}` : 'Add a Proxmox server'}
        </p>
        <p style={{ fontSize: 11, color: 'var(--px-ink-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          An API token with PVEAuditor is sufficient for inventory. Token ID is the full <code>user@realm!name</code> string. The secret is encrypted at rest.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }} className="px-form-grid">
          <style>{`@media (max-width: 640px) { .px-form-grid { grid-template-columns: 1fr !important; } }`}</style>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Proxmox Lab" style={inputStyle} spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>Host / IP</label>
            <input value={form.host} onChange={set('host')} placeholder="192.168.1.10" style={inputStyle} spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>Port</label>
            <input type="number" min={1} max={65535} value={form.port} onChange={set('port')} style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>Token ID</label>
            <input value={form.tokenId} onChange={set('tokenId')} placeholder="monitor@pve!dashboard" style={inputStyle} spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>
              Token secret{editingId ? <span style={{ fontWeight: 400, color: 'var(--px-ink-faint)' }}> — stored, leave blank to keep</span> : ''}
            </label>
            <input type="password" value={form.tokenSecret} onChange={set('tokenSecret')} placeholder={editingId ? '•••••• (stored)' : ''} style={inputStyle} />
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} style={{ cursor: 'pointer' }} />
            <span style={{ fontSize: 12, color: 'var(--px-ink-muted)' }}>Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={add} disabled={saving || !canSubmit} className="px-btn-accent" style={{ opacity: saving || !canSubmit ? 0.5 : 1 }}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add server'}
          </button>
          {editingId && <button onClick={cancelEdit} className="px-btn-ghost">Cancel</button>}
          <button onClick={test} disabled={testing || !form.host.trim() || !form.tokenId.trim()} className="px-btn-ghost">
            {testing && <Spinner size={13} />} Test connection
          </button>
          {testResult && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: testResult.ok ? 'var(--px-ok)' : 'var(--px-crit)' }}>
              {testResult.ok ? <CheckCircleIcon size={14} /> : <XCircleIcon size={14} />}
              {testResult.ok ? `Connected — PVE ${testResult.version}` : testResult.error}
            </span>
          )}
          {saveMsg && (
            <span style={{ fontSize: 12, color: saveMsg.ok ? 'var(--px-ok)' : 'var(--px-crit)' }}>{saveMsg.text}</span>
          )}
        </div>
      </div>

      <div className="px-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <BellIcon size={15} style={{ color: 'var(--px-brand)' }} /> Alert Thresholds
        </p>
        <p style={{ fontSize: 11, color: 'var(--px-ink-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          Storage utilization warning/critical percentages, days without a successful backup before a guest is flagged stale, days ahead of TLS certificate expiry to warn, and snapshot age before it's flagged stale.
        </p>
        {config == null ? (
          <LoadingPanel label="Loading…" height={60} />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
            {[
              ['storageWarnPct', 'Storage warning (%)', 1, 100],
              ['storageCritPct', 'Storage critical (%)', 1, 100],
              ['backupStaleDays', 'Backup stale (days)', 1, 365],
              ['certWarnDays', 'Cert warning (days)', 1, 365],
              ['snapshotAgeDays', 'Snapshot age (days)', 1, 365],
            ].map(([key, label, min, max]) => (
              <div key={key} style={{ width: 176 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 4 }}>{label}</label>
                <input type="number" min={min} max={max} value={config[key]} onChange={(e) => setConfig((c) => ({ ...c, [key]: e.target.value }))} style={inputStyle} />
              </div>
            ))}
            <button onClick={saveConfig} disabled={savingConfig} className="px-btn-accent">{savingConfig ? 'Saving…' : 'Save'}</button>
            {configMsg && <span style={{ fontSize: 12, color: configMsg.ok ? 'var(--px-ok)' : 'var(--px-crit)' }}>{configMsg.text}</span>}
          </div>
        )}
      </div>

      <div className="px-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--px-ink)', marginBottom: 12 }}>Registered Servers</p>
        {servers == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : servers.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '24px 0', textAlign: 'center' }}>No Proxmox servers registered yet.</div>
        ) : (
          <div className="px-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Name</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Host</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Token ID</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Status</th>
                  <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Last Poll</th>
                  <th style={{ padding: '8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-muted)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--px-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink)', whiteSpace: 'nowrap' }}>{s.name}</td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', whiteSpace: 'nowrap' }}>{s.host}:{s.port}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-muted)', whiteSpace: 'nowrap' }}>{s.tokenId}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {s.lastPollStatus === 'error' && s.lastPollError && (
                        <p style={{ fontSize: 10, color: 'var(--px-crit)', margin: '2px 0 0', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.lastPollError}>{s.lastPollError}</p>
                      )}
                      {rowMsg[s.id] && <p style={{ fontSize: 10, color: 'var(--px-crit)', margin: '2px 0 0' }}>{rowMsg[s.id]}</p>}
                    </td>
                    <td className="px-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{fmtWhen(s.lastPollAt)}</td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        <button onClick={() => setProbeServer(s)} title="Raw probe" aria-label={`Probe ${s.name}`} className="px-btn-ghost" style={{ padding: 6 }}>
                          <SearchIcon size={13} />
                        </button>
                        <button onClick={() => startEdit(s)} title="Edit connection / update credentials" aria-label={`Edit ${s.name}`} className="px-btn-ghost" style={{ padding: 6 }}>
                          <PencilIcon size={13} />
                        </button>
                        <button onClick={() => refresh(s)} disabled={refreshingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`} className="px-btn-ghost" style={{ padding: 6 }}>
                          <RefreshIcon size={13} style={refreshingId === s.id ? { animation: 'px-spin 0.8s linear infinite' } : undefined} />
                        </button>
                        <button onClick={() => remove(s)} title="Unregister" aria-label={`Unregister ${s.name}`} className="px-btn-ghost" style={{ padding: 6, color: 'var(--px-crit)', borderColor: 'rgba(248,113,113,0.4)' }}>
                          <TrashIcon size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 11, color: 'var(--px-ink-faint)', marginTop: 12, lineHeight: 1.5 }}>
          The Proxmox VE platform tab itself is enabled from Global Settings (gear icon → Platforms).
        </p>
      </div>

      {probeServer && <ProbeModal server={probeServer} onClose={() => setProbeServer(null)} />}
    </div>
  );
}
