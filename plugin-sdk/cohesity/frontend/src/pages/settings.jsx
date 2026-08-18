// Cohesity plugin — Settings page. Ported from frontend/src/pages/SettingsPage.jsx
// + components/cohesity/{HeliosConnectTab,DirectClustersTab}.jsx, folded into
// one file (dell/unifi convention keeps settings self-contained). Keeps the
// SaaS | Direct convention (409 dup handling surfaces via apiFetch errors,
// test-connection endpoint unchanged). DirectClusterForm is exported for
// reuse by pages/clusters.jsx's inline edit form (same as the host, which
// imports it from DirectClustersTab.jsx).
//
// The built-in SettingsPage also has an "entitlement" (Licensing) tab —
// that body is owned by pages/licensing.jsx's exported EntitlementTab.
import { apiFetch, useToast, Badge } from '../ui.jsx';
import { Save, Lock, Cloud, RefreshCw, Plus, PlugZap, Server, Pencil, Trash2, Settings as SettingsIcon, BadgeCheck } from '../icons.jsx';
import { EntitlementTab } from './licensing.jsx';

const TABS = [
  { key: 'helios', label: 'Helios (SaaS)', icon: Cloud },
  { key: 'direct', label: 'Direct Clusters', icon: Server },
  { key: 'entitlement', label: 'Licensing', icon: BadgeCheck },
  { key: 'polling', label: 'Polling', icon: RefreshCw },
];

function SourceBadge({ source }) {
  if (source === 'settings') return <Badge tone="ok">Stored encrypted</Badge>;
  if (source === 'env') return <Badge tone="warn">From .env (plain text)</Badge>;
  return <Badge tone="crit">Not set</Badge>;
}

/* ── Helios (SaaS) tab ──────────────────────────────────────────────────── */
function HeliosConnectTab() {
  const { toast } = useToast();
  const [credSources, setCredSources] = React.useState({});
  const [credsLoading, setCredsLoading] = React.useState(true);
  const [heliosKeyInput, setHeliosKeyInput] = React.useState('');
  const [savingCreds, setSavingCreds] = React.useState(false);
  const [registeredClusters, setRegisteredClusters] = React.useState([]);
  const [heliosClusters, setHeliosClusters] = React.useState([]);
  const [discoverLoading, setDiscoverLoading] = React.useState(false);
  const [discoverError, setDiscoverError] = React.useState(null);
  const [selected, setSelected] = React.useState([]);
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [adding, setAdding] = React.useState(false);

  const loadCreds = () => { setCredsLoading(true); apiFetch('/settings/credentials').then(setCredSources).catch(() => {}).finally(() => setCredsLoading(false)); };
  const loadClusters = () => { apiFetch('/cohesity/clusters').then((data) => setRegisteredClusters(data.filter((c) => c.connection_type === 'helios'))).catch(() => {}); };

  React.useEffect(() => { loadCreds(); loadClusters(); }, []);

  const saveHeliosKey = async () => {
    const v = heliosKeyInput.trim();
    if (!v) return;
    setSavingCreds(true);
    try { setCredSources(await apiFetch('/settings/credentials', { method: 'PUT', body: { heliosApiKey: v } })); setHeliosKeyInput(''); toast({ type: 'success', title: 'Helios API key saved', message: 'Stored encrypted. Applied immediately.' }); }
    catch { toast({ type: 'error', title: 'Save failed' }); }
    finally { setSavingCreds(false); }
  };

  const clearHeliosKey = async () => {
    setSavingCreds(true);
    try { setCredSources(await apiFetch('/settings/credentials', { method: 'PUT', body: { heliosApiKey: '' } })); toast({ type: 'success', title: 'Stored key cleared' }); }
    catch { toast({ type: 'error', title: 'Clear failed' }); }
    finally { setSavingCreds(false); }
  };

  const handleDiscover = async () => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    try { setHeliosClusters(await apiFetch('/cohesity/helios/clusters')); setSelected([]); }
    catch (err) { setDiscoverError(err.payload?.error || 'Could not fetch Helios clusters.'); }
    finally { setDiscoverLoading(false); }
  };

  const registeredClusterIds = new Set(registeredClusters.map((c) => String(c.vip)));
  const toggleSelected = (clusterId) => setSelected((prev) => prev.includes(clusterId) ? prev.filter((id) => id !== clusterId) : [...prev, clusterId]);

  const handleAddSelected = async () => {
    setAdding(true);
    const credentials = apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {};
    let added = 0;
    const skipped = [];
    for (const clusterId of selected) {
      const info = heliosClusters.find((c) => String(c.clusterId) === clusterId);
      const name = info?.name || clusterId;
      try {
        await apiFetch('/cohesity/clusters', { method: 'POST', body: { name, connection_type: 'helios', vip: String(clusterId), auth_type: 'apikey', credentials, polling_interval_minutes: 60 } });
        added++;
      } catch (err) {
        skipped.push(`${name} — ${err.payload?.error || err.payload?.errors?.[0]?.msg || 'failed'}`);
      }
    }
    toast({ type: skipped.length ? 'error' : 'success', title: skipped.length ? 'Some clusters were skipped' : 'Clusters added', message: skipped.length ? `Added ${added}, skipped ${skipped.length}: ${skipped.join('; ')}` : `Added ${added} cluster(s)` });
    setSelected([]); setAdding(false); loadClusters();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}><Lock size={14} style={{ color: 'var(--co-brand)' }} /></div>
          <div>
            <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Helios API key</p>
            <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: '2px 0 0' }}>Used for Helios cluster discovery, licensing reports, and any Helios-connected cluster without its own key. Stored AES-256-GCM encrypted, applied immediately. A stored key overrides <code>.env</code>.</p>
          </div>
        </div>
        {credsLoading ? <p style={{ color: 'var(--co-ink-muted)', fontSize: 13, marginTop: 16 }}>Loading…</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)' }}>Status</span>
              <SourceBadge source={credSources.heliosApiKey || 'none'} />
              {credSources.heliosApiKey === 'settings' && <button onClick={clearHeliosKey} disabled={savingCreds} style={{ fontSize: 10, color: 'var(--co-ink-faint)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Clear stored value</button>}
            </div>
            <input type="password" autoComplete="off" value={heliosKeyInput} onChange={(e) => setHeliosKeyInput(e.target.value)} placeholder={credSources.heliosApiKey === 'settings' ? '•••••••• (stored — enter a new value to replace)' : 'Paste Helios API key to store encrypted'} className="co-input" style={{ fontFamily: 'monospace' }} />
            <div><button onClick={saveHeliosKey} disabled={savingCreds || !heliosKeyInput.trim()} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}><Save size={13} /> {savingCreds ? 'Saving…' : 'Save key'}</button></div>
          </div>
        )}
      </div>

      <div className="panel" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}><Cloud size={14} style={{ color: 'var(--co-brand)' }} /></div>
            <div><p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Helios-connected clusters</p><p style={{ fontSize: 11, color: 'var(--co-ink-muted)', margin: 0 }}>{registeredClusters.length} cluster(s) registered via Helios</p></div>
          </div>
          <button onClick={handleDiscover} disabled={discoverLoading} className="co-btn-ghost"><RefreshCw size={13} className={discoverLoading ? 'animate-spin' : ''} /> {discoverLoading ? 'Discovering…' : 'Discover clusters'}</button>
        </div>
        {discoverError && <p style={{ fontSize: 12, color: 'var(--co-crit)', marginBottom: 8 }}>{discoverError}</p>}
        {heliosClusters.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ border: '1px solid var(--co-border)', borderRadius: 8, maxHeight: 256, overflowY: 'auto' }}>
              {heliosClusters.map((c) => {
                const clusterId = String(c.clusterId);
                const alreadyRegistered = registeredClusterIds.has(clusterId);
                return (
                  <label key={clusterId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', fontSize: 13, borderTop: '1px solid var(--co-border)', opacity: alreadyRegistered ? 0.5 : 1, cursor: alreadyRegistered ? 'not-allowed' : 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(clusterId)} disabled={alreadyRegistered} onChange={() => toggleSelected(clusterId)} className="accent-brand" />
                    <span style={{ fontWeight: 500, color: 'var(--co-ink)' }}>{c.name}</span>
                    <span style={{ color: 'var(--co-ink-faint)', fontSize: 11 }}>ID: {clusterId}</span>
                    <span style={{ color: 'var(--co-ink-faint)', fontSize: 11 }}>{c.softwareVersion || '—'}</span>
                    {alreadyRegistered && <Badge tone="neutral" style={{ marginLeft: 'auto' }}>Already registered</Badge>}
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>API key (optional)</label>
                <input type="password" value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} placeholder="Leave blank to use the Helios key above" autoComplete="new-password" className="co-input" />
              </div>
              <button onClick={handleAddSelected} disabled={adding || selected.length === 0} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}><Plus size={13} /> {adding ? 'Adding…' : `Add selected (${selected.length})`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Direct cluster add/edit form (exported for pages/clusters.jsx) ──────── */
export function DirectClusterForm({ initial, onSaved, onCancel }) {
  const isEdit = !!initial;
  const [name, setName] = React.useState(initial?.name || '');
  const [vip, setVip] = React.useState(initial?.vip || '');
  const [authType, setAuthType] = React.useState(initial?.auth_type || 'apikey');
  const [apiKey, setApiKey] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [domain, setDomain] = React.useState('local');
  const [pollingInterval, setPollingInterval] = React.useState(initial?.polling_interval_minutes || 15);
  const [sslVerify, setSslVerify] = React.useState(!!initial?.ssl_verify);
  const [tags, setTags] = React.useState(initial?.tags ? initial.tags.split(',').map((t) => t.trim()).filter(Boolean) : []);
  const [tagInput, setTagInput] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);

  const addTag = () => { const t = tagInput.trim(); if (t && !tags.includes(t)) setTags((prev) => [...prev, t]); setTagInput(''); };
  const buildCredentials = () => authType === 'apikey' ? (apiKey ? { apiKey } : undefined) : ((username || password) ? { username, password, domain } : undefined);
  const canSave = name.trim() && vip.trim() && (isEdit || (authType === 'apikey' ? !!apiKey.trim() : !!(username.trim() && password)));
  const canTest = vip.trim() && (authType === 'apikey' ? !!apiKey.trim() : !!(username.trim() && password));

  const handleSave = async () => {
    setError(null);
    setSubmitting(true);
    const credentials = buildCredentials();
    const payload = { name: name.trim(), vip: vip.trim(), auth_type: authType, polling_interval_minutes: Number(pollingInterval) || 15, ssl_verify: sslVerify, tags: tags.join(', ') };
    try {
      if (isEdit) {
        if (credentials !== undefined) payload.credentials = credentials;
        await apiFetch(`/cohesity/clusters/${initial.id}`, { method: 'PUT', body: payload });
      } else {
        payload.connection_type = 'direct';
        payload.credentials = credentials || {};
        await apiFetch('/cohesity/clusters', { method: 'POST', body: payload });
      }
      onSaved();
    } catch (err) { setError(err.payload?.error || err.payload?.errors?.[0]?.msg || 'Save failed.'); }
    finally { setSubmitting(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiFetch('/cohesity/clusters/test', { method: 'POST', body: { connection_type: 'direct', vip: vip.trim(), auth_type: authType, credentials: buildCredentials() || {}, ssl_verify: sslVerify } });
      setTestResult(data);
    } catch (err) { setTestResult({ ok: false, error: err.payload?.error || err.payload?.errors?.[0]?.msg || 'Connection failed' }); }
    finally { setTesting(false); }
  };

  return (
    <div style={{ border: '1px solid var(--co-border)', borderRadius: 8, padding: 12 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 12px' }}>{isEdit ? `Edit — ${initial.name}` : 'Add direct cluster'}</p>
      {error && <p style={{ fontSize: 12, color: 'var(--co-crit)', marginBottom: 8 }}>{error}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2" style={{ gap: 12 }}>
        <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Cluster name</label><input value={name} onChange={(e) => setName(e.target.value)} className="co-input" /></div>
        <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>VIP / Hostname</label><input value={vip} onChange={(e) => setVip(e.target.value)} placeholder="e.g. 192.168.1.100 or mycluster.company.com" className="co-input" spellCheck={false} /></div>
        <div className="sm:col-span-2">
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Auth type</label>
          <div style={{ display: 'flex', gap: 16 }}>
            {[['apikey', 'API Key'], ['userpass', 'Username / Password']].map(([val, label]) => (
              <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--co-ink)', cursor: 'pointer' }}>
                <input type="radio" name={`direct-auth-${initial?.id || 'new'}`} value={val} checked={authType === val} onChange={() => setAuthType(val)} className="accent-brand" /> {label}
              </label>
            ))}
          </div>
        </div>
        {authType === 'apikey' ? (
          <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>API key</label><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''} autoComplete="new-password" className="co-input" /></div>
        ) : (
          <>
            <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''} autoComplete="username" className="co-input" /></div>
            <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isEdit ? '•••••• (stored — leave blank to keep)' : ''} autoComplete="new-password" className="co-input" /></div>
            <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Domain</label><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="local" className="co-input" /></div>
          </>
        )}
        <div><label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Polling interval (min)</label><input type="number" min={5} value={pollingInterval} onChange={(e) => setPollingInterval(e.target.value)} className="co-input" /></div>
        <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--co-ink-muted)', cursor: 'pointer' }}><input type="checkbox" checked={sslVerify} onChange={(e) => setSslVerify(e.target.checked)} className="accent-brand" /> Verify SSL certificate</label>
        </div>
        <div className="sm:col-span-2">
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Tags</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, minHeight: 24 }}>
            {tags.map((tag) => (
              <span key={tag} className="chip" style={{ background: 'var(--co-surface-overlay)', border: '1px solid var(--co-border)', color: 'var(--co-brand)' }}>{tag} <button type="button" onClick={() => setTags((prev) => prev.filter((t) => t !== tag))} style={{ background: 'none', border: 'none', color: 'var(--co-ink-faint)', cursor: 'pointer' }}>×</button></span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }} placeholder="Type a tag and press Enter" className="co-input" />
            <button type="button" onClick={addTag} className="co-btn-ghost">Add</button>
          </div>
        </div>
      </div>
      {testResult && <p style={{ fontSize: 12, marginTop: 8, color: testResult.ok ? 'var(--co-ok)' : 'var(--co-crit)' }}>{testResult.ok ? `✓ Connected — ${testResult.clusterName || 'cluster'} (${testResult.softwareVersion || 'unknown version'})` : `✗ ${testResult.error}`}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <button onClick={handleTest} disabled={testing || !canTest} className="co-btn-ghost"><PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}</button>
        <button onClick={handleSave} disabled={submitting || !canSave} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}><Save size={13} /> {submitting ? 'Saving…' : 'Save'}</button>
        <button onClick={onCancel} style={{ fontSize: 12, fontWeight: 500, padding: '8px 14px', color: 'var(--co-ink-faint)', background: 'none', border: 'none', cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  );
}

function DirectClustersTab() {
  const { toast } = useToast();
  const [clusters, setClusters] = React.useState(null);
  const [mode, setMode] = React.useState(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(null);

  const load = () => apiFetch('/cohesity/clusters').then((data) => setClusters(data.filter((c) => c.connection_type === 'direct'))).catch(() => setClusters([]));
  React.useEffect(() => { load(); }, []);

  const handleDelete = async (row) => {
    if (!window.confirm('Removing a cluster deletes its collected history.')) return;
    setDeleteConfirm(row.id);
    try { await apiFetch(`/cohesity/clusters/${row.id}`, { method: 'DELETE' }); toast({ type: 'success', title: 'Cluster removed', message: row.name }); load(); }
    catch (err) { toast({ type: 'error', title: 'Delete failed', message: err.payload?.error || 'Delete failed.' }); }
    finally { setDeleteConfirm(null); }
  };

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', height: 28, width: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}><Server size={14} style={{ color: 'var(--co-brand)' }} /></div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Direct clusters</p>
        </div>
        {!mode && <button onClick={() => setMode('add')} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)' }}><Plus size={13} /> Add cluster</button>}
      </div>
      {mode && <div style={{ marginBottom: 16 }}><DirectClusterForm initial={mode?.edit} onSaved={() => { setMode(null); load(); toast({ type: 'success', title: mode?.edit ? 'Cluster updated' : 'Cluster added' }); }} onCancel={() => setMode(null)} /></div>}
      {clusters == null ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', textAlign: 'center', padding: '24px 0' }}>Loading…</p>
        : clusters.length === 0 ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', textAlign: 'center', padding: '24px 0' }}>No direct clusters configured yet. Add one to connect a standalone Cohesity cluster.</p>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--co-ink-faint)', borderBottom: '1px solid var(--co-border)' }}>
                <th style={{ padding: '6px 12px 6px 0' }}>Cluster</th><th style={{ padding: '6px 12px 6px 0' }}>VIP / Hostname</th><th style={{ padding: '6px 12px 6px 0' }}>Auth type</th><th style={{ padding: '6px 12px 6px 0' }}>Poll interval</th><th style={{ padding: '6px 12px 6px 0' }}>TLS</th><th></th>
              </tr></thead>
              <tbody>
                {clusters.map((c) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid rgba(31,43,55,.5)' }}>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--co-ink)', fontWeight: 500 }}>{c.name}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: 'var(--co-ink-muted)' }}>{c.vip}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}><Badge tone="info">{c.auth_type === 'apikey' ? 'API Key' : 'User/Pass'}</Badge></td>
                    <td className="tnum" style={{ padding: '8px 12px 8px 0', color: 'var(--co-ink-muted)' }}>{c.polling_interval_minutes}m</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>{c.ssl_verify ? <Badge tone="ok">Verified</Badge> : <Badge tone="neutral">Off</Badge>}</td>
                    <td style={{ padding: '8px 0', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <button onClick={() => setMode({ edit: c })} className="co-btn-ghost" style={{ padding: '4px 8px' }}><Pencil size={12} /> Edit</button>
                        <button onClick={() => handleDelete(c)} disabled={deleteConfirm === c.id} className="co-btn-ghost" style={{ padding: '4px 8px', color: 'var(--co-crit)' }}><Trash2 size={12} /> {deleteConfirm === c.id ? 'Removing…' : 'Delete'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

/* ── Manual polling tab — poller triggers route through the canonical
 * plugin-prefixed path per the WP-C API contract note. ─────────────────── */
function PollingTab() {
  const { toast } = useToast();
  const [clusters, setClusters] = React.useState(null);
  const [busy, setBusy] = React.useState({});

  React.useEffect(() => { apiFetch('/cohesity/clusters').then((data) => setClusters(Array.isArray(data) ? data : data.clusters || [])).catch(() => setClusters([])); }, []);

  const mark = (k, v) => setBusy((b) => ({ ...b, [k]: v }));
  const cooldown = (k) => { mark(k, true); setTimeout(() => mark(k, false), 30000); };

  const pollAll = async () => {
    try { const data = await apiFetch('/cohesity/poller/trigger', { method: 'POST' }); toast({ type: 'success', title: `Poll started on ${data.started} cluster(s)`, message: 'Clusters are polled one at a time — data lands on the pages as each finishes.' }); cooldown('all'); }
    catch { toast({ type: 'error', title: 'Failed to start poll' }); }
  };

  const pollOne = async (c) => {
    try { await apiFetch(`/cohesity/poller/trigger/${c.id}`, { method: 'POST' }); toast({ type: 'success', title: `Poll started: ${c.name}` }); cooldown(c.id); }
    catch { toast({ type: 'error', title: `Failed to start poll on ${c.name}` }); }
  };

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Manual Poll</p>
          <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', marginTop: 4, lineHeight: 1.6, maxWidth: 420 }}>Runs the same full collection as the scheduled poller (metrics, alerts, runs, policies, workloads, object inventory) outside its normal cadence.</p>
        </div>
        <button onClick={pollAll} disabled={busy.all || !clusters?.length} className="co-btn-ghost" style={{ background: 'rgba(108,179,63,0.1)', borderColor: 'rgba(108,179,63,0.3)', color: 'var(--co-brand)', flexShrink: 0 }}>
          <RefreshCw size={13} className={busy.all ? 'animate-spin' : ''} /> Poll all clusters
        </button>
      </div>
      {clusters == null ? <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', padding: '16px 0' }}>Loading clusters…</p>
        : clusters.length === 0 ? <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', padding: '16px 0' }}>No clusters registered.</p>
        : (
          <div>
            {clusters.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid rgba(31,43,55,.5)' }}>
                <div style={{ minWidth: 0 }}>
                  <p className="truncate" style={{ fontSize: 13, color: 'var(--co-ink)', margin: 0 }}>{c.name}</p>
                  <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', margin: 0 }}>{c.connection_type === 'helios' ? 'Helios' : c.vip || 'direct'}</p>
                </div>
                <button onClick={() => pollOne(c)} disabled={!!busy[c.id]} className="co-btn-ghost" style={{ padding: '5px 10px' }}><RefreshCw size={12} className={busy[c.id] ? 'animate-spin' : ''} /> Poll now</button>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = React.useState('helios');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 768 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', height: 32, width: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(108,179,63,0.1)', border: '1px solid rgba(108,179,63,0.2)' }}><SettingsIcon size={16} style={{ color: 'var(--co-brand)' }} /></div>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--co-ink)', margin: 0 }}>Cohesity Settings</h1>
          <p style={{ fontSize: 12, color: 'var(--co-ink-muted)', margin: '2px 0 0' }}>Cohesity-specific configuration. Global settings (AI keys, platforms, product license) are under the gear icon in the top bar.</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--co-surface)', border: '1px solid var(--co-border)', padding: 4, alignSelf: 'flex-start' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer', background: active ? 'var(--co-surface-overlay)' : 'transparent', color: active ? 'var(--co-ink)' : 'var(--co-ink-muted)' }}>
              <Icon size={13} style={active ? { color: 'var(--co-brand)' } : undefined} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'helios' && <HeliosConnectTab />}
      {tab === 'direct' && <DirectClustersTab />}
      {tab === 'entitlement' && <EntitlementTab />}
      {tab === 'polling' && <PollingTab />}
    </div>
  );
}
