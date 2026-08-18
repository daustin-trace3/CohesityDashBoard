// NetApp Settings — ported from frontend/src/pages/netapp/NetAppSettingsPage.jsx.
// Mirrors backend/routes/netapp.js's AIQUM gateway CRUD + direct-cluster CRUD
// contract exactly (same endpoints, same payload shapes).
import { Settings, Server, Cloud, Play, Pencil, Trash2, Plus, Save, PlugZap, Clock } from '../icons.jsx';
import { apiFetch, PageHeader, LoadingPanel, Badge, RefreshButton, BRAND } from '../ui.jsx';

const inp = 'na-input';

const TABS = [
  { key: 'aiqum', label: 'AIQUM (Unified Manager)', icon: Cloud },
  { key: 'direct', label: 'Direct Clusters', icon: Server },
];

const emptyDirectForm = { name: '', mgmt_host: '', username: '', password: '', polling_interval_minutes: 15, ssl_verify: false };
const emptyAiqumForm = { name: '', host: '', username: '', password: '', pollIntervalMin: 15 };

function Field({ label, hint, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--na-ink-faint)', marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 11, color: 'var(--na-ink-faint)', marginTop: 4 }}>{hint}</p>}
    </div>
  );
}

function shortVersion(v) {
  const m = String(v || '').match(/(\d+\.\d+\.\d+\S*)/);
  return m ? m[1] : (v || '—');
}

const btnGhost = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--na-border)', background: 'transparent', color: 'var(--na-ink-muted)', cursor: 'pointer' };
const btnBrand = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(0,103,197,0.3)', background: 'rgba(0,103,197,0.1)', color: BRAND, cursor: 'pointer' };
const btnText = { fontSize: 12, fontWeight: 500, padding: '6px 12px', color: 'var(--na-ink-faint)', background: 'transparent', border: 'none', cursor: 'pointer' };
const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--na-border)', background: 'transparent', color: 'var(--na-ink-muted)', cursor: 'pointer' };

export default function SettingsPage() {
  const [tab, setTab] = React.useState('aiqum');
  const [cfg, setCfg] = React.useState(null);
  const [clusters, setClusters] = React.useState(null);
  const [aiqumMode, setAiqumMode] = React.useState(null);
  const [aiqumForm, setAiqumForm] = React.useState(emptyAiqumForm);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [polling, setPolling] = React.useState(false);
  const [pollingId, setPollingId] = React.useState(null);
  const [testResult, setTestResult] = React.useState(null);
  const [status, setStatus] = React.useState(null);

  const [directMode, setDirectMode] = React.useState(null);
  const [directForm, setDirectForm] = React.useState(emptyDirectForm);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directTesting, setDirectTesting] = React.useState(false);
  const [directTestResult, setDirectTestResult] = React.useState(null);
  const [directError, setDirectError] = React.useState(null);
  const [directDeleting, setDirectDeleting] = React.useState(null);

  const flash = (type, title, message) => {
    setStatus({ type, title, message });
    setTimeout(() => setStatus((s) => (s?.title === title ? null : s)), 5000);
  };

  const load = React.useCallback(() => Promise.allSettled([
    apiFetch('/netapp/aiqum'), apiFetch('/netapp/arrays'),
  ]).then(([c, a]) => {
    setCfg(c.status === 'fulfilled' ? c.value : { configured: false, instances: [] });
    setClusters(a.status === 'fulfilled' ? a.value : []);
  }), []);

  React.useEffect(() => { load(); }, [load]);

  const setAF = (k, v) => setAiqumForm((f) => ({ ...f, [k]: v }));
  const openAddAiqum = () => { setAiqumMode('add'); setAiqumForm(emptyAiqumForm); setTestResult(null); };
  const openEditAiqum = (row) => {
    setAiqumMode({ edit: row });
    setAiqumForm({ name: row.name || '', host: row.host, username: '', password: '', pollIntervalMin: row.pollIntervalMin || 15 });
    setTestResult(null);
  };
  const closeAiqumForm = () => { setAiqumMode(null); setTestResult(null); };
  const isAiqumEdit = aiqumMode && aiqumMode !== 'add';
  const canSaveAiqum = aiqumForm.host.trim() && (isAiqumEdit || (aiqumForm.username.trim() && aiqumForm.password));
  const canTestAiqum = aiqumForm.host.trim() && (isAiqumEdit || (aiqumForm.username.trim() && aiqumForm.password));

  const aiqumSave = async () => {
    setSaving(true);
    const payload = { name: aiqumForm.name.trim() || undefined, host: aiqumForm.host.trim(), pollIntervalMin: Number(aiqumForm.pollIntervalMin) || 15 };
    if (aiqumForm.username.trim()) payload.username = aiqumForm.username.trim();
    if (aiqumForm.password) payload.password = aiqumForm.password;
    try {
      if (isAiqumEdit) await apiFetch(`/netapp/aiqum/instances/${aiqumMode.edit.id}`, { method: 'PUT', body: payload });
      else await apiFetch('/netapp/aiqum/instances', { method: 'POST', body: payload });
      flash('success', isAiqumEdit ? 'Gateway updated' : 'Gateway added', payload.host);
      setAiqumMode(null);
      load();
    } catch (err) {
      flash('error', 'Save failed', err?.payload?.error || 'Could not save.');
    } finally { setSaving(false); }
  };

  const testConn = async () => {
    setTesting(true); setTestResult(null);
    try {
      const payload = { host: aiqumForm.host.trim(), username: aiqumForm.username.trim() || undefined, password: aiqumForm.password || undefined };
      if (isAiqumEdit && !aiqumForm.password) payload.id = aiqumMode.edit.id;
      const data = await apiFetch('/netapp/aiqum/test', { method: 'POST', body: payload });
      setTestResult(data.ok ? { ok: true, msg: `Connected · ${data.clusterCount} clusters managed (${(data.clusters || []).join(', ')})` } : { ok: false, msg: data.error });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.payload?.error || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const aiqumDelete = async (row) => {
    if (!window.confirm(`Removing gateway "${row.name || row.host}" also removes its ${row.clusterCount} discovered cluster(s) and their collected history.`)) return;
    try {
      await apiFetch(`/netapp/aiqum/instances/${row.id}`, { method: 'DELETE' });
      flash('success', 'Gateway removed', row.host);
      load();
    } catch (err) {
      flash('error', 'Delete failed', err?.payload?.error || 'Delete failed.');
    }
  };

  const aiqumPollOne = async (row) => {
    setPolling(true);
    try {
      await apiFetch(`/netapp/aiqum/instances/${row.id}/poll`, { method: 'POST', body: {} });
      flash('success', 'Discovery + poll triggered', row.name || row.host);
      setTimeout(load, 1500);
    } catch (err) {
      flash('error', 'Poll failed', err?.payload?.error || 'Poll failed.');
    } finally { setPolling(false); }
  };

  const pollAll = async () => {
    setPolling(true);
    try { await apiFetch('/netapp/poll', { method: 'POST', body: {} }); flash('success', 'Discovery + poll triggered'); setTimeout(load, 1500); }
    catch (err) { flash('error', 'Poll failed', err?.payload?.error || 'Poll failed.'); }
    finally { setPolling(false); }
  };

  const pollOne = async (c) => {
    setPollingId(c.id);
    try { await apiFetch(`/netapp/arrays/${c.id}/poll`, { method: 'POST', body: {} }); flash('success', 'Poll triggered', c.name); }
    catch (err) { flash('error', 'Poll failed', err?.payload?.error || 'Poll failed.'); }
    finally { setPollingId(null); }
  };

  const directRows = (clusters || []).filter((c) => c.source === 'direct');
  const setDF = (key, val) => setDirectForm((f) => ({ ...f, [key]: val }));

  const openAddDirect = () => { setDirectMode('add'); setDirectForm(emptyDirectForm); setDirectTestResult(null); setDirectError(null); };
  const openEditDirect = (row) => {
    setDirectMode({ edit: row });
    setDirectForm({ name: row.name, mgmt_host: row.mgmt_host, username: '', password: '', polling_interval_minutes: row.polling_interval_minutes || 15, ssl_verify: !!row.ssl_verify });
    setDirectTestResult(null); setDirectError(null);
  };
  const closeDirectForm = () => setDirectMode(null);

  const canSaveDirect = directForm.name.trim() && directForm.mgmt_host.trim() && (directMode !== 'add' || (directForm.username.trim() && directForm.password));
  const canTestDirect = directForm.mgmt_host.trim() && (directForm.password || directMode !== 'add');

  const directSave = async () => {
    setDirectSaving(true); setDirectError(null);
    const isEdit = directMode !== 'add';
    const payload = {
      name: directForm.name.trim(), mgmt_host: directForm.mgmt_host.trim(),
      polling_interval_minutes: Number(directForm.polling_interval_minutes) || 15, ssl_verify: !!directForm.ssl_verify,
    };
    if (!isEdit || directForm.username.trim()) payload.username = directForm.username.trim();
    if (!isEdit || directForm.password) payload.password = directForm.password;
    try {
      if (isEdit) await apiFetch(`/netapp/arrays/${directMode.edit.id}`, { method: 'PUT', body: payload });
      else await apiFetch('/netapp/arrays', { method: 'POST', body: payload });
      flash('success', isEdit ? 'Cluster updated' : 'Cluster added', payload.name);
      setDirectMode(null);
      load();
    } catch (err) {
      setDirectError(err?.payload?.error || 'Save failed.');
    } finally { setDirectSaving(false); }
  };

  const directTest = async () => {
    setDirectTesting(true); setDirectTestResult(null);
    try {
      const payload = {
        mgmt_host: directForm.mgmt_host.trim(), username: directForm.username.trim() || undefined,
        password: directForm.password || undefined, ssl_verify: !!directForm.ssl_verify,
      };
      if (directMode !== 'add' && !directForm.password) payload.id = directMode.edit.id;
      const data = await apiFetch('/netapp/arrays/test', { method: 'POST', body: payload });
      setDirectTestResult(data.ok ? { ok: true, msg: `Connected · ONTAP ${data.version || '—'} (${data.name || directForm.name})` } : { ok: false, msg: data.error });
    } catch (err) {
      setDirectTestResult({ ok: false, msg: err?.payload?.error || 'Connection failed' });
    } finally { setDirectTesting(false); }
  };

  const directDelete = async (row) => {
    if (!window.confirm('Removing a cluster deletes its collected history.')) return;
    setDirectDeleting(row.id);
    try {
      await apiFetch(`/netapp/arrays/${row.id}`, { method: 'DELETE' });
      flash('success', 'Cluster removed', row.name);
      load();
    } catch (err) {
      flash('error', 'Delete failed', err?.payload?.error || 'Delete failed.');
    } finally { setDirectDeleting(null); }
  };

  if (cfg == null) {
    return (
      <div className="animate-fade-in max-w-3xl">
        <PageHeader icon={Settings} title="NetApp Settings" description="Active IQ Unified Manager connection" />
        <LoadingPanel label="Loading settings…" height={160} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="NetApp Settings" description="Manage AIQUM and direct ONTAP cluster connections">
        <RefreshButton onClick={load} />
      </PageHeader>

      {status && (
        <div className="panel p-3 mb-4 text-xs" style={{ color: status.type === 'error' ? 'var(--na-crit)' : 'var(--na-ok)' }}>
          <b>{status.title}</b>{status.message ? ` — ${status.message}` : ''}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--na-surface)', border: '1px solid var(--na-border)', padding: 4, width: 'fit-content', marginBottom: 16 }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', background: active ? 'var(--na-surface-overlay)' : 'transparent', color: active ? 'var(--na-ink)' : 'var(--na-ink-muted)' }}>
              <Icon size={13} style={{ color: active ? BRAND : undefined }} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'aiqum' && (
        <>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2"><Cloud size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">AIQUM Gateways</p></div>
              <div className="flex items-center gap-1.5">
                {!aiqumMode && <button onClick={openAddAiqum} style={btnBrand}><Plus size={13} /> Add gateway</button>}
                <button onClick={pollAll} disabled={polling || !cfg.configured} style={{ ...btnGhost, opacity: (polling || !cfg.configured) ? 0.4 : 1 }}>
                  <Play size={13} /> {polling ? 'Collecting…' : 'Discover + poll all'}
                </button>
              </div>
            </div>

            {aiqumMode && (
              <div style={{ border: '1px solid var(--na-border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
                <p className="text-xs font-semibold text-ink mb-3">{isAiqumEdit ? `Edit gateway — ${aiqumMode.edit.name || aiqumMode.edit.host}` : 'Add AIQUM gateway'}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Name" hint="Friendly label (defaults to the host).">
                    <input value={aiqumForm.name} onChange={(e) => setAF('name', e.target.value)} className={inp} />
                  </Field>
                  <Field label="AIQUM host" hint="Base URL of the Unified Manager appliance.">
                    <input value={aiqumForm.host} onChange={(e) => setAF('host', e.target.value)} placeholder="https://aiqum.example.com" className={inp} spellCheck={false} />
                  </Field>
                  <Field label="Username" hint={isAiqumEdit ? 'Leave blank to keep the stored username.' : 'AIQUM account (Operator/read-only is sufficient).'}>
                    <input value={aiqumForm.username} onChange={(e) => setAF('username', e.target.value)} placeholder={isAiqumEdit ? '•••••• (stored — leave blank to keep)' : 'operator'} className={inp} autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label="Password" hint={isAiqumEdit ? 'Leave blank to keep the stored password.' : 'Stored encrypted.'}>
                    <input type="password" value={aiqumForm.password} onChange={(e) => setAF('password', e.target.value)} placeholder={isAiqumEdit ? '•••••• (stored — leave blank to keep)' : '••••••'} className={inp} autoComplete="new-password" />
                  </Field>
                  <Field label="Poll interval (min)" hint="How often this gateway discovers clusters and collects data.">
                    <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={5} max={1440} value={aiqumForm.pollIntervalMin} onChange={(e) => setAF('pollIntervalMin', e.target.value)} className={inp} /></div>
                  </Field>
                </div>
                <p style={{ fontSize: 11, color: 'var(--na-ink-faint)', marginTop: 8 }}>
                  Requires an AIQUM user with at least the Operator role (Settings → Users in Unified Manager).
                </p>
                {testResult && <p style={{ fontSize: 12, marginTop: 8, color: testResult.ok ? 'var(--na-ok)' : 'var(--na-crit)' }}>{testResult.ok ? '✓ ' : '✗ '}{testResult.msg}</p>}
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={testConn} disabled={testing || !canTestAiqum} style={{ ...btnGhost, opacity: (testing || !canTestAiqum) ? 0.4 : 1 }}><PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}</button>
                  <button onClick={aiqumSave} disabled={saving || !canSaveAiqum} style={{ ...btnBrand, opacity: (saving || !canSaveAiqum) ? 0.4 : 1 }}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
                  <button onClick={closeAiqumForm} style={btnText}>Cancel</button>
                </div>
              </div>
            )}

            {(cfg.instances || []).length === 0 ? (
              <div className="text-sm text-ink-muted p-6 text-center">No AIQUM gateways configured yet. Add one to discover its managed clusters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                    <th className="py-2 pr-3">Gateway</th><th className="py-2 pr-3">Host</th><th className="py-2 pr-3">Poll interval</th><th className="py-2 pr-3">Clusters</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {cfg.instances.map((g) => (
                      <tr key={g.id} className="border-b">
                        <td className="py-2 pr-3 text-ink font-medium">{g.name || g.host}</td>
                        <td className="py-2 pr-3 text-ink-muted">{g.host}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{g.pollIntervalMin}m</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{g.clusterCount}</td>
                        <td className="py-2 pr-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button onClick={() => aiqumPollOne(g)} disabled={polling} style={{ ...iconBtn, opacity: polling ? 0.4 : 1 }}><Play size={12} /> Poll</button>
                            <button onClick={() => openEditAiqum(g)} style={iconBtn}><Pencil size={12} /> Edit</button>
                            <button onClick={() => aiqumDelete(g)} style={iconBtn}><Trash2 size={12} /> Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 mb-3"><Server size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Managed Clusters</p></div>
            {clusters == null ? (
              <LoadingPanel label="Loading clusters…" height={100} />
            ) : clusters.length === 0 ? (
              <div className="text-sm text-ink-muted p-6 text-center">No clusters discovered yet. Save a valid AIQUM connection, then "Discover + poll now".</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                    <th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">ONTAP</th><th className="py-2 pr-3">Management IP</th><th className="py-2 pr-3">Source</th><th className="py-2 pr-3">Gateway</th><th className="py-2 pr-3"></th>
                  </tr></thead>
                  <tbody>
                    {clusters.map((c) => (
                      <tr key={c.id} className="border-b">
                        <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{shortVersion(c.version)}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum">{c.management_ip || '—'}</td>
                        <td className="py-2 pr-3"><Badge tone="info">{c.source === 'aiqum' ? 'AIQUM gateway' : c.source}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]">
                          {c.source === 'aiqum' ? ((cfg.instances || []).find((g) => g.id === c.aiqum_instance_id)?.name || '—') : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button onClick={() => pollOne(c)} disabled={pollingId === c.id} style={{ ...iconBtn, opacity: pollingId === c.id ? 0.4 : 1 }}><Play size={12} /> {pollingId === c.id ? 'Polling…' : 'Poll'}</button>
                            <button
                              onClick={() => {
                                if (c.source === 'direct') { setTab('direct'); openEditDirect(c); }
                                else {
                                  const gw = (cfg.instances || []).find((g) => g.id === c.aiqum_instance_id) || (cfg.instances || [])[0];
                                  if (gw) { openEditAiqum(gw); window.scrollTo({ top: 0, behavior: 'smooth' }); }
                                  else flash('error', 'No gateway found', 'This cluster has no AIQUM gateway on record — run a discovery poll first.');
                                }
                              }}
                              style={iconBtn}><Pencil size={12} /> Credentials</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ fontSize: 11, color: 'var(--na-ink-faint)', marginTop: 12 }}>Clusters are discovered automatically from AIQUM — there is no per-cluster registration. Removing a cluster from AIQUM removes it here on the next poll.</p>
          </div>
        </>
      )}

      {tab === 'direct' && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2"><Server size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Direct ONTAP Clusters</p></div>
            {!directMode && <button onClick={openAddDirect} style={btnBrand}><Plus size={13} /> Add cluster</button>}
          </div>

          {directMode && (
            <div style={{ border: '1px solid var(--na-border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <p className="text-xs font-semibold text-ink mb-3">{directMode === 'add' ? 'Add direct cluster' : `Edit — ${directMode.edit.name}`}</p>
              {directError && <p style={{ fontSize: 12, color: 'var(--na-crit)', marginBottom: 8 }}>{directError}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name"><input value={directForm.name} onChange={(e) => setDF('name', e.target.value)} className={inp} /></Field>
                <Field label="Management host"><input value={directForm.mgmt_host} onChange={(e) => setDF('mgmt_host', e.target.value)} placeholder="https://cluster-mgmt.example.com" className={inp} spellCheck={false} /></Field>
                <Field label="Username" hint={directMode !== 'add' ? 'Leave blank to keep the stored username.' : undefined}>
                  <input value={directForm.username} onChange={(e) => setDF('username', e.target.value)} placeholder={directMode !== 'add' ? '•••••• (stored — leave blank to keep)' : ''} className={inp} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label="Password">
                  <input type="password" value={directForm.password} onChange={(e) => setDF('password', e.target.value)} placeholder={directMode !== 'add' ? '•••••• (stored — leave blank to keep)' : '••••••'} className={inp} autoComplete="new-password" />
                </Field>
                <Field label="Poll interval (min)">
                  <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={5} value={directForm.polling_interval_minutes} onChange={(e) => setDF('polling_interval_minutes', e.target.value)} className={inp} /></div>
                </Field>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-xs text-ink-muted" style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={directForm.ssl_verify} onChange={(e) => setDF('ssl_verify', e.target.checked)} className="accent-brand" />
                    Verify TLS certificate
                  </label>
                </div>
              </div>

              <p style={{ fontSize: 11, color: 'var(--na-ink-faint)', marginTop: 12 }}>
                Connects to the cluster management LIF over the ONTAP REST API. Requires a cluster account with the 'http' application enabled
                and a read-only role — create one with <code>security login create</code> or the ONTAP REST API.
              </p>

              {directTestResult && <p style={{ fontSize: 12, marginTop: 8, color: directTestResult.ok ? 'var(--na-ok)' : 'var(--na-crit)' }}>{directTestResult.ok ? '✓ ' : '✗ '}{directTestResult.msg}</p>}

              <div className="flex items-center gap-2 mt-3">
                <button onClick={directTest} disabled={directTesting || !canTestDirect} style={{ ...btnGhost, opacity: (directTesting || !canTestDirect) ? 0.4 : 1 }}><PlugZap size={13} /> {directTesting ? 'Testing…' : 'Test connection'}</button>
                <button onClick={directSave} disabled={directSaving || !canSaveDirect} style={{ ...btnBrand, opacity: (directSaving || !canSaveDirect) ? 0.4 : 1 }}><Save size={13} /> {directSaving ? 'Saving…' : 'Save'}</button>
                <button onClick={closeDirectForm} style={btnText}>Cancel</button>
              </div>
            </div>
          )}

          {directRows.length === 0 ? (
            <div className="text-sm text-ink-muted p-6 text-center">No direct clusters configured yet. Add one to connect a standalone ONTAP cluster.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                  <th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Management host</th><th className="py-2 pr-3">ONTAP</th><th className="py-2 pr-3">Poll interval</th><th className="py-2 pr-3">TLS</th><th className="py-2 pr-3"></th>
                </tr></thead>
                <tbody>
                  {directRows.map((c) => (
                    <tr key={c.id} className="border-b">
                      <td className="py-2 pr-3 text-ink font-medium">{c.name}</td>
                      <td className="py-2 pr-3 text-ink-muted">{c.mgmt_host}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{shortVersion(c.version)}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{c.polling_interval_minutes}m</td>
                      <td className="py-2 pr-3">{c.ssl_verify ? <Badge tone="ok">Verified</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                      <td className="py-2 pr-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button onClick={() => pollOne(c)} disabled={pollingId === c.id} style={{ ...iconBtn, opacity: pollingId === c.id ? 0.4 : 1 }}><Play size={12} /> {pollingId === c.id ? 'Polling…' : 'Poll'}</button>
                          <button onClick={() => openEditDirect(c)} style={iconBtn}><Pencil size={12} /> Edit</button>
                          <button onClick={() => directDelete(c)} disabled={directDeleting === c.id} style={{ ...iconBtn, opacity: directDeleting === c.id ? 0.4 : 1 }}><Trash2 size={12} /> {directDeleting === c.id ? 'Removing…' : 'Delete'}</button>
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
    </div>
  );
}
