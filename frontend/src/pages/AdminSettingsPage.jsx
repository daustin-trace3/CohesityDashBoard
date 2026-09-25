import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Sparkles, Save, Layers, KeyRound, Settings, Mail } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import AdminNav from '../components/AdminNav';
import { SWITCHER_MODES, getSwitcherMode } from '../components/PlatformSwitcher';
import { usePlatforms } from '../platforms/PlatformsContext';

// Sections rendered by this page; Users & Access and Plugins are their own
// routed pages sharing the same AdminNav shell.
const LOCAL_SECTIONS = ['ai', 'platforms', 'license', 'notifications'];

const NOTIFY_PLATFORMS = [
  { key: 'cohesity', label: 'Cohesity' },
  { key: 'pure', label: 'Pure Storage' },
  { key: 'netapp', label: 'NetApp' },
  { key: 'zerto', label: 'Zerto' },
  { key: 'vcenter', label: 'VMware vCenter' },
  { key: 'dell', label: 'Dell (OME)' },
  { key: 'aria', label: 'Aria Automation' },
  { key: 'aws', label: 'AWS' },
  { key: 'unifi', label: 'Ubiquiti UniFi' },
  { key: 'bluecat', label: 'BlueCat Address Manager' },
  { key: 'brocade', label: 'Brocade SAN' },
];

// Global AI provider tokens. Platform-specific credentials (Helios, Pure1,
// AIQUM) live on their own platform settings pages.
const LLM_PROVIDERS = [
  { value: 'auto', label: 'Automatic (OpenAI when its key is set, otherwise GitHub Models)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'github-models', label: 'GitHub Models' },
  { value: 'custom', label: 'Custom OpenAI-compatible endpoint (Copilot bridge, local model server)' },
];
const AI_TOKEN_FIELDS = [
  { name: 'openaiToken', label: 'OpenAI API token', providers: ['auto', 'openai'],
    hint: 'Pay-per-use. Under Automatic, all AI analyses use OpenAI whenever this key is set.' },
  { name: 'githubModelsToken', label: 'GitHub Models token', providers: ['auto', 'github-models'],
    hint: 'Free PAT with daily caps. Under Automatic it is used only when no OpenAI token is configured.' },
  { name: 'customEndpointToken', label: 'Endpoint API key', providers: ['custom'],
    hint: 'Sent as a Bearer token to the endpoint above. Leave empty if the endpoint takes no key.' },
];

function SourceBadge({ source }) {
  if (source === 'settings') return <Badge tone="ok">Stored encrypted</Badge>;
  if (source === 'env') return <Badge tone="warn">From .env (plain text)</Badge>;
  return <Badge tone="crit">Not set</Badge>;
}

export default function AdminSettingsPage() {
  const { section } = useParams();
  const tab = LOCAL_SECTIONS.includes(section) ? section : 'ai';
  const [estateContext, setEstateContext] = useState('');
  const [flagUnprotected, setFlagUnprotected] = useState(false);
  const [llmModel, setLlmModel] = useState('');
  const [llmProvider, setLlmProvider] = useState('auto');
  const [llmCustomEndpoint, setLlmCustomEndpoint] = useState('');
  const [savedProvider, setSavedProvider] = useState({ provider: 'auto', endpoint: '' });
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTest, setLlmTest] = useState(null);
  const [ttlHours, setTtlHours] = useState(24);
  const [serviceStatusAiEnabled, setServiceStatusAiEnabled] = useState(true);
  const [serviceStatusAnalysesPerMinute, setServiceStatusAnalysesPerMinute] = useState(3);
  const [serviceStatusDedupeMinutes, setServiceStatusDedupeMinutes] = useState(60);
  const [appServiceBackupStaleHours, setAppServiceBackupStaleHours] = useState(24);
  const [modelList, setModelList] = useState(null);   // { provider, models, default } | null
  const [modelsError, setModelsError] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  // Platform enable/disable moved to the merged Platforms page (/admin/plugins).
  const [customDashboardsEnabled, setCustomDashboardsEnabled] = useState(false);
  const [switcherMode, setSwitcherModeState] = useState(getSwitcherMode);
  const [opsOverviewStyle, setOpsOverviewStyle] = useState('classic');
  const [dnsServer, setDnsServer] = useState('');
  const [cohesityAlertWindowDays, setCohesityAlertWindowDays] = useState(5);
  const [license, setLicense] = useState(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [credSources, setCredSources] = useState({});
  const [credInputs, setCredInputs] = useState({});
  const [savingCreds, setSavingCreds] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const [notify, setNotify] = useState(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyPassword, setNotifyPassword] = useState('');
  const [notifyPasswordCleared, setNotifyPasswordCleared] = useState(false);
  const [savingNotify, setSavingNotify] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);

  const { platforms: allPlatforms } = usePlatforms();
  const cohesityPresent = allPlatforms.some(p => p.id === 'cohesity');

  // Merge API-provided plugin platforms (Phase 1 manifest-driven core hooks)
  // with the static list, keeping the static list as the fallback/ordering base.
  // The cohesity entry is dropped when cohesity itself isn't a registered
  // platform, so the toggle disappears cleanly once it's converted to a plugin.
  const notifyPlatforms = [
    ...NOTIFY_PLATFORMS.filter(p => p.key !== 'cohesity' || cohesityPresent),
    ...(notify?.platforms || []).filter(p => !NOTIFY_PLATFORMS.some(np => np.key === p.key)),
  ];

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/settings/ai-config'),
      client.get('/license/status'),
      client.get('/settings/credentials'),
    ]).then(([s, c, l, cr]) => {
      if (l.status === 'fulfilled') setLicense(l.value.data);
      if (cr.status === 'fulfilled') setCredSources(cr.value.data);
      if (s.status === 'fulfilled') {
        const d = s.value.data;
        setEstateContext(d.llmEstateContext || '');
        setFlagUnprotected(!!d.llmFlagUnprotected);
        setLlmModel(d.llmModel || '');
        setLlmProvider(d.llmProvider || 'auto');
        setLlmCustomEndpoint(d.llmCustomEndpoint || '');
        setSavedProvider({ provider: d.llmProvider || 'auto', endpoint: d.llmCustomEndpoint || '' });
        setTtlHours(d.llmAnalysisTtlHours || 24);
        setServiceStatusAiEnabled(d.serviceStatusAiEnabled !== false);
        setServiceStatusAnalysesPerMinute(d.serviceStatusAnalysesPerMinute || 3);
        setServiceStatusDedupeMinutes(d.serviceStatusDedupeMinutes ?? 60);
        setAppServiceBackupStaleHours(d.appServiceBackupStaleHours || 24);
        setCustomDashboardsEnabled(!!d.featureCustomDashboardsEnabled);
        setOpsOverviewStyle(d.opsOverviewStyle || 'classic');
        setDnsServer(d.dnsServer || '');
        setCohesityAlertWindowDays(d.cohesityAlertWindowDays ?? 5);
      }
      if (c.status === 'fulfilled') setAiEnabled(!!c.value.data.enabled);
    }).finally(() => setLoading(false));

    refreshModels();
  }, []);

  /** Reload the picker from the active provider; a picked model the new
   *  provider does not list is cleared (and the cleared value saved). */
  const refreshModels = async () => {
    setModelList(null);
    setModelsError(null);
    try {
      const { data } = await client.get('/settings/llm-models');
      setModelList(data);
      const stale = llmModel && Array.isArray(data.models) && data.models.length > 0 && !data.models.includes(llmModel);
      if (stale) {
        setLlmModel('');
        await client.put('/settings', { llmModel: '' }).catch(() => {});
      }
      return true;
    } catch (err) {
      setModelsError(err?.response?.data?.error || 'Could not load the model list from the AI provider.');
      return false;
    }
  };

  const providerDirty = llmProvider !== savedProvider.provider
    || llmCustomEndpoint.trim() !== savedProvider.endpoint
    || AI_TOKEN_FIELDS.some(f => (credInputs[f.name] || '').trim());

  /** Provider choice and endpoint first (the server drops the stored key when
   *  the URL changes), then any keys typed in this round. */
  const saveProvider = async () => {
    setSavingCreds(true);
    try {
      await client.put('/settings', { llmProvider, llmCustomEndpoint: llmCustomEndpoint.trim() });
      const payload = {};
      for (const f of AI_TOKEN_FIELDS) {
        const v = (credInputs[f.name] || '').trim();
        if (v) payload[f.name] = v;
      }
      const { data } = await client.put('/settings/credentials', payload);
      setCredSources(data);
      setCredInputs({});
      setSavedProvider({ provider: llmProvider, endpoint: llmCustomEndpoint.trim() });
      setLlmTest(null);
      window.dispatchEvent(new Event('ai-status-changed'));
      const ok = await refreshModels();
      if (ok) setAiEnabled(true);
      toast({ type: 'success', title: 'AI provider saved', message: 'Applied immediately — no restart needed.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save the AI provider. Try again.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const testLlm = async () => {
    setTestingLlm(true);
    setLlmTest(null);
    try {
      const { data } = await client.post('/settings/llm-test', {
        endpoint: llmCustomEndpoint.trim(),
        apiToken: (credInputs.customEndpointToken || '').trim(),
        model: llmModel,
      });
      setLlmTest(data);
    } catch (e) {
      setLlmTest({ error: e?.response?.data?.error || 'Test failed.' });
    } finally {
      setTestingLlm(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', {
        llmEstateContext: estateContext,
        llmFlagUnprotected: flagUnprotected,
        llmModel,
        llmAnalysisTtlHours: Number(ttlHours) || 24,
        serviceStatusAiEnabled,
        serviceStatusAnalysesPerMinute: Number(serviceStatusAnalysesPerMinute) || 3,
        serviceStatusDedupeMinutes: Number(serviceStatusDedupeMinutes) || 0,
        appServiceBackupStaleHours: Number(appServiceBackupStaleHours) || 24,
        featureCustomDashboardsEnabled: customDashboardsEnabled,
        opsOverviewStyle,
        dnsServer,
        cohesityAlertWindowDays: Number(cohesityAlertWindowDays) || 0,
      });
      window.dispatchEvent(new Event('platforms-changed'));
      window.dispatchEvent(new Event('ops-style-changed'));
      toast({ type: 'success', title: 'Settings saved', message: 'Global settings updated.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const clearCredential = async (name) => {
    setSavingCreds(true);
    try {
      const { data } = await client.put('/settings/credentials', { [name]: '' });
      setCredSources(data);
      window.dispatchEvent(new Event('ai-status-changed'));
      toast({ type: 'success', title: 'Stored key cleared', message: 'The .env value (if any) applies again.' });
    } catch {
      toast({ type: 'error', title: 'Clear failed', message: 'Could not clear the key. Try again.' });
    } finally {
      setSavingCreds(false);
    }
  };

  const activateLicense = async () => {
    const key = licenseKeyInput.trim();
    if (!key) return;
    setActivating(true);
    try {
      const { data } = await client.post('/license/activate', { key });
      setLicense(data);
      setLicenseKeyInput('');
      toast({
        type: 'success',
        title: 'License updated',
        message: data.effectiveExpiry ? `Valid through ${data.effectiveExpiry}.` : 'License applied.',
      });
    } catch (err) {
      toast({ type: 'error', title: 'Could not apply license', message: err?.response?.data?.error || 'Invalid or expired key.' });
    } finally {
      setActivating(false);
    }
  };

  useEffect(() => {
    if (tab !== 'notifications' || notify) return;
    setNotifyLoading(true);
    client.get('/settings/notifications')
      .then(({ data }) => setNotify(data))
      .catch(() => toast({ type: 'error', title: 'Could not load', message: 'Could not load notification settings.' }))
      .finally(() => setNotifyLoading(false));
  }, [tab, notify, toast]);

  const saveNotify = async () => {
    if (!notify) return;
    setSavingNotify(true);
    try {
      const payload = {
        smtpEnabled: notify.smtpEnabled,
        smtpHost: notify.smtpHost,
        smtpPort: Number(notify.smtpPort) || 587,
        smtpEncryption: notify.smtpEncryption,
        smtpAuthMethod: notify.smtpAuthMethod,
        smtpUsername: notify.smtpUsername,
        smtpFrom: notify.smtpFrom,
        smtpRecipients: notify.smtpRecipients,
        alertMinSeverity: notify.alertMinSeverity,
        alertPlatforms: notify.alertPlatforms,
        reminderHours: Number(notify.reminderHours) || 0,
      };
      if (notifyPassword) payload.smtpPassword = notifyPassword;
      else if (notifyPasswordCleared) payload.smtpPassword = '';
      const { data } = await client.put('/settings/notifications', payload);
      setNotify(data);
      setNotifyPassword('');
      setNotifyPasswordCleared(false);
      toast({ type: 'success', title: 'Settings saved', message: 'Alert notification settings updated.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error || 'Could not save notification settings. Try again.' });
    } finally {
      setSavingNotify(false);
    }
  };

  const sendTestNotify = async () => {
    setTestingNotify(true);
    try {
      await client.post('/settings/notifications/test');
      toast({ type: 'success', title: 'Test email sent', message: 'Check the configured recipients.' });
    } catch (err) {
      toast({ type: 'error', title: 'Test email failed', message: err?.response?.data?.error || 'Could not send the test email.' });
    } finally {
      setTestingNotify(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
          <Settings size={16} className="text-brand" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">Global Settings</h1>
          <p className="text-xs text-ink-muted mt-0.5">Estate-wide administration — AI, platforms, and product licensing. Platform-specific credentials live on each platform's own Settings page.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-5 items-start">
        <AdminNav />
        <div className="flex flex-col gap-4 max-w-3xl flex-1 min-w-0">

      {/* AI Analysis & Keys */}
      {tab === 'ai' && (
      <>
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Sparkles size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">AI Provider</p>
            <p className="text-[11px] text-ink-muted">
              Keys are stored <span className="text-ink">AES-256-GCM encrypted</span> in the local database, never displayed again,
              and applied immediately. A stored key overrides <code>.env</code>; once it shows "Stored encrypted" you can
              remove the token from <code>.env</code>.
            </p>
          </div>
        </div>

        {!aiEnabled && (
          <p className="mt-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
            AI analysis is not configured — pick a provider and add its key, or point ICC at a custom OpenAI-compatible endpoint.
          </p>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
            <div>
              <label htmlFor="llm-provider" className="block text-xs font-semibold text-ink mb-1">Provider</label>
              <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                Which service answers every AI analysis (cluster reviews, Ask AI, advisors, Service Status). Keys for the
                other providers stay stored, so switching back is one save.
              </p>
              <select
                id="llm-provider"
                value={llmProvider}
                onChange={e => setLlmProvider(e.target.value)}
                className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
              >
                {LLM_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {llmProvider === 'custom' && (
              <div>
                <label htmlFor="llm-custom-endpoint" className="block text-xs font-semibold text-ink mb-1">Endpoint URL</label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                  Any OpenAI-compatible server (a Copilot bridge, a local model server). Paste the chat completions URL or
                  the API base; ICC keeps the base and calls <code>/models</code> and <code>/chat/completions</code> under it.
                  Changing the URL drops the stored key, so type the key again with a new address.
                </p>
                <input
                  id="llm-custom-endpoint"
                  type="text"
                  autoComplete="off"
                  value={llmCustomEndpoint}
                  onChange={e => setLlmCustomEndpoint(e.target.value)}
                  placeholder="http://127.0.0.1:8787/v1/chat/completions"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
                />
              </div>
            )}
            {AI_TOKEN_FIELDS.filter(f => f.providers.includes(llmProvider)).map(f => (
              <div key={f.name}>
                <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                  <label htmlFor={`cred-${f.name}`} className="text-xs font-semibold text-ink">{f.label}</label>
                  <SourceBadge source={credSources[f.name] || 'none'} />
                  {credSources[f.name] === 'settings' && (
                    <button
                      onClick={() => clearCredential(f.name)}
                      disabled={savingCreds}
                      className="text-[10px] text-ink-faint hover:text-status-crit underline underline-offset-2 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      Clear stored value
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">{f.hint}</p>
                <input
                  id={`cred-${f.name}`}
                  type="password"
                  autoComplete="off"
                  value={credInputs[f.name] || ''}
                  onChange={e => setCredInputs(s => ({ ...s, [f.name]: e.target.value }))}
                  placeholder={credSources[f.name] === 'settings' ? '•••••••• (stored — enter a new value to replace)' : 'Paste token to store encrypted'}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
                />
              </div>
            ))}
            {llmProvider === 'custom' && (
              <div>
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={testLlm}
                    disabled={testingLlm || !llmCustomEndpoint.trim()}
                    className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Sparkles size={13} /> {testingLlm ? 'Testing…' : 'Test endpoint'}
                  </button>
                  <span className="text-[11px] text-ink-faint">
                    Checks the endpoint is alive, lists its models and sends a one-word chat. A blank key uses the stored key only for the saved URL.
                  </span>
                </div>
                {llmTest && (
                  <div className={`mt-2 text-[11px] rounded-md px-2.5 py-1.5 border ${llmTest.error ? 'text-red-400 bg-red-400/10 border-red-400/30' : 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30'}`}>
                    {llmTest.error ? llmTest.error : (
                      <>
                        <span>Alive at {llmTest.endpoint} ({llmTest.latencyMs} ms). </span>
                        {llmTest.modelsError
                          ? <span className="text-amber-400">Model list failed ({llmTest.modelsError}); type a model id under Default AI model. </span>
                          : <span>{llmTest.models.length} model{llmTest.models.length === 1 ? '' : 's'}{llmTest.models.length ? `: ${llmTest.models.slice(0, 8).join(', ')}${llmTest.models.length > 8 ? ', ...' : ''}` : ''}. </span>}
                        {llmTest.chat?.ok
                          ? <span>Chat OK{llmTest.chat.model ? ` on ${llmTest.chat.model}` : ''} ({llmTest.chat.latencyMs} ms), reply "{llmTest.chat.reply}".</span>
                          : <span className="text-amber-400">Chat failed: {llmTest.chat?.error}</span>}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={saveProvider}
                disabled={savingCreds || !providerDirty}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {savingCreds ? 'Saving…' : 'Save AI provider'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Sparkles size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">AI Analysis Behavior</p>
            <p className="text-[11px] text-ink-muted">
              Controls the on-demand AI analyses — the cluster-card <span className="text-ink">System Analysis</span>, the
              Intelligent Insights <span className="text-ink">Ask AI</span> (alerts), and the AI Advisor reports.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="llm-model" className="block text-xs font-semibold text-ink mb-1">
                  Default AI model {modelList?.provider && <span className="text-ink-faint font-normal">({modelList.provider})</span>}
                </label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                  Model used for all AI analyses. Applies to the next run — no restart.
                </p>
                {modelList ? (
                  <select
                    id="llm-model"
                    value={llmModel}
                    onChange={e => setLlmModel(e.target.value)}
                    className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
                  >
                    <option value="">Provider default ({modelList.default})</option>
                    {modelList.models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : modelsError ? (
                  <>
                    <p className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5 mb-1.5">{modelsError}</p>
                    <input
                      id="llm-model"
                      type="text"
                      value={llmModel}
                      onChange={e => setLlmModel(e.target.value)}
                      placeholder="Type a model id"
                      className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
                    />
                  </>
                ) : (
                  <p className="text-[11px] text-ink-faint">Loading models…</p>
                )}
              </div>
              <div>
                <label htmlFor="ttl-hours" className="block text-xs font-semibold text-ink mb-1">Analysis freshness window (hours)</label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                  Cached AI analyses older than this are flagged stale and the UI prompts a re-run. 1–720 hours.
                </p>
                <input
                  id="ttl-hours"
                  type="number" min="1" max="720" step="1"
                  value={ttlHours}
                  onChange={e => setTtlHours(e.target.value)}
                  className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
                />
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-ink mb-1">Service Status AI analysis</p>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                Each critical alert on the Service Status page gets one AI analysis. The cap limits how many run per minute; the rest wait in a queue.
              </p>
              <label className="flex items-start gap-2.5 cursor-pointer select-none mb-3">
                <input
                  type="checkbox"
                  checked={serviceStatusAiEnabled}
                  onChange={e => setServiceStatusAiEnabled(e.target.checked)}
                  className="accent-brand mt-0.5 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  <span className="font-semibold text-ink">Analyze critical alerts automatically</span>
                </span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="service-status-rate" className="block text-xs font-semibold text-ink mb-1">AI analyses per minute</label>
                  <input
                    id="service-status-rate"
                    type="number" min="1" max="30" step="1"
                    value={serviceStatusAnalysesPerMinute}
                    onChange={e => setServiceStatusAnalysesPerMinute(e.target.value)}
                    className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
                  />
                </div>
                <div>
                  <label htmlFor="service-status-dedupe" className="block text-xs font-semibold text-ink mb-1">Reuse an identical analysis within (minutes)</label>
                  <input
                    id="service-status-dedupe"
                    type="number" min="0" max="1440" step="1"
                    value={serviceStatusDedupeMinutes}
                    onChange={e => setServiceStatusDedupeMinutes(e.target.value)}
                    className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
                  />
                </div>
              </div>
            </div>

            <div>
              <label htmlFor="app-service-backup-hours" className="block text-xs font-semibold text-ink mb-1">App Services acceptable backup age (hours)</label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                On the App Services page a protected server shows Degraded when its newest Cohesity backup is older than this. Raise it to 48 or 96 for servers backed up less often than daily. No other page uses this value.
              </p>
              <input
                id="app-service-backup-hours"
                type="number" min="1" max="720" step="1"
                value={appServiceBackupStaleHours}
                onChange={e => setAppServiceBackupStaleHours(e.target.value)}
                className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
              />
            </div>

            <div>
              <label htmlFor="estate-context" className="block text-xs font-semibold text-ink mb-1">
                Operator context — what's normal for your estate
              </label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                Injected into <span className="text-ink">every</span> AI analysis as authoritative context, so the model doesn't
                flag normal patterns. Applies immediately to the next run — no restart. Example: explain that objects unprotected
                on one cluster are protected on another, or describe what tagged target/archive clusters do.
              </p>
              <textarea
                id="estate-context"
                value={estateContext}
                onChange={e => setEstateContext(e.target.value)}
                rows={6}
                maxLength={4000}
                placeholder='e.g. Objects shown as unprotected on a cluster are typically protected on another Cohesity cluster — this is normal and not a risk. Clusters tagged "target" or "archive" are replication/archive destinations where thousands of unprotected sources are expected.'
                className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none resize-y"
              />
              <p className="text-[10px] text-ink-faint mt-1 text-right tnum">{estateContext.length}/4000</p>
            </div>

            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={flagUnprotected}
                onChange={e => setFlagUnprotected(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer"
              />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Include protection coverage in System Analysis</span><br />
                Off by default. When off, the System Analysis ignores unprotected objects entirely and focuses on what the cluster
                is actively doing (capacity, backup jobs, replication). Turn on only if you want the AI to assess coverage gaps.
              </span>
            </label>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>
        )}
      </div>
      </>
      )}

      {/* Features & preferences (platform enable/disable lives on the merged Platforms page) */}
      {tab === 'platforms' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Layers size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Features & Preferences</p>
            <p className="text-[11px] text-ink-muted">
              Preview features, switcher style, and estate-wide preferences. Platform on/off toggles moved to the{' '}
              <Link to="/admin/plugins" className="text-brand hover:text-brand-bright">Platforms</Link> page.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            <div>
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Preview features</p>
              <label className="flex items-start gap-2.5 cursor-pointer select-none mt-1">
                <input type="checkbox" checked={customDashboardsEnabled} onChange={e => setCustomDashboardsEnabled(e.target.checked)}
                  className="accent-brand mt-0.5 cursor-pointer" />
                <span className="text-xs text-ink-muted leading-relaxed">
                  <span className="font-semibold text-ink">Custom Dashboards</span><br />
                  Show the Custom Dashboards page under Estate and enable its APIs. Leave off while the
                  feature is still being refined — when off it is hidden from all users.
                </span>
              </label>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Ops Monitor default view</p>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                The overview style every user lands on at /ops. The toggle on the page itself is a
                temporary override for that browser session. Saved with the button below.
              </p>
              <div className="flex flex-col gap-1.5">
                {[
                  { id: 'classic', label: 'Classic', hint: 'card grid with the estate strip' },
                  { id: 'drift', label: 'Drift', hint: 'light, floating cards, curve sparks' },
                  { id: 'nocturne', label: 'Nocturne', hint: 'dark, estate health ring, ranked ledger' },
                ].map(o => (
                  <label key={o.id} className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input type="radio" name="ops-overview-style" className="accent-brand cursor-pointer"
                      checked={opsOverviewStyle === o.id} onChange={() => setOpsOverviewStyle(o.id)} />
                    <span className="text-xs text-ink-muted"><span className="text-ink font-medium">{o.label}</span>, {o.hint}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <p className="text-xs font-semibold text-ink mb-1 mt-2">Platform switcher style</p>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                How the platform selector is presented — trial the styles and we'll keep the winner.
                Applies immediately, saved per browser.
              </p>
              <div className="flex flex-col gap-1.5">
                {SWITCHER_MODES.map(m => (
                  <label key={m.id} className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input type="radio" name="switcher-mode" className="accent-brand cursor-pointer"
                      checked={switcherMode === m.id}
                      onChange={() => {
                        localStorage.setItem('platform-switcher-mode', m.id);
                        setSwitcherModeState(m.id);
                        window.dispatchEvent(new Event('switcher-mode-changed'));
                      }} />
                    <span className="text-xs text-ink-muted">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <label htmlFor="dns-server" className="block text-xs font-semibold text-ink mb-1 mt-2">DNS resolver <span className="text-ink-faint font-normal">(optional)</span></label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                DNS server IP (or hostname) used to reverse-resolve IP addresses to names across the dashboard — e.g. NFS client IPs. Leave blank to disable hostname lookups.
              </p>
              <input id="dns-server" type="text" value={dnsServer} onChange={e => setDnsServer(e.target.value)}
                placeholder="e.g. 172.17.0.10"
                className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none tnum" />
            </div>

            <div className="pt-2 border-t border-cohesity-border/60">
              <label htmlFor="cohesity-alert-window" className="block text-xs font-semibold text-ink mb-1 mt-2">Cohesity alert window (days)</label>
              <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                A Cohesity alert counts only while it has fired within this many days. Older open alerts that nobody resolved on the cluster drop off every page at the next poll, and come back if they fire again. 0 keeps every open alert.
              </p>
              <input id="cohesity-alert-window" type="number" min="0" max="365" step="1" value={cohesityAlertWindowDays}
                onChange={e => setCohesityAlertWindowDays(e.target.value)}
                className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum" />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={save}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Product license — status only, key is never displayed */}
      {tab === 'license' && !license && (
        <div className="panel p-4">
          <p className="text-xs text-ink-faint">License status is unavailable right now.</p>
        </div>
      )}
      {tab === 'license' && license && (
        <div className="panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <KeyRound size={14} className="text-brand" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Product License</p>
              <p className="text-[11px] text-ink-muted">This installation's license status. Renewals apply automatically once payment is processed.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Badge tone={license.state === 'valid' ? 'ok' : license.state === 'grace' ? 'warn' : 'crit'}>
              {license.state === 'valid' ? 'Valid' : license.state === 'grace' ? 'Expired — grace period' : 'Not licensed'}
            </Badge>
            {license.customer && (
              <span className="text-xs text-ink-muted">Licensed to <span className="text-ink font-semibold">{license.customer}</span></span>
            )}
            {license.effectiveExpiry && (
              <span className="text-xs text-ink-muted">Expires <span className="text-ink font-semibold tnum">{license.effectiveExpiry}</span>
                {license.state === 'valid' && license.daysLeft != null && <span className="text-ink-faint"> · {license.daysLeft} days left</span>}
                {license.state === 'grace' && license.graceDaysLeft != null && <span className="text-status-crit font-semibold"> · locks in {license.graceDaysLeft} day{license.graceDaysLeft === 1 ? '' : 's'}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {tab === 'license' && (
        <div className="panel p-4 mt-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <KeyRound size={14} className="text-brand" />
            </div>
            <div>
              <p className="text-sm font-bold text-ink">Update license key</p>
              <p className="text-[11px] text-ink-muted">Paste a new product license key (starts with <code>CDBL-</code>) to replace the current one — e.g. a multi-year renewal.</p>
            </div>
          </div>
          <textarea
            value={licenseKeyInput}
            onChange={(e) => setLicenseKeyInput(e.target.value)}
            rows={3}
            placeholder="CDBL-…"
            spellCheck={false}
            className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-[11px] font-mono text-ink focus:border-brand/60 outline-none mt-3"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={activateLicense}
              disabled={activating || !licenseKeyInput.trim()}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <KeyRound size={13} /> {activating ? 'Applying…' : 'Apply license key'}
            </button>
          </div>
        </div>
      )}

      {/* Alert Notifications */}
      {tab === 'notifications' && (
      <>
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Mail size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">SMTP Server</p>
            <p className="text-[11px] text-ink-muted">Email delivery settings used to send alert notifications.</p>
          </div>
        </div>

        {notifyLoading || !notify ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4 mt-4">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={notify.smtpEnabled}
                onChange={e => setNotify(s => ({ ...s, smtpEnabled: e.target.checked }))}
                className="accent-brand mt-0.5 cursor-pointer"
              />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Enable SMTP email notifications</span>
              </span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtp-host" className="block text-xs font-semibold text-ink mb-1">Host</label>
                <input
                  id="smtp-host"
                  type="text"
                  value={notify.smtpHost}
                  onChange={e => setNotify(s => ({ ...s, smtpHost: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
              <div>
                <label htmlFor="smtp-port" className="block text-xs font-semibold text-ink mb-1">Port</label>
                <input
                  id="smtp-port"
                  type="number" min="1" max="65535" step="1"
                  value={notify.smtpPort}
                  onChange={e => setNotify(s => ({ ...s, smtpPort: e.target.value }))}
                  className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
                />
              </div>
              <div>
                <label htmlFor="smtp-encryption" className="block text-xs font-semibold text-ink mb-1">Encryption</label>
                <select
                  id="smtp-encryption"
                  value={notify.smtpEncryption}
                  onChange={e => setNotify(s => ({ ...s, smtpEncryption: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
                >
                  <option value="none">None</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">SSL/TLS</option>
                </select>
              </div>
              <div>
                <label htmlFor="smtp-auth-method" className="block text-xs font-semibold text-ink mb-1">Auth method</label>
                <select
                  id="smtp-auth-method"
                  value={notify.smtpAuthMethod}
                  onChange={e => setNotify(s => ({ ...s, smtpAuthMethod: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
                >
                  <option value="none">None</option>
                  <option value="login">Username &amp; password</option>
                </select>
              </div>
            </div>

            {notify.smtpAuthMethod !== 'none' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="smtp-username" className="block text-xs font-semibold text-ink mb-1">Username</label>
                  <input
                    id="smtp-username"
                    type="text"
                    autoComplete="off"
                    value={notify.smtpUsername}
                    onChange={e => setNotify(s => ({ ...s, smtpUsername: e.target.value }))}
                    className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                    <label htmlFor="smtp-password" className="text-xs font-semibold text-ink">Password</label>
                    {notify.smtpPasswordSet && !notifyPasswordCleared && (
                      <button
                        onClick={() => { setNotifyPasswordCleared(true); setNotifyPassword(''); }}
                        className="text-[10px] text-ink-faint hover:text-status-crit underline underline-offset-2 transition-colors cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <input
                    id="smtp-password"
                    type="password"
                    autoComplete="off"
                    value={notifyPassword}
                    onChange={e => { setNotifyPassword(e.target.value); setNotifyPasswordCleared(false); }}
                    placeholder={notify.smtpPasswordSet && !notifyPasswordCleared ? 'unchanged — leave blank to keep' : ''}
                    className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs font-mono text-ink focus:border-brand/60 outline-none"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="smtp-from" className="block text-xs font-semibold text-ink mb-1">From address</label>
                <input
                  id="smtp-from"
                  type="text"
                  value={notify.smtpFrom}
                  onChange={e => setNotify(s => ({ ...s, smtpFrom: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
              <div>
                <label htmlFor="smtp-recipients" className="block text-xs font-semibold text-ink mb-1">Default recipients</label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
                  Comma-separated email addresses. Used by any platform that has not set its own recipients
                  on its Settings page, under Alert Notifications.
                </p>
                <input
                  id="smtp-recipients"
                  type="text"
                  value={notify.smtpRecipients}
                  onChange={e => setNotify(s => ({ ...s, smtpRecipients: e.target.value }))}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {!notifyLoading && notify && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Mail size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Alert Filtering</p>
            <p className="text-[11px] text-ink-muted">Which alerts trigger an email.</p>
          </div>
        </div>

        <div className="flex flex-col gap-4 mt-4">
          <div>
            <label htmlFor="alert-min-severity" className="block text-xs font-semibold text-ink mb-1">Default minimum severity</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">
              Alerts below this severity are not emailed, for any platform that has not set its own minimum
              severity on its Settings page.
            </p>
            <select
              id="alert-min-severity"
              value={notify.alertMinSeverity}
              onChange={e => setNotify(s => ({ ...s, alertMinSeverity: e.target.value }))}
              className="w-full max-w-xs bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer"
            >
              <option value="info">Info and above</option>
              <option value="warning">Warning and above</option>
              <option value="critical">Critical only</option>
            </select>
          </div>

          <div className="flex flex-col gap-2">
            {notifyPlatforms.map(p => (
              <label key={p.key} className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!notify.alertPlatforms?.[p.key]}
                  onChange={e => setNotify(s => ({ ...s, alertPlatforms: { ...s.alertPlatforms, [p.key]: e.target.checked } }))}
                  className="accent-brand mt-0.5 cursor-pointer"
                />
                <span className="text-xs text-ink-muted leading-relaxed">
                  <span className="font-semibold text-ink">{p.label}</span>
                </span>
              </label>
            ))}
          </div>

          <div>
            <label htmlFor="reminder-hours" className="block text-xs font-semibold text-ink mb-1">Reminder interval (hours)</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">Unresolved alerts re-notify at this interval — 0 disables reminders</p>
            <input
              id="reminder-hours"
              type="number" min="0" max="168" step="1"
              value={notify.reminderHours}
              onChange={e => setNotify(s => ({ ...s, reminderHours: e.target.value }))}
              className="w-full max-w-[10rem] bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none tnum"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={sendTestNotify}
              disabled={testingNotify}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-surface-overlay border border-cohesity-border text-ink rounded-lg hover:bg-surface transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Mail size={13} /> {testingNotify ? 'Sending…' : 'Send test email'}
            </button>
            <button
              onClick={saveNotify}
              disabled={savingNotify}
              className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Save size={13} /> {savingNotify ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </div>
      )}
      </>
      )}
        </div>
      </div>
    </div>
  );
}
