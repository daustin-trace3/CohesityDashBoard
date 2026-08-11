// NetBackup Settings — ports host frontend/src/pages/netbackup/NbSettingsPage.jsx
// (661 lines). Every mutating call (POST/PUT/DELETE) goes through helpers.js
// apiSend(), which spreads window.__ICC_CSRF_TOKEN__ as x-csrf-token —
// required for every source/appliance-connection/config mutation below.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, Spinner,
  GearIcon, CloudIcon, ServerIcon, HardDriveIcon, CheckCircleIcon, XCircleIcon, TrashIcon,
  RefreshIcon, BellIcon, PencilIcon, PlusIcon, XIcon, PlugIcon, SaveIcon,
} from '../ui.jsx';
import { BRAND, fmtWhen, apiGet, apiSend } from './helpers.js';

injectStyles();

const TABS = [
  { key: 'alta', label: 'Alta (SaaS)', icon: CloudIcon },
  { key: 'primary', label: 'Primary Servers (Direct)', icon: ServerIcon },
  { key: 'hardware', label: 'Appliance Hardware', icon: HardDriveIcon },
];

const ALTA_EMPTY = { name: '', host: '', apiKey: '', pollingIntervalMinutes: 15 };
const PRIMARY_EMPTY = { name: '', host: '', port: 1556, authMode: 'password', username: '', domainName: '', domainType: '', password: '', apiKey: '', sslVerify: false, pollingIntervalMinutes: 15 };
const HW_EMPTY = { name: '', host: '', port: 443, username: '', password: '', sslVerify: false, pollingIntervalMinutes: 15 };

export default function NbSettingsPage() {
  const [tab, setTab] = React.useState('alta');
  return (
    <div className="nb-root nb-fade-in" style={{ maxWidth: 860 }}>
      <PageHeader icon={GearIcon} title="NetBackup Settings" description="Register Alta (SaaS) or on-prem primary servers" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--nb-surface)', border: '1px solid var(--nb-border)', padding: 4, width: 'fit-content', marginBottom: 16 }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', background: active ? 'var(--nb-surface-overlay)' : 'transparent', color: active ? 'var(--nb-ink)' : 'var(--nb-ink-muted)' }}>
              <Icon size={13} style={{ color: active ? 'var(--nb-brand)' : undefined }} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'alta' && <SourcesTab sourceType="alta" />}
      {tab === 'primary' && <SourcesTab sourceType="primary" />}
      {tab === 'hardware' && <ApplianceHardwareTab />}
      {tab !== 'hardware' && <AlertThresholdsPanel />}
    </div>
  );
}

function SourcesTab({ sourceType }) {
  const [sources, setSources] = React.useState(null);
  const [form, setForm] = React.useState(sourceType === 'alta' ? { ...ALTA_EMPTY } : { ...PRIMARY_EMPTY });
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [deletingId, setDeletingId] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [rowMsg, setRowMsg] = React.useState({});

  const load = React.useCallback(() => apiGet('/sources')
    .then((d) => setSources((d.sources || []).filter((s) => s.sourceType === sourceType)))
    .catch(() => setSources([])), [sourceType]);

  React.useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const blankForm = () => { setForm(sourceType === 'alta' ? { ...ALTA_EMPTY } : { ...PRIMARY_EMPTY }); setTestResult(null); };

  const startEdit = (s) => {
    setEditingId(s.id);
    if (sourceType === 'alta') {
      setForm({ name: s.name, host: s.host, apiKey: '', pollingIntervalMinutes: s.pollingIntervalMinutes || 15 });
    } else {
      setForm({
        name: s.name, host: s.host, port: s.port || 1556, authMode: s.authMode || 'password',
        username: s.username || '', domainName: s.domainName || '', domainType: s.domainType || '',
        password: '', apiKey: '', sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 15,
      });
    }
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const buildBody = () => {
    if (sourceType === 'alta') {
      const body = { name: form.name.trim(), sourceType: 'alta', host: form.host.trim(), authMode: 'apikey', pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15 };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      return body;
    }
    const body = { name: form.name.trim(), sourceType: 'primary', host: form.host.trim(), port: Number(form.port) || 1556, authMode: form.authMode, sslVerify: !!form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15 };
    if (form.authMode === 'password') {
      body.username = form.username.trim();
      if (form.domainName.trim()) body.domainName = form.domainName.trim();
      if (form.domainType.trim()) body.domainType = form.domainType.trim();
      if (form.password) body.password = form.password;
    } else if (form.apiKey.trim()) {
      body.apiKey = form.apiKey.trim();
    }
    return body;
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiSend('/sources/test', 'POST', buildBody());
      setTestResult(data);
    } catch (err) {
      setTestResult(err.body || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body = buildBody();
      if (editingId) {
        await apiSend(`/sources/${editingId}`, 'PUT', body);
        setSaveMsg({ ok: true, text: 'Source updated' });
      } else {
        if (sourceType === 'primary' && form.authMode === 'password') body.password = form.password;
        if (sourceType === 'alta' || (sourceType === 'primary' && form.authMode === 'apikey')) body.apiKey = form.apiKey.trim();
        await apiSend('/sources', 'POST', body);
        setSaveMsg({ ok: true, text: 'Source registered — first poll started.' });
      }
      setEditingId(null);
      blankForm();
      await load();
    } catch (err) {
      setSaveMsg({ ok: false, text: err.body?.error || (editingId ? 'Update failed' : 'Registration failed') });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete source "${s.name}"? Its collected data is removed.`)) return;
    setDeletingId(s.id);
    try {
      await apiSend(`/sources/${s.id}`, 'DELETE');
      await load();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [s.id]: err.body?.error || 'Remove failed' }));
    } finally {
      setDeletingId(null);
    }
  };

  const refresh = async (s) => {
    setRefreshingId(s.id);
    try {
      await apiSend(`/sources/${s.id}/refresh`, 'POST', {});
      await load();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [s.id]: err.body?.error || 'Refresh failed' }));
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = sourceType === 'alta'
    ? form.name.trim() && form.host.trim() && (editingId || form.apiKey.trim())
    : form.name.trim() && form.host.trim() && (form.authMode === 'apikey' ? (editingId || form.apiKey.trim()) : form.username.trim() && (editingId || form.password));

  return (
    <div>
      <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          {editingId ? <PencilIcon size={14} style={{ color: 'var(--nb-brand)' }} /> : <PlusIcon size={14} style={{ color: 'var(--nb-brand)' }} />}
          {editingId ? `Edit — ${form.name || 'source'}` : sourceType === 'alta' ? 'Add an Alta (SaaS) source' : 'Add a primary server'}
        </p>
        <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          {sourceType === 'alta' ? 'Connects to a NetBackup Alta tenant via API key. No login step is required.' : "Connects directly to a NetBackup 11.x primary server's REST API. Credentials are encrypted at rest."}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }} className="nb-form-grid">
          <style>{`@media (max-width: 640px) { .nb-form-grid { grid-template-columns: 1fr !important; } }`}</style>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Display name</label>
            <input value={form.name} onChange={set('name')} placeholder={sourceType === 'alta' ? 'Alta Prod' : 'Primary Server 1'} className="nb-input" spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>{sourceType === 'alta' ? 'Tenant URL' : 'Host / FQDN'}</label>
            <input value={form.host} onChange={set('host')} placeholder={sourceType === 'alta' ? 'https://<tenant>.netbackup.alta.veritas.com/netbackup' : 'netbackup.company.com'} className="nb-input" spellCheck={false} />
          </div>

          {sourceType === 'alta' ? (
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>API key{editingId ? <span style={{ fontWeight: 400, color: 'var(--nb-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
              <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder={editingId ? '•••••• (stored)' : ''} className="nb-input" />
            </div>
          ) : (
            <>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Port</label>
                <input type="number" min={1} max={65535} value={form.port} onChange={set('port')} className="nb-input" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Auth mode</label>
                <select value={form.authMode} onChange={set('authMode')} className="nb-input">
                  <option value="password">Username / password</option>
                  <option value="apikey">API key</option>
                </select>
              </div>
              {form.authMode === 'password' ? (
                <>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Username</label>
                    <input value={form.username} onChange={set('username')} className="nb-input" spellCheck={false} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Domain name</label>
                    <input value={form.domainName} onChange={set('domainName')} placeholder="Optional" className="nb-input" spellCheck={false} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Domain type</label>
                    <input value={form.domainType} onChange={set('domainType')} placeholder="Optional" className="nb-input" spellCheck={false} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Password{editingId ? <span style={{ fontWeight: 400, color: 'var(--nb-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
                    <input type="password" value={form.password} onChange={set('password')} placeholder={editingId ? '•••••• (stored)' : ''} className="nb-input" />
                  </div>
                </>
              ) : (
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>API key{editingId ? <span style={{ fontWeight: 400, color: 'var(--nb-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
                  <input type="password" value={form.apiKey} onChange={set('apiKey')} placeholder={editingId ? '•••••• (stored)' : ''} className="nb-input" />
                </div>
              )}
            </>
          )}

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className="nb-input" />
          </div>
          {sourceType === 'primary' && (
            <label style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} style={{ cursor: 'pointer' }} />
              <span style={{ fontSize: 12, color: 'var(--nb-ink-muted)' }}>Verify TLS certificate (off = accept self-signed)</span>
            </label>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={saving || !canSubmit} className="nb-btn-accent" style={{ opacity: saving || !canSubmit ? 0.5 : 1 }}>
            <SaveIcon size={14} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add source'}
          </button>
          {editingId && <button onClick={cancelEdit} className="nb-btn-ghost"><XIcon size={14} /> Cancel</button>}
          <button onClick={test} disabled={testing || !form.host.trim()} className="nb-btn-ghost">
            {testing ? <Spinner size={13} /> : <PlugIcon size={14} />} Test connection
          </button>
          {testResult && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: testResult.ok ? 'var(--nb-ok)' : 'var(--nb-crit)' }}>
              {testResult.ok ? <CheckCircleIcon size={14} /> : <XCircleIcon size={14} />}
              {testResult.ok ? `Connected${testResult.version ? ` — v${testResult.version}` : ''}` : testResult.error}
            </span>
          )}
          {saveMsg && <span style={{ fontSize: 12, color: saveMsg.ok ? 'var(--nb-ok)' : 'var(--nb-crit)' }}>{saveMsg.text}</span>}
        </div>
      </div>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>{sourceType === 'alta' ? 'Registered Alta Sources' : 'Registered Primary Servers'}</p>
        {sources == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : sources.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>None registered yet.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Name</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Host</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Status</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Last Poll</th>
                <th style={{ padding: '8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Actions</th>
              </tr></thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', whiteSpace: 'nowrap' }}>{s.name}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.host}>{s.host}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {s.lastPollStatus === 'error' && s.lastPollError && (
                        <p style={{ fontSize: 10, color: 'var(--nb-crit)', margin: '2px 0 0', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.lastPollError}>{s.lastPollError}</p>
                      )}
                      {rowMsg[s.id] && <p style={{ fontSize: 10, color: 'var(--nb-crit)', margin: '2px 0 0' }}>{rowMsg[s.id]}</p>}
                    </td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)', fontSize: 11 }}>{fmtWhen(s.lastPollAt)}</td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        <button onClick={() => startEdit(s)} title="Edit connection / update credentials" className="nb-btn-ghost" style={{ padding: 6 }}><PencilIcon size={13} /></button>
                        <button onClick={() => refresh(s)} disabled={refreshingId === s.id} title="Poll now" className="nb-btn-ghost" style={{ padding: 6 }}>
                          <RefreshIcon size={13} style={refreshingId === s.id ? { animation: 'nb-spin 0.8s linear infinite' } : undefined} />
                        </button>
                        <button onClick={() => remove(s)} disabled={deletingId === s.id} title="Delete" className="nb-btn-ghost" style={{ padding: 6, color: 'var(--nb-crit)', borderColor: 'rgba(248,113,113,0.4)' }}><TrashIcon size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ApplianceHardwareTab() {
  const [connections, setConnections] = React.useState(null);
  const [form, setForm] = React.useState({ ...HW_EMPTY });
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [refreshingId, setRefreshingId] = React.useState(null);
  const [deletingId, setDeletingId] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [rowMsg, setRowMsg] = React.useState({});

  const load = React.useCallback(() => apiGet('/appliance-connections').then((d) => setConnections(d.connections || [])).catch(() => setConnections([])), []);
  React.useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const blankForm = () => { setForm({ ...HW_EMPTY }); setTestResult(null); };

  const startEdit = (c) => {
    setEditingId(c.id);
    setForm({ name: c.name, host: c.host, port: c.port || 443, username: c.username || '', password: '', sslVerify: !!c.sslVerify, pollingIntervalMinutes: c.pollingIntervalMinutes || 15 });
    setTestResult(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const cancelEdit = () => { setEditingId(null); blankForm(); };

  const buildBody = () => {
    const body = { name: form.name.trim(), host: form.host.trim(), port: Number(form.port) || 443, username: form.username.trim(), sslVerify: !!form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15 };
    if (form.password) body.password = form.password;
    return body;
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body = editingId ? { id: editingId, ...buildBody() } : buildBody();
      const data = await apiSend('/appliance-connections/test', 'POST', body);
      setTestResult(data);
    } catch (err) {
      setTestResult(err.body || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const body = buildBody();
      if (editingId) {
        await apiSend(`/appliance-connections/${editingId}`, 'PUT', body);
        setSaveMsg({ ok: true, text: 'Connection updated' });
      } else {
        body.password = form.password;
        await apiSend('/appliance-connections', 'POST', body);
        setSaveMsg({ ok: true, text: 'Appliance connection registered — first poll started.' });
      }
      setEditingId(null);
      blankForm();
      await load();
    } catch (err) {
      setSaveMsg({ ok: false, text: err.body?.error || (editingId ? 'Update failed' : 'Registration failed') });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete appliance connection "${c.name}"? Its collected hardware data is removed.`)) return;
    setDeletingId(c.id);
    try {
      await apiSend(`/appliance-connections/${c.id}`, 'DELETE');
      await load();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [c.id]: err.body?.error || 'Remove failed' }));
    } finally {
      setDeletingId(null);
    }
  };

  const refresh = async (c) => {
    setRefreshingId(c.id);
    try {
      await apiSend(`/appliance-connections/${c.id}/refresh`, 'POST', {});
      await load();
    } catch (err) {
      setRowMsg((m) => ({ ...m, [c.id]: err.body?.error || 'Refresh failed' }));
    } finally {
      setRefreshingId(null);
    }
  };

  const canSubmit = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);

  return (
    <div>
      <div className="nb-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          {editingId ? <PencilIcon size={14} style={{ color: 'var(--nb-brand)' }} /> : <PlusIcon size={14} style={{ color: 'var(--nb-brand)' }} />}
          {editingId ? `Edit — ${form.name || 'connection'}` : 'Add an appliance management connection'}
        </p>
        <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', marginBottom: 16, lineHeight: 1.5 }}>
          Connects directly to a NetBackup appliance's management API to monitor disk, RAID, memory, network, PSU and fan health. Credentials are encrypted at rest.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }} className="nb-form-grid">
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Display name</label>
            <input value={form.name} onChange={set('name')} placeholder="Appliance 1" className="nb-input" spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Host / FQDN</label>
            <input value={form.host} onChange={set('host')} placeholder="appliance.company.com" className="nb-input" spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Port</label>
            <input type="number" min={1} max={65535} value={form.port} onChange={set('port')} className="nb-input" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Username</label>
            <input value={form.username} onChange={set('username')} className="nb-input" spellCheck={false} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Password{editingId ? <span style={{ fontWeight: 400, color: 'var(--nb-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder={editingId ? '•••••• (stored)' : ''} className="nb-input" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>Poll interval (minutes)</label>
            <input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={set('pollingIntervalMinutes')} className="nb-input" />
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.sslVerify} onChange={set('sslVerify')} style={{ cursor: 'pointer' }} />
            <span style={{ fontSize: 12, color: 'var(--nb-ink-muted)' }}>Verify TLS certificate (off = accept self-signed)</span>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={save} disabled={saving || !canSubmit} className="nb-btn-accent" style={{ opacity: saving || !canSubmit ? 0.5 : 1 }}>
            <SaveIcon size={14} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add connection'}
          </button>
          {editingId && <button onClick={cancelEdit} className="nb-btn-ghost"><XIcon size={14} /> Cancel</button>}
          <button onClick={test} disabled={testing || !form.host.trim()} className="nb-btn-ghost">
            {testing ? <Spinner size={13} /> : <PlugIcon size={14} />} Test connection
          </button>
          {testResult && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: testResult.ok ? 'var(--nb-ok)' : 'var(--nb-crit)' }}>
              {testResult.ok ? <CheckCircleIcon size={14} /> : <XCircleIcon size={14} />}
              {testResult.ok ? 'Connected' : testResult.error}
            </span>
          )}
          {saveMsg && <span style={{ fontSize: 12, color: saveMsg.ok ? 'var(--nb-ok)' : 'var(--nb-crit)' }}>{saveMsg.text}</span>}
        </div>
      </div>

      <div className="nb-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 12 }}>Registered Appliance Connections</p>
        {connections == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : connections.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--nb-ink-muted)', padding: '24px 0', textAlign: 'center' }}>None registered yet.</div>
        ) : (
          <div className="nb-scroll" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--nb-border)' }}>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Name</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Host</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Status</th>
                <th style={{ padding: '8px 12px 8px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Last Poll</th>
                <th style={{ padding: '8px 0', textAlign: 'right', fontSize: 11, textTransform: 'uppercase', color: 'var(--nb-ink-faint)' }}>Actions</th>
              </tr></thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--nb-border)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink)', whiteSpace: 'nowrap' }}>{c.name}</td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-muted)', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={c.host}>{c.host}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <Badge tone={c.lastPollStatus === 'error' ? 'crit' : c.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                        {c.lastPollStatus === 'error' ? 'Unreachable' : c.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                      </Badge>
                      {c.lastPollStatus === 'error' && c.lastPollError && (
                        <p style={{ fontSize: 10, color: 'var(--nb-crit)', margin: '2px 0 0', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.lastPollError}>{c.lastPollError}</p>
                      )}
                      {rowMsg[c.id] && <p style={{ fontSize: 10, color: 'var(--nb-crit)', margin: '2px 0 0' }}>{rowMsg[c.id]}</p>}
                    </td>
                    <td className="nb-tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--nb-ink-faint)', fontSize: 11 }}>{fmtWhen(c.lastPollAt)}</td>
                    <td style={{ padding: '8px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        <button onClick={() => startEdit(c)} title="Edit connection / update credentials" className="nb-btn-ghost" style={{ padding: 6 }}><PencilIcon size={13} /></button>
                        <button onClick={() => refresh(c)} disabled={refreshingId === c.id} title="Poll now" className="nb-btn-ghost" style={{ padding: 6 }}>
                          <RefreshIcon size={13} style={refreshingId === c.id ? { animation: 'nb-spin 0.8s linear infinite' } : undefined} />
                        </button>
                        <button onClick={() => remove(c)} disabled={deletingId === c.id} title="Delete" className="nb-btn-ghost" style={{ padding: 6, color: 'var(--nb-crit)', borderColor: 'rgba(248,113,113,0.4)' }}><TrashIcon size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertThresholdsPanel() {
  const [cfg, setCfg] = React.useState(null);
  const [successWarnPct, setSuccessWarnPct] = React.useState('');
  const [storageWarnPct, setStorageWarnPct] = React.useState('');
  const [staleBackupHours, setStaleBackupHours] = React.useState('');
  const [entitledTb, setEntitledTb] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  React.useEffect(() => {
    apiGet('/config').then((d) => {
      setCfg(d);
      setSuccessWarnPct(String(d.successWarnPct));
      setStorageWarnPct(String(d.storageWarnPct));
      setStaleBackupHours(String(d.staleBackupHours));
      setEntitledTb(d.entitledTb ? String(d.entitledTb) : '');
    }).catch(() => setCfg({ successWarnPct: 90, storageWarnPct: 20, staleBackupHours: 48 }));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const data = await apiSend('/config', 'PUT', {
        successWarnPct: Number(successWarnPct), storageWarnPct: Number(storageWarnPct), staleBackupHours: Number(staleBackupHours),
        entitledTb: Number(entitledTb) || 0,
      });
      setCfg(data);
      setSuccessWarnPct(String(data.successWarnPct));
      setStorageWarnPct(String(data.storageWarnPct));
      setStaleBackupHours(String(data.staleBackupHours));
      setEntitledTb(data.entitledTb ? String(data.entitledTb) : '');
      setMsg({ ok: true, text: 'Thresholds saved' });
    } catch (err) {
      setMsg({ ok: false, text: err.body?.error || 'Check the entered values.' });
    } finally {
      setSaving(false);
    }
  };

  if (cfg == null) {
    return <div className="nb-panel" style={{ padding: 16, marginTop: 16, borderTop: `3px solid ${BRAND}` }}><LoadingPanel label="Loading thresholds…" height={80} /></div>;
  }

  return (
    <div className="nb-panel" style={{ padding: 16, marginTop: 16, borderTop: `3px solid ${BRAND}` }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <BellIcon size={15} style={{ color: 'var(--nb-brand)' }} /> Alert Thresholds
      </p>
      <p style={{ fontSize: 11, color: 'var(--nb-ink-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Thresholds that drive the computed issues feed — success rate, storage headroom and stale-backup detection.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        {[
          ['successWarnPct', 'Success rate warning % (50–100)', successWarnPct, setSuccessWarnPct, 50, 100],
          ['storageWarnPct', 'Storage free warning % (5–50)', storageWarnPct, setStorageWarnPct, 5, 50],
          ['staleBackupHours', 'Stale backup hours (12–336)', staleBackupHours, setStaleBackupHours, 12, 336],
          ['entitledTb', 'Licensing Entitlement (TB)', entitledTb, setEntitledTb, 0, 100000],
        ].map(([key, label, val, setter, min, max]) => (
          <div key={key} style={{ width: 176 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--nb-ink)', marginBottom: 4 }}>{label}</label>
            <input type="number" min={min} max={max} value={val} onChange={(e) => setter(e.target.value)} className="nb-input" />
          </div>
        ))}
        <button onClick={save} disabled={saving} className="nb-btn-accent">{saving ? 'Saving…' : 'Save'}</button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--nb-ok)' : 'var(--nb-crit)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}
