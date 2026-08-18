// Ported from frontend/src/pages/pure/PureSettingsPage.jsx +
// PureDirectArraysTab.jsx, merged into one file (plugin sandbox keeps a flat
// pages/ tree). Preserves the exact SaaS|Direct dual-tab connection
// convention. Pure1 SaaS calls go through the /pure/pure1/* fold (see
// contract note in index.jsx); direct-array CRUD stays at /pure/arrays/*.
import {
  Settings, Save, PlugZap, KeyRound, Copy, Check, Cloud, Clock, Gauge, Server,
  Plus, Pencil, Trash2, X,
} from '../icons.jsx';
import { apiFetch, PageHeader, LoadingPanel, Badge, RefreshButton, BRAND, timeAgo } from '../ui.jsx';

const inp = 'pu-input';

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-faint mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-ink-faint mt-1">{hint}</p>}
    </div>
  );
}

const TABS = [
  { key: 'saas', label: 'Pure1 (SaaS)', icon: Cloud },
  { key: 'direct', label: 'Direct Arrays', icon: Server },
];

export default function PureSettingsPage() {
  const [tab, setTab] = React.useState('saas');
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start w-fit mb-4">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="pu-btn-ghost"
              style={{ border: 'none', color: active ? 'var(--pu-ink)' : 'var(--pu-ink-muted)', background: active ? 'var(--pu-surface-overlay)' : 'transparent' }}>
              <Icon size={13} style={active ? { color: BRAND } : undefined} /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'saas' ? <Pure1SaaSTab /> : <PureDirectArraysTab />}
    </div>
  );
}

/* ── Pure1 SaaS tab ───────────────────────────────────────────────────── */
function Pure1SaaSTab() {
  const [cfg, setCfg] = React.useState(null);
  const [appId, setAppId] = React.useState('');
  const [privateKey, setPrivateKey] = React.useState('');
  const [ttl, setTtl] = React.useState(10);
  const [pollInterval, setPollInterval] = React.useState(15);
  const [warnPct, setWarnPct] = React.useState(75);
  const [critPct, setCritPct] = React.useState(90);
  const [showHidden, setShowHidden] = React.useState(false);
  const [savingCreds, setSavingCreds] = React.useState(false);
  const [savingPrefs, setSavingPrefs] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const flash = (type, title, message) => {
    setStatusMsg({ type, title, message });
    setTimeout(() => setStatusMsg((s) => (s?.title === title ? null : s)), 5000);
  };

  const load = React.useCallback(() => apiFetch('/pure/pure1/settings')
    .then((data) => {
      setCfg(data);
      setAppId('');
      setTtl(data.cacheTtlMin || 10);
      setPollInterval(data.pollIntervalMinutes || 15);
      setWarnPct(data.warnPct || 75);
      setCritPct(data.critPct || 90);
      setShowHidden(!!data.showHiddenAlerts);
    })
    .catch(() => setCfg({ configured: false })), []);

  React.useEffect(() => { load(); }, [load]);

  const saveCreds = async () => {
    setSavingCreds(true);
    try {
      const patch = {};
      if (appId.trim()) patch.appId = appId.trim();
      if (privateKey.trim()) patch.privateKey = privateKey.trim();
      if (Object.keys(patch).length === 0) { flash('info', 'Nothing to save'); return; }
      const data = await apiFetch('/pure/pure1/settings', { method: 'PUT', body: patch });
      setCfg(data); setPrivateKey('');
      flash('success', 'Credentials saved');
    } catch (err) {
      flash('error', 'Save failed', err?.payload?.error || 'Could not save.');
    } finally { setSavingCreds(false); }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      const data = await apiFetch('/pure/pure1/settings', {
        method: 'PUT',
        body: {
          cacheTtlMin: Number(ttl), pollIntervalMinutes: Number(pollInterval),
          warnPct: Number(warnPct), critPct: Number(critPct), showHiddenAlerts: showHidden,
        },
      });
      setCfg(data);
      flash('success', 'Preferences saved');
    } catch (err) {
      flash('error', 'Save failed', err?.payload?.error || 'Could not save.');
    } finally { setSavingPrefs(false); }
  };

  const testConn = async () => {
    setTesting(true); setTestResult(null);
    try {
      const data = await apiFetch('/pure/pure1/test', { method: 'POST', body: {} });
      setTestResult(data.ok ? { ok: true, msg: `Connected · ${data.arrayCount} arrays visible` } : { ok: false, msg: data.error });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.payload?.error || 'Connection failed' });
    } finally { setTesting(false); }
  };

  const copyPublicKey = () => {
    if (!cfg?.publicKey) return;
    navigator.clipboard.writeText(cfg.publicKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  if (cfg == null) {
    return (
      <div className="animate-fade-in max-w-3xl">
        <PageHeader icon={Settings} title="Pure Settings" description="Pure1 credentials and preferences" />
        <LoadingPanel label="Loading settings…" height={160} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader icon={Settings} title="Pure Settings" description="Pure1 cloud credentials and display preferences">
        <RefreshButton onClick={load} />
      </PageHeader>

      {statusMsg && (
        <div className={`panel p-3 mb-4 text-xs ${statusMsg.type === 'error' ? 'text-status-crit' : 'text-status-ok'}`} style={{ borderLeft: `3px solid ${statusMsg.type === 'error' ? '#F87171' : '#34D399'}` }}>
          <b>{statusMsg.title}</b>{statusMsg.message ? ` — ${statusMsg.message}` : ''}
        </div>
      )}

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Cloud size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Connection</p></div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-2">Status: {cfg.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="crit">Not configured</Badge>}</span>
          <span className="text-ink-muted">Key source: <span className="text-ink">{cfg.keySource}</span></span>
          <span className="text-ink-muted">App ID source: <span className="text-ink">{cfg.appIdSource}</span></span>
          <span className="text-ink-muted">Last data refresh: <span className="text-ink">{cfg.lastRefresh?.overview ? timeAgo(cfg.lastRefresh.overview) : '—'}</span></span>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={testConn} disabled={testing || !cfg.configured} className="pu-btn-ghost">
            <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && <span className={`text-[12px] ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.ok ? '✓ ' : '✗ '}{testResult.msg}</span>}
        </div>
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><KeyRound size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Pure1 Credentials</p></div>
        <div className="grid grid-cols-1 gap-3">
          <Field label="Application ID (API key)" hint={`From Pure1 Manage → Administration → API Registrations. ${cfg.appIdSet ? `On file: ${cfg.appIdMasked} — enter a new value to replace it.` : ''}`}>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={cfg.appIdSet ? `${cfg.appIdMasked} (stored — enter new to replace)` : 'pure1:apikey:…'} className={inp} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Private key (PEM)" hint={`Stored encrypted. Current source: ${cfg.keySource}. Paste a new key only to replace it.`}>
            <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4}
              placeholder={cfg.hasPrivateKey ? '•••••• key on file — paste to replace' : '-----BEGIN PRIVATE KEY-----'}
              className={`${inp} font-mono text-[11px]`} spellCheck={false} />
          </Field>
          {cfg.publicKey && (
            <Field label="Public key to register in Pure1" hint="Upload this to the Pure1 API registration that issued your Application ID (role: Pure1 Viewer).">
              <div className="relative">
                <textarea value={cfg.publicKey} readOnly rows={4} className={`${inp} font-mono text-[11px]`} style={{ paddingRight: 40 }} />
                <button onClick={copyPublicKey} title="Copy" className="absolute top-2 right-2 text-ink-faint hover:text-ink" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                  {copied ? <Check size={14} className="text-status-ok" /> : <Copy size={14} />}
                </button>
              </div>
            </Field>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={saveCreds} disabled={savingCreds} className="pu-btn-ghost" style={{ background: 'rgba(255,107,0,0.1)', borderColor: 'rgba(255,107,0,0.3)', color: BRAND }}>
            <Save size={13} /> {savingCreds ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Gauge size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Data &amp; Display</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <Field label="Refresh interval (min)" hint="How long fleet data is cached before re-fetching.">
            <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={1} max={120} value={ttl} onChange={(e) => setTtl(e.target.value)} className={inp} /></div>
          </Field>
          <Field label="Poll interval (minutes)" hint="How often the background poller refreshes Pure1 fleet data.">
            <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={5} max={1440} value={pollInterval} onChange={(e) => setPollInterval(e.target.value)} className={inp} /></div>
          </Field>
          <Field label="Capacity warning %" hint="Amber bar at/above this % full.">
            <input type="number" min={1} max={100} value={warnPct} onChange={(e) => setWarnPct(e.target.value)} className={inp} />
          </Field>
          <Field label="Capacity critical %" hint="Red bar at/above this % full.">
            <input type="number" min={1} max={100} value={critPct} onChange={(e) => setCritPct(e.target.value)} className={inp} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer mt-3 select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-brand cursor-pointer" />
          Show hidden-severity alerts (Pure1 flags low-signal events as "hidden")
        </label>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={savePrefs} disabled={savingPrefs} className="pu-btn-ghost" style={{ background: 'rgba(255,107,0,0.1)', borderColor: 'rgba(255,107,0,0.3)', color: BRAND }}>
            <Save size={13} /> {savingPrefs ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Direct Arrays tab ────────────────────────────────────────────────── */
const EMPTY_FORM = {
  name: '', mgmt_host: '', auth_method: 'client',
  client_id: '', key_id: '', username: '', issuer: '',
  privateKey: '', apiToken: '',
  polling_interval_minutes: 15, ssl_verify: true,
};

function formFromRow(row) {
  if (!row) return { ...EMPTY_FORM };
  return {
    name: row.name || '',
    mgmt_host: row.mgmt_host || '',
    auth_method: row.auth_method === 'token' ? 'token' : 'client',
    client_id: '', key_id: '', username: '',
    issuer: row.issuer || '',
    privateKey: '', apiToken: '',
    polling_interval_minutes: row.polling_interval_minutes || 15,
    ssl_verify: !!row.ssl_verify,
  };
}

function CredentialGuidance({ authMethod }) {
  return (
    <div className="text-[11px] text-ink-faint space-y-1 mb-2">
      <p>Two ways to authenticate to a FlashArray:</p>
      {authMethod === 'token' ? (
        <p>
          API token: each array user has one — Purity UI → Settings → Users (or <code>pureadmin list --api-token --expose</code> in
          the CLI). A read-only user is sufficient for monitoring.
        </p>
      ) : (
        <p>
          API client (OAuth2): create with <code>pureadmin apiclient create</code> on the array (Purity//FA 6.x). You'll need
          the client_id, key_id, issuer, a username the client acts as, and the RSA private key (PEM) whose public half you
          registered. Generate the key pair with openssl (e.g. <code>openssl genrsa -out private.pem 2048</code>).
        </p>
      )}
    </div>
  );
}

function buildPayload(form) {
  const payload = {
    name: form.name.trim(),
    mgmt_host: form.mgmt_host.trim(),
    auth_method: form.auth_method,
    polling_interval_minutes: Number(form.polling_interval_minutes) || 15,
    ssl_verify: !!form.ssl_verify,
  };
  if (form.auth_method === 'token') {
    if (form.apiToken.trim()) payload.apiToken = form.apiToken.trim();
  } else {
    payload.client_id = form.client_id.trim();
    payload.key_id = form.key_id.trim();
    payload.username = form.username.trim();
    if (form.issuer.trim()) payload.issuer = form.issuer.trim();
    if (form.privateKey.trim()) payload.privateKey = form.privateKey;
  }
  return payload;
}

function ArrayForm({ mode, initial, onCancel, onSaved }) {
  const [form, setForm] = React.useState(() => formFromRow(initial));
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState(null);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState(null);

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }));

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const payload = buildPayload(form);
      delete payload.name;
      const data = await apiFetch('/pure/arrays/test', { method: 'POST', body: payload });
      setTestResult(data.ok ? { ok: true, msg: 'Connection succeeded' } : { ok: false, msg: data.error || 'Connection failed' });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.payload?.error || 'Connection failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const payload = buildPayload(form);
      const data = mode === 'edit'
        ? await apiFetch(`/pure/arrays/${initial.id}`, { method: 'PUT', body: payload })
        : await apiFetch('/pure/arrays', { method: 'POST', body: payload });
      onSaved(data, mode);
    } catch (err) {
      setSubmitError(err?.payload?.error || err?.payload?.errors?.[0]?.msg || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {submitError && (
        <div className="bg-status-crit/10 border border-status-crit/25 text-status-crit text-xs rounded-lg px-3 py-2">{submitError}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input required value={form.name} onChange={(e) => set('name', e.target.value)} className={inp} />
        </Field>
        <Field label="Management host">
          <input required value={form.mgmt_host} onChange={(e) => set('mgmt_host', e.target.value)}
            placeholder="e.g. flasharray1.company.com" className={inp} />
        </Field>
      </div>

      <CredentialGuidance authMethod={form.auth_method} />

      <Field label="Authentication method">
        <select value={form.auth_method} onChange={(e) => set('auth_method', e.target.value)} className={inp}>
          <option value="client">API client (OAuth2)</option>
          <option value="token">API token</option>
        </select>
      </Field>

      {form.auth_method === 'client' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Client ID">
              <input required value={form.client_id} onChange={(e) => set('client_id', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Key ID">
              <input required value={form.key_id} onChange={(e) => set('key_id', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Username">
              <input required value={form.username} onChange={(e) => set('username', e.target.value)} className={inp} autoComplete="off" />
            </Field>
            <Field label="Issuer" hint="Optional">
              <input value={form.issuer} onChange={(e) => set('issuer', e.target.value)} className={inp} autoComplete="off" />
            </Field>
          </div>
          <Field label="Private key (PEM)" hint={mode === 'edit' ? 'Stored — leave blank to keep the existing key.' : undefined}>
            <textarea value={form.privateKey} onChange={(e) => set('privateKey', e.target.value)} rows={5}
              placeholder={mode === 'edit' ? '•••••• (stored — leave blank to keep)' : '-----BEGIN PRIVATE KEY-----'}
              className={`${inp} font-mono text-[11px]`} spellCheck={false} />
          </Field>
        </>
      ) : (
        <Field label="API token" hint={mode === 'edit' ? 'Stored — leave blank to keep the existing token.' : undefined}>
          <input type="password" value={form.apiToken} onChange={(e) => set('apiToken', e.target.value)}
            placeholder={mode === 'edit' ? '•••••• (stored — leave blank to keep)' : ''}
            className={inp} autoComplete="off" spellCheck={false} />
        </Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Polling interval (minutes)">
          <input type="number" min={5} max={1440} value={form.polling_interval_minutes}
            onChange={(e) => set('polling_interval_minutes', e.target.value)} className={inp} />
        </Field>
        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
            <input type="checkbox" checked={form.ssl_verify} onChange={(e) => set('ssl_verify', e.target.checked)} className="accent-brand cursor-pointer" />
            Verify SSL certificate
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <button type="submit" disabled={submitting} className="pu-btn-ghost" style={{ background: 'rgba(255,107,0,0.1)', borderColor: 'rgba(255,107,0,0.3)', color: BRAND }}>
          <Save size={13} /> {submitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add array'}
        </button>
        <button type="button" onClick={handleTest} disabled={testing} className="pu-btn-ghost">
          <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={onCancel} className="pu-btn-ghost" style={{ border: 'none' }}>
          <X size={13} /> Cancel
        </button>
        {testResult && (
          <span className={`text-[12px] ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
          </span>
        )}
      </div>
    </form>
  );
}

function PureDirectArraysTab() {
  const [arrays, setArrays] = React.useState(null);
  const [mode, setMode] = React.useState(null); // null | 'add' | { edit: row }
  const [pollingId, setPollingId] = React.useState(null);
  const [deletingId, setDeletingId] = React.useState(null);
  const [statusMsg, setStatusMsg] = React.useState(null);

  const flash = (type, title, message) => {
    setStatusMsg({ type, title, message });
    setTimeout(() => setStatusMsg((s) => (s?.title === title ? null : s)), 5000);
  };

  const load = React.useCallback(() => apiFetch('/pure/arrays')
    .then((data) => setArrays(data))
    .catch(() => setArrays([])), []);

  React.useEffect(() => { load(); }, [load]);

  const handleSaved = (row, savedMode) => {
    setMode(null);
    load();
    flash('success', savedMode === 'edit' ? 'Array updated' : 'Array registered — first poll triggered');
  };

  const handleDelete = async (row) => {
    if (!window.confirm(`Delete array "${row.name}"? This removes its stored credentials and history.`)) return;
    setDeletingId(row.id);
    try {
      await apiFetch(`/pure/arrays/${row.id}`, { method: 'DELETE' });
      flash('success', 'Array deleted');
      setArrays((prev) => prev.filter((a) => a.id !== row.id));
    } catch (err) {
      flash('error', 'Delete failed', err?.payload?.error || 'Could not delete array.');
    } finally {
      setDeletingId(null);
    }
  };

  const handlePoll = async (row) => {
    setPollingId(row.id);
    try {
      await apiFetch(`/pure/arrays/${row.id}/poll`, { method: 'POST', body: {} });
      flash('success', `Poll triggered for ${row.name}`);
    } catch (err) {
      flash('error', 'Poll failed', err?.payload?.error || 'Could not trigger poll.');
    } finally {
      setPollingId(null);
    }
  };

  if (arrays == null) {
    return <LoadingPanel label="Loading arrays…" height={160} />;
  }

  return (
    <div>
      {statusMsg && (
        <div className={`panel p-3 mb-4 text-xs ${statusMsg.type === 'error' ? 'text-status-crit' : 'text-status-ok'}`} style={{ borderLeft: `3px solid ${statusMsg.type === 'error' ? '#F87171' : '#34D399'}` }}>
          <b>{statusMsg.title}</b>{statusMsg.message ? ` — ${statusMsg.message}` : ''}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-xs text-ink-muted max-w-lg">
          Directly-managed FlashArrays, polled on their own schedule independent of Pure1.
        </p>
        {!mode && (
          <button onClick={() => setMode('add')} className="pu-btn-ghost" style={{ background: BRAND, borderColor: BRAND, color: '#1A1A1A', fontWeight: 700 }}>
            <Plus size={14} /> Add array
          </button>
        )}
      </div>

      {mode === 'add' && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Add array</p>
          <ArrayForm mode="add" onCancel={() => setMode(null)} onSaved={handleSaved} />
        </div>
      )}

      {mode?.edit && (
        <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3">Edit — {mode.edit.name}</p>
          <ArrayForm mode="edit" initial={mode.edit} onCancel={() => setMode(null)} onSaved={handleSaved} />
        </div>
      )}

      {arrays.length === 0 ? (
        <div className="panel p-6 text-center text-sm text-ink-muted">No direct arrays registered yet.</div>
      ) : (
        <div className="panel p-0 overflow-hidden divide-y divide-cohesity-border">
          {arrays.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{row.name}</p>
                <p className="text-[11px] text-ink-faint truncate">{row.mgmt_host}</p>
              </div>
              <Badge tone={row.auth_method === 'token' ? 'info' : 'brand'}>
                {row.auth_method === 'token' ? 'API token' : 'API client'}
              </Badge>
              {row.auth_method === 'token' ? (
                <Badge tone="neutral">Token stored</Badge>
              ) : (
                <div className="flex items-center gap-1">
                  <Badge tone={row.has_client_id ? 'ok' : 'crit'}>Client ID</Badge>
                  <Badge tone={row.has_key_id ? 'ok' : 'crit'}>Key ID</Badge>
                  <Badge tone={row.has_username ? 'ok' : 'crit'}>User</Badge>
                </div>
              )}
              <span className="text-[11px] text-ink-faint w-14 flex-shrink-0 hidden sm:block">{row.polling_interval_minutes}m</span>
              <Badge tone={row.ssl_verify ? 'ok' : 'neutral'} className="hidden md:inline-flex">
                {row.ssl_verify ? 'SSL verify' : 'SSL relaxed'}
              </Badge>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button onClick={() => handlePoll(row)} disabled={pollingId === row.id} title="Poll now" className="pu-btn-ghost">
                  <PlugZap size={12} /> {pollingId === row.id ? 'Polling…' : 'Poll now'}
                </button>
                <button onClick={() => setMode({ edit: row })} className="pu-btn-ghost">
                  <Pencil size={12} /> Edit
                </button>
                <button onClick={() => handleDelete(row)} disabled={deletingId === row.id} className="pu-btn-ghost" style={{ color: deletingId === row.id ? undefined : undefined }}>
                  <Trash2 size={12} /> {deletingId === row.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
