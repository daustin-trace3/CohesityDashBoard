// Nutanix Settings — port of NxSettingsPage.jsx onto the nx- style kit.
// Side-menu sections: Prism Sources (PC|PE tabs), Move Appliances, Alert
// Thresholds. NO Mine section — it was removed from the built-in platform.
import {
  injectStyles, PageHeader, Badge, LoadingPanel, Spinner,
  GearIcon, ServerIcon, ArrowRightLeftIcon, BellIcon, PencilIcon, RefreshIcon, TrashIcon,
  CheckCircleIcon, XCircleIcon, fmtWhen,
} from '../ui.jsx';

injectStyles();

const BRAND = '#7855FA';
const iccCsrf = () => (typeof window !== 'undefined' ? window.__ICC_CSRF_TOKEN__ : null);
const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) });
const mutHeaders = () => ({ ...(iccCsrf() ? { 'x-csrf-token': iccCsrf() } : {}) });

async function apiGet(path) {
  const res = await fetch(`/api/nutanix${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}
async function apiSend(path, method, body) {
  const res = await fetch(`/api/nutanix${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? jsonHeaders() : mutHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const err = new Error(payload.error || `request failed: ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const inputStyle = {
  width: '100%', background: 'var(--nx-surface-overlay)', border: '1px solid var(--nx-border)',
  borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--nx-ink)', outline: 'none', boxSizing: 'border-box',
};
const labelStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--nx-ink)', marginBottom: 4 };
const btnPrimary = { padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'var(--nx-brand)', color: '#0B1015', border: 'none', cursor: 'pointer' };
const btnGhost = { padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: 'transparent', color: 'var(--nx-ink-muted)', border: '1px solid var(--nx-border)', cursor: 'pointer' };
const iconBtn = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 28, width: 28, borderRadius: 6, border: '1px solid var(--nx-border)', background: 'transparent', color: 'var(--nx-ink-muted)', cursor: 'pointer' };
const iconBtnCrit = { ...iconBtn, color: 'var(--nx-crit)', borderColor: 'rgba(248,113,113,0.4)' };

const PRISM_TABS = [
  { key: 'prism_central', label: 'Prism Central' },
  { key: 'prism_element', label: 'Prism Element' },
];

const SECTIONS = [
  { key: 'sources', label: 'Prism Sources', icon: ServerIcon, group: 'Connections' },
  { key: 'move', label: 'Move Appliances', icon: ArrowRightLeftIcon, group: 'Connections' },
  { key: 'thresholds', label: 'Alert Thresholds', icon: BellIcon, group: 'Tuning' },
];

const blankSourceForm = (sourceType) => ({
  name: '', host: '', port: 9440, username: '', password: '',
  sslVerify: false, pollingIntervalMinutes: 15, sourceType,
});

const th = { textAlign: 'left', padding: '8px 12px 8px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--nx-ink-faint)', borderBottom: '1px solid var(--nx-border)' };
const td = { padding: '8px 12px 8px 0', fontSize: 13, color: 'var(--nx-ink)', borderBottom: '1px solid var(--nx-border)' };
const tdMuted = { ...td, color: 'var(--nx-ink-muted)' };

function SourceTable({ sources, onEdit, onDelete, onPoll, pollingId }) {
  if (sources.length === 0) return <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '24px 0', textAlign: 'center' }}>None registered.</div>;
  return (
    <div className="nx-scroll" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Name</th><th style={th}>Host</th><th style={th}>Status</th><th style={th}>Last Poll</th>
          <th style={{ ...th, textAlign: 'right' }}>Clusters</th><th style={{ ...th, textAlign: 'right' }}>Actions</th>
        </tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id} className="nx-row">
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{s.name}{s.isCe && <Badge tone="info" style={{ marginLeft: 6 }}>CE</Badge>}</td>
              <td className="nx-tnum" style={{ ...tdMuted, whiteSpace: 'nowrap' }}>{s.host}:{s.port || 9440}</td>
              <td style={td}>
                <Badge tone={s.lastPollStatus === 'error' ? 'crit' : s.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                  {s.lastPollStatus === 'error' ? 'Unreachable' : s.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                </Badge>
                {s.lastPollStatus === 'error' && s.lastPollError && (
                  <p style={{ margin: '2px 0 0', fontSize: 10, color: 'var(--nx-crit)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.lastPollError}>{s.lastPollError}</p>
                )}
              </td>
              <td className="nx-tnum" style={{ ...tdMuted, fontSize: 11 }}>{fmtWhen(s.lastPollAt)}</td>
              <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{s.clusterCount ?? '—'}</td>
              <td style={td}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                  <button onClick={() => onEdit(s)} title="Edit connection" aria-label={`Edit ${s.name}`} style={iconBtn}><PencilIcon size={13} /></button>
                  <button onClick={() => onPoll(s)} disabled={pollingId === s.id} title="Poll now" aria-label={`Poll ${s.name} now`} style={iconBtn}>
                    <RefreshIcon size={13} style={pollingId === s.id ? { animation: 'nx-spin 0.8s linear infinite' } : undefined} />
                  </button>
                  <button onClick={() => onDelete(s)} title="Remove" aria-label={`Remove ${s.name}`} style={iconBtnCrit}><TrashIcon size={13} /></button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SettingsPage() {
  const [section, setSection] = React.useState('sources');
  const [tab, setTab] = React.useState('prism_central');
  const [sources, setSources] = React.useState(null);
  const [form, setForm] = React.useState(blankSourceForm('prism_central'));
  const [editingId, setEditingId] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [pollingId, setPollingId] = React.useState(null);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const [moveConns, setMoveConns] = React.useState(null);
  const [moveForm, setMoveForm] = React.useState({ name: '', host: '', username: '', password: '', sslVerify: false });
  const [moveEditingId, setMoveEditingId] = React.useState(null);
  const [moveSaving, setMoveSaving] = React.useState(false);
  const [moveSaveError, setMoveSaveError] = React.useState(null);
  const [movePollingId, setMovePollingId] = React.useState(null);

  const [config, setConfig] = React.useState(null);
  const [savingConfig, setSavingConfig] = React.useState(false);
  const [configMsg, setConfigMsg] = React.useState(null);

  const flash = (msg) => { setStatusMsg(msg); setTimeout(() => setStatusMsg(null), 4000); };

  const loadSources = React.useCallback(() => apiGet('/sources').then((d) => setSources(d.sources || [])).catch(() => setSources([])), []);
  const loadMoveConns = React.useCallback(() => apiGet('/move/connections').then((d) => setMoveConns(d.connections || [])).catch(() => setMoveConns([])), []);

  React.useEffect(() => {
    loadSources();
    loadMoveConns();
    apiGet('/config')
      .then((d) => setConfig(d))
      .catch(() => setConfig({ containerWarnPct: 85, containerCritPct: 95, clusterWarnPct: 80, clusterCritPct: 90, rpoGracePct: 50, runwayWarnDays: 90 }));
  }, [loadSources, loadMoveConns]);

  const set = (setter) => (k) => (e) => setter((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setF = set(setForm);
  const setMoveF = set(setMoveForm);

  const switchTab = (k) => {
    setTab(k);
    setEditingId(null);
    setForm(blankSourceForm(k));
    setTestResult(null);
    setSaveError(null);
  };

  const testSource = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiSend('/sources/test', 'POST', {
        sourceType: form.sourceType, host: form.host.trim(), port: Number(form.port) || 9440,
        username: form.username.trim(), password: form.password || undefined, sslVerify: form.sslVerify,
      });
      setTestResult(data);
    } catch (err) {
      setTestResult(err.payload || { ok: false, error: 'Connection test failed.' });
    } finally {
      setTesting(false);
    }
  };

  const startEditSource = (s) => {
    setTab(s.sourceType);
    setEditingId(s.id);
    setForm({
      name: s.name, host: s.host, port: s.port || 9440, username: s.username || '', password: '',
      sslVerify: !!s.sslVerify, pollingIntervalMinutes: s.pollingIntervalMinutes || 15, sourceType: s.sourceType,
    });
    setTestResult(null);
    setSaveError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEditSource = () => { setEditingId(null); setForm(blankSourceForm(tab)); setTestResult(null); setSaveError(null); };

  const saveSource = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        name: form.name.trim(), sourceType: form.sourceType, host: form.host.trim(),
        port: Number(form.port) || 9440, username: form.username.trim(),
        sslVerify: form.sslVerify, pollingIntervalMinutes: Number(form.pollingIntervalMinutes) || 15,
      };
      if (editingId) {
        if (form.password) body.password = form.password;
        await apiSend(`/sources/${editingId}`, 'PUT', body);
        flash(form.password ? 'Source updated — credentials replaced.' : 'Source updated — stored password unchanged.');
      } else {
        body.password = form.password;
        await apiSend('/sources', 'POST', body);
        flash('Source registered — first poll started.');
      }
      setEditingId(null);
      setForm(blankSourceForm(tab));
      setTestResult(null);
      await loadSources();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (s) => {
    if (!window.confirm(`Remove source "${s.name}"? Its collected inventory is deleted.`)) return;
    try {
      await apiSend(`/sources/${s.id}`, 'DELETE');
      await loadSources();
      flash(`Removed ${s.name}`);
    } catch (err) {
      setSaveError(err.message);
    }
  };

  const pollSource = async (s) => {
    setPollingId(s.id);
    try {
      await apiSend(`/sources/${s.id}/poll`, 'POST');
      await loadSources();
      flash(`${s.name} polled`);
    } catch (err) {
      setSaveError(`Poll failed for ${s.name}: ${err.message}`);
    } finally {
      setPollingId(null);
    }
  };

  const canSubmitSource = form.name.trim() && form.host.trim() && form.username.trim() && (editingId || form.password);
  const tabSources = (sources || []).filter((s) => s.sourceType === tab);

  const startEditMove = (c) => {
    setMoveEditingId(c.id);
    setMoveForm({ name: c.name, host: c.host, username: c.username || '', password: '', sslVerify: !!c.sslVerify });
  };
  const cancelEditMove = () => { setMoveEditingId(null); setMoveForm({ name: '', host: '', username: '', password: '', sslVerify: false }); setMoveSaveError(null); };

  const saveMove = async () => {
    setMoveSaving(true);
    setMoveSaveError(null);
    try {
      const body = { name: moveForm.name.trim(), host: moveForm.host.trim(), username: moveForm.username.trim(), sslVerify: moveForm.sslVerify };
      if (moveEditingId) {
        if (moveForm.password) body.password = moveForm.password;
        await apiSend(`/move/connections/${moveEditingId}`, 'PUT', body);
        flash('Move appliance updated');
      } else {
        body.password = moveForm.password;
        await apiSend('/move/connections', 'POST', body);
        flash('Move appliance registered');
      }
      cancelEditMove();
      await loadMoveConns();
    } catch (err) {
      setMoveSaveError(err.message);
    } finally {
      setMoveSaving(false);
    }
  };

  const deleteMove = async (c) => {
    if (!window.confirm(`Remove Move appliance "${c.name}"?`)) return;
    try {
      await apiSend(`/move/connections/${c.id}`, 'DELETE');
      await loadMoveConns();
      flash(`Removed ${c.name}`);
    } catch (err) {
      setMoveSaveError(err.message);
    }
  };

  const pollMove = async (c) => {
    setMovePollingId(c.id);
    try {
      await apiSend(`/move/connections/${c.id}/poll`, 'POST');
      await loadMoveConns();
      flash(`${c.name} polled`);
    } catch (err) {
      setMoveSaveError(`Poll failed for ${c.name}: ${err.message}`);
    } finally {
      setMovePollingId(null);
    }
  };

  const canSubmitMove = moveForm.name.trim() && moveForm.host.trim() && moveForm.username.trim() && (moveEditingId || moveForm.password);

  const saveConfig = async () => {
    setSavingConfig(true);
    setConfigMsg(null);
    try {
      const data = await apiSend('/config', 'PUT', {
        containerWarnPct: Number(config.containerWarnPct), containerCritPct: Number(config.containerCritPct),
        clusterWarnPct: Number(config.clusterWarnPct), clusterCritPct: Number(config.clusterCritPct),
        rpoGracePct: Number(config.rpoGracePct), runwayWarnDays: Number(config.runwayWarnDays),
      });
      setConfig(data);
      setConfigMsg({ ok: true, text: 'Thresholds saved' });
    } catch (err) {
      setConfigMsg({ ok: false, text: err.message });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="nx-root nx-fade-in">
      <PageHeader icon={GearIcon} title="Nutanix Settings" description="Register Prism Central / Prism Element sources and Move appliances">
        {statusMsg && <span style={{ fontSize: 12, color: 'var(--nx-brand)' }}>{statusMsg}</span>}
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 16, width: 192, flexShrink: 0 }} aria-label="Nutanix settings sections">
          {['Connections', 'Tuning'].map((g) => (
            <div key={g} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--nx-ink-faint)', padding: '0 8px', marginBottom: 4 }}>{g}</p>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const Icon = s.icon;
                const active = section === s.key;
                return (
                  <button key={s.key} onClick={() => setSection(s.key)} aria-current={active ? 'page' : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                      textAlign: 'left', cursor: 'pointer', border: 'none',
                      background: active ? 'var(--nx-surface-overlay)' : 'transparent',
                      color: active ? 'var(--nx-ink)' : 'var(--nx-ink-muted)',
                    }}>
                    <Icon size={13} style={{ color: active ? 'var(--nx-brand)' : undefined }} /> {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div style={{ flex: 1, minWidth: 0, maxWidth: 760 }}>
          {section === 'sources' && (<>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12 }}>
              {PRISM_TABS.map((t) => (
                <button key={t.key} onClick={() => switchTab(t.key)}
                  style={{
                    padding: '6px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    border: tab === t.key ? '1px solid rgba(120,85,250,0.3)' : '1px solid transparent',
                    background: tab === t.key ? 'rgba(120,85,250,0.1)' : 'transparent',
                    color: tab === t.key ? 'var(--nx-brand)' : 'var(--nx-ink-muted)',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="nx-panel" style={{ padding: 16, marginBottom: 16, borderTop: `3px solid ${BRAND}` }}>
              <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <ServerIcon size={15} style={{ color: 'var(--nx-brand)' }} /> {editingId ? `Edit — ${form.name || 'source'}` : `Add a ${PRISM_TABS.find((t) => t.key === tab)?.label}`}
              </p>
              <p style={{ margin: '0 0 16px', fontSize: 11, color: 'var(--nx-ink-muted)', lineHeight: 1.5 }}>
                A read-only Prism account is sufficient for inventory. The password is encrypted at rest.
              </p>
              {saveError && <p style={{ color: 'var(--nx-crit)', fontSize: 12, marginBottom: 12 }}>{saveError}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 12 }} className="nx-form-grid">
                <style>{`@media (max-width: 560px) { .nx-form-grid { grid-template-columns: 1fr !important; } }`}</style>
                <div><label style={labelStyle}>Display name</label><input value={form.name} onChange={setF('name')} placeholder="Prod Prism Central" style={inputStyle} spellCheck={false} /></div>
                <div><label style={labelStyle}>Host / IP</label><input value={form.host} onChange={setF('host')} placeholder="prism.company.com" style={inputStyle} spellCheck={false} /></div>
                <div><label style={labelStyle}>Port</label><input type="number" value={form.port} onChange={setF('port')} style={inputStyle} /></div>
                <div><label style={labelStyle}>Poll interval (minutes)</label><input type="number" min={5} max={1440} value={form.pollingIntervalMinutes} onChange={setF('pollingIntervalMinutes')} style={inputStyle} /></div>
                <div><label style={labelStyle}>Username</label><input value={form.username} onChange={setF('username')} placeholder="monitor" style={inputStyle} spellCheck={false} /></div>
                <div>
                  <label style={labelStyle}>Password{editingId ? <span style={{ fontWeight: 400, color: 'var(--nx-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
                  <input type="password" value={form.password} onChange={setF('password')} placeholder={editingId ? '•••••• (stored)' : ''} style={inputStyle} />
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.sslVerify} onChange={setF('sslVerify')} style={{ cursor: 'pointer' }} />
                  <span style={{ fontSize: 12, color: 'var(--nx-ink-muted)' }}>Verify TLS certificate (off = accept self-signed)</span>
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={saveSource} disabled={saving || !canSubmitSource} style={{ ...btnPrimary, opacity: saving || !canSubmitSource ? 0.5 : 1, cursor: saving || !canSubmitSource ? 'default' : 'pointer' }}>
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add source'}
                </button>
                {editingId && <button onClick={cancelEditSource} style={btnGhost}>Cancel</button>}
                <button onClick={testSource} disabled={testing || !form.host.trim() || !form.username.trim()}
                  style={{ ...btnGhost, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {testing && <Spinner size={13} />} Test connection
                </button>
                {testResult && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: testResult.ok ? 'var(--nx-ok)' : 'var(--nx-crit)' }}>
                    {testResult.ok ? <CheckCircleIcon size={14} /> : <XCircleIcon size={14} />}
                    {testResult.ok ? `Connected${testResult.productVersion ? ` — ${testResult.apiFlavor || ''} ${testResult.productVersion}` : ''}` : testResult.error}
                  </span>
                )}
              </div>
            </div>

            <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
              <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)' }}>Registered {PRISM_TABS.find((t) => t.key === tab)?.label} Sources</p>
              {sources == null ? <LoadingPanel label="Loading…" height={100} /> : (
                <SourceTable sources={tabSources} onEdit={startEditSource} onDelete={deleteSource} onPoll={pollSource} pollingId={pollingId} />
              )}
            </div>
          </>)}

          {section === 'move' && (
            <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
              <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <ArrowRightLeftIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Move Appliances
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--nx-ink-muted)', lineHeight: 1.5 }}>Migration appliances polled independently of Prism sources.</p>
              {moveSaveError && <p style={{ color: 'var(--nx-crit)', fontSize: 12, marginBottom: 12 }}>{moveSaveError}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 12, marginBottom: 12 }} className="nx-form-grid">
                <div><label style={labelStyle}>Display name</label><input value={moveForm.name} onChange={setMoveF('name')} placeholder="Move Appliance" style={inputStyle} spellCheck={false} /></div>
                <div><label style={labelStyle}>Host / IP</label><input value={moveForm.host} onChange={setMoveF('host')} style={inputStyle} spellCheck={false} /></div>
                <div><label style={labelStyle}>Username</label><input value={moveForm.username} onChange={setMoveF('username')} placeholder="admin" style={inputStyle} spellCheck={false} /></div>
                <div>
                  <label style={labelStyle}>Password{moveEditingId ? <span style={{ fontWeight: 400, color: 'var(--nx-ink-faint)' }}> — stored, leave blank to keep</span> : ''}</label>
                  <input type="password" value={moveForm.password} onChange={setMoveF('password')} placeholder={moveEditingId ? '•••••• (stored)' : ''} style={inputStyle} />
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={moveForm.sslVerify} onChange={setMoveF('sslVerify')} style={{ cursor: 'pointer' }} />
                  <span style={{ fontSize: 12, color: 'var(--nx-ink-muted)' }}>Verify TLS certificate</span>
                </label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <button onClick={saveMove} disabled={moveSaving || !canSubmitMove} style={{ ...btnPrimary, opacity: moveSaving || !canSubmitMove ? 0.5 : 1, cursor: moveSaving || !canSubmitMove ? 'default' : 'pointer' }}>
                  {moveSaving ? 'Saving…' : moveEditingId ? 'Save changes' : 'Add Move appliance'}
                </button>
                {moveEditingId && <button onClick={cancelEditMove} style={btnGhost}>Cancel</button>}
              </div>
              {moveConns == null ? <LoadingPanel label="Loading…" height={80} /> : moveConns.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--nx-ink-muted)', padding: '16px 0', textAlign: 'center' }}>None registered.</div>
              ) : (
                <div className="nx-scroll" style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Name</th><th style={th}>Host</th><th style={th}>Status</th>
                      <th style={{ ...th, textAlign: 'right' }}>Plans</th><th style={{ ...th, textAlign: 'right' }}>Actions</th>
                    </tr></thead>
                    <tbody>
                      {moveConns.map((c) => (
                        <tr key={c.id} className="nx-row">
                          <td style={td}>{c.name}</td>
                          <td className="nx-tnum" style={tdMuted}>{c.host}</td>
                          <td style={td}>
                            <Badge tone={c.lastPollStatus === 'error' ? 'crit' : c.lastPollStatus === 'success' ? 'ok' : 'neutral'}>
                              {c.lastPollStatus === 'error' ? 'Unreachable' : c.lastPollStatus === 'success' ? 'Up' : 'Pending'}
                            </Badge>
                          </td>
                          <td className="nx-tnum" style={{ ...tdMuted, textAlign: 'right' }}>{c.planCount ?? '—'}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                              <button onClick={() => startEditMove(c)} style={iconBtn}><PencilIcon size={13} /></button>
                              <button onClick={() => pollMove(c)} disabled={movePollingId === c.id} style={iconBtn}>
                                <RefreshIcon size={13} style={movePollingId === c.id ? { animation: 'nx-spin 0.8s linear infinite' } : undefined} />
                              </button>
                              <button onClick={() => deleteMove(c)} style={iconBtnCrit}><TrashIcon size={13} /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {section === 'thresholds' && (
            <div className="nx-panel" style={{ padding: 16, borderTop: `3px solid ${BRAND}` }}>
              <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--nx-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <BellIcon size={15} style={{ color: 'var(--nx-brand)' }} /> Alert Thresholds
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--nx-ink-muted)', lineHeight: 1.5 }}>Container/cluster storage warning and critical levels, RPO grace percentage, and capacity-runway warning window.</p>
              {config == null ? <LoadingPanel label="Loading…" height={80} /> : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 12 }} className="nx-threshold-grid">
                    <style>{`@media (max-width: 640px) { .nx-threshold-grid { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
                    <div><label style={labelStyle}>Container warn %</label><input type="number" min={1} max={100} value={config.containerWarnPct} onChange={(e) => setConfig((c) => ({ ...c, containerWarnPct: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Container critical %</label><input type="number" min={1} max={100} value={config.containerCritPct} onChange={(e) => setConfig((c) => ({ ...c, containerCritPct: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Runway warning (days)</label><input type="number" min={1} max={365} value={config.runwayWarnDays} onChange={(e) => setConfig((c) => ({ ...c, runwayWarnDays: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Cluster warn %</label><input type="number" min={1} max={100} value={config.clusterWarnPct} onChange={(e) => setConfig((c) => ({ ...c, clusterWarnPct: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>Cluster critical %</label><input type="number" min={1} max={100} value={config.clusterCritPct} onChange={(e) => setConfig((c) => ({ ...c, clusterCritPct: e.target.value }))} style={inputStyle} /></div>
                    <div><label style={labelStyle}>RPO grace %</label><input type="number" min={0} max={200} value={config.rpoGracePct} onChange={(e) => setConfig((c) => ({ ...c, rpoGracePct: e.target.value }))} style={inputStyle} /></div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button onClick={saveConfig} disabled={savingConfig} style={{ ...btnPrimary, opacity: savingConfig ? 0.5 : 1, cursor: savingConfig ? 'default' : 'pointer' }}>
                      {savingConfig ? 'Saving…' : 'Save'}
                    </button>
                    {configMsg && <span style={{ fontSize: 12, color: configMsg.ok ? 'var(--nx-ok)' : 'var(--nx-crit)' }}>{configMsg.text}</span>}
                  </div>
                </>
              )}
            </div>
          )}

          <p style={{ fontSize: 11, color: 'var(--nx-ink-faint)', marginTop: 12, lineHeight: 1.5 }}>
            The Nutanix platform tab itself is enabled from Global Settings (gear icon → Platforms).
          </p>
        </div>
      </div>
    </div>
  );
}
