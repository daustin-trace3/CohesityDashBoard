import { useEffect, useState, useCallback } from 'react';
import { Settings, Save, PlugZap, KeyRound, Copy, Check, Cloud, Clock, Gauge, Server, Database, DownloadCloud } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, Badge, RefreshButton } from '../../components/ui/primitives';
import { BRAND, timeAgo } from './helpers';
import PureDirectArraysTab from './PureDirectArraysTab';

export const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';

export function Field({ label, hint, children }) {
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
  const [tab, setTab] = useState('saas');
  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start w-fit mb-4">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
              }`}>
              <Icon size={13} className={active ? 'text-brand' : ''} /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'saas' ? <Pure1SaaSTab /> : <PureDirectArraysTab />}
    </div>
  );
}

function Pure1SaaSTab() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState(null);
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [ttl, setTtl] = useState(10);
  const [pollInterval, setPollInterval] = useState(60);
  const [warnPct, setWarnPct] = useState(75);
  const [critPct, setCritPct] = useState(90);
  const [showHidden, setShowHidden] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [status, setStatus] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => Promise.allSettled([
    client.get('/pure1/settings'),
    client.get('/pure1/status'),
  ])
    .then(([cfgRes, statusRes]) => {
      if (cfgRes.status === 'fulfilled') {
        const data = cfgRes.value.data;
        setCfg(data);
        // App ID is write-only: the server returns only a masked form.
        setAppId('');
        setTtl(data.cacheTtlMin || 10);
        setPollInterval(data.pollIntervalMin || 60);
        setWarnPct(data.warnPct || 75);
        setCritPct(data.critPct || 90);
        setShowHidden(!!data.showHiddenAlerts);
      } else {
        setCfg({ configured: false });
        toast({ type: 'error', title: 'Failed to load Pure settings' });
      }
      if (statusRes.status === 'fulfilled') setStatus(statusRes.value.data);
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const saveCreds = async () => {
    setSavingCreds(true);
    try {
      const patch = {};
      if (appId.trim()) patch.appId = appId.trim();
      if (privateKey.trim()) patch.privateKey = privateKey.trim();
      if (Object.keys(patch).length === 0) { toast({ type: 'info', title: 'Nothing to save' }); return; }
      const { data } = await client.put('/pure1/settings', patch);
      setCfg(data); setPrivateKey('');
      toast({ type: 'success', title: 'Credentials saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save.' });
    } finally { setSavingCreds(false); }
  };

  const savePrefs = async () => {
    setSavingPrefs(true);
    try {
      const { data } = await client.put('/pure1/settings', {
        cacheTtlMin: Number(ttl), pollIntervalMin: Number(pollInterval),
        warnPct: Number(warnPct), critPct: Number(critPct), showHiddenAlerts: showHidden,
      });
      setCfg(data);
      toast({ type: 'success', title: 'Preferences saved' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save.' });
    } finally { setSavingPrefs(false); }
  };

  const pollNow = async () => {
    setPolling(true);
    try {
      const { data } = await client.post('/pure1/poll');
      if (data.ok) {
        toast({ type: 'success', title: 'Poll complete', message: `Stored data for ${data.arrayCount} array(s)` });
      } else {
        toast({ type: 'error', title: 'Poll failed', message: data.error || 'Could not poll Pure1.' });
      }
      await load();
    } catch (err) {
      toast({ type: 'error', title: 'Poll failed', message: err?.response?.data?.error || 'Could not poll Pure1.' });
    } finally { setPolling(false); }
  };

  const testConn = async () => {
    setTesting(true); setTestResult(null);
    try {
      const { data } = await client.post('/pure1/test');
      setTestResult(data.ok ? { ok: true, msg: `Connected · ${data.arrayCount} arrays visible` } : { ok: false, msg: data.error });
    } catch (err) {
      setTestResult({ ok: false, msg: err?.response?.data?.error || 'Connection failed' });
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

      {/* Connection status */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Cloud size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Connection</p></div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-2">Status: {cfg.configured ? <Badge tone="ok">Configured</Badge> : <Badge tone="crit">Not configured</Badge>}</span>
          <span className="text-ink-muted">Key source: <span className="text-ink">{cfg.keySource}</span></span>
          <span className="text-ink-muted">App ID source: <span className="text-ink">{cfg.appIdSource}</span></span>
          <span className="text-ink-muted">Last data refresh: <span className="text-ink">{cfg.lastRefresh?.overview ? timeAgo(cfg.lastRefresh.overview) : '—'}</span></span>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={testConn} disabled={testing || !cfg.configured}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
            <PlugZap size={13} /> {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && <span className={`text-[12px] ${testResult.ok ? 'text-status-ok' : 'text-status-crit'}`}>{testResult.ok ? '✓ ' : '✗ '}{testResult.msg}</span>}
        </div>
      </div>

      {/* Credentials */}
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
                <textarea value={cfg.publicKey} readOnly rows={4} className={`${inp} font-mono text-[11px] pr-10`} />
                <button onClick={copyPublicKey} title="Copy" className="absolute top-2 right-2 text-ink-faint hover:text-ink">
                  {copied ? <Check size={14} className="text-status-ok" /> : <Copy size={14} />}
                </button>
              </div>
            </Field>
          )}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={saveCreds} disabled={savingCreds}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
            <Save size={13} /> {savingCreds ? 'Saving…' : 'Save credentials'}
          </button>
        </div>
      </div>

      {/* Data collection (polling) */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Database size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Data Collection</p></div>
        <p className="text-[12px] text-ink-muted mb-3">
          The dashboard periodically polls Pure1 and stores the results locally, so trending and dashboard views read from the
          database instead of hitting Pure1 on every request. Capacity history accumulates over time for long-term trends.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm mb-3">
          <span className="text-ink-muted">Last poll: <span className="text-ink">{status?.lastPoll?.at ? timeAgo(status.lastPoll.at) : '—'}</span></span>
          {status?.lastPoll && (
            <span className="text-ink-muted">
              Result: {status.lastPoll.ok
                ? <Badge tone="ok">{status.lastPoll.arrayCount} arrays stored</Badge>
                : <Badge tone="crit">Failed</Badge>}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Poll interval (min)" hint="How often fleet telemetry is collected and stored (15–1440).">
            <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={15} max={1440} value={pollInterval} onChange={(e) => setPollInterval(e.target.value)} className={inp} /></div>
          </Field>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={pollNow} disabled={polling || !cfg.configured}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-40">
            <DownloadCloud size={13} /> {polling ? 'Polling…' : 'Poll now'}
          </button>
          <span className="text-[11px] text-ink-faint">Interval changes apply after saving preferences below.</span>
        </div>
      </div>

      {/* Data & display preferences */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center gap-2 mb-3"><Gauge size={16} style={{ color: BRAND }} /><p className="text-sm font-semibold text-ink">Data &amp; Display</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Refresh interval (min)" hint="How long fleet data is cached before re-fetching.">
            <div className="flex items-center gap-2"><Clock size={14} className="text-ink-faint" /><input type="number" min={1} max={120} value={ttl} onChange={(e) => setTtl(e.target.value)} className={inp} /></div>
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
          Show hidden-severity alerts (Pure1 flags low-signal events as “hidden”)
        </label>
        <div className="flex items-center gap-2 mt-3">
          <button onClick={savePrefs} disabled={savingPrefs}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-40">
            <Save size={13} /> {savingPrefs ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      </div>
    </div>
  );
}
