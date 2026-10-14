import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles, KeyRound, FileText, Activity, Bot, Mail, Wrench, ShieldCheck } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { useAuth } from '../auth/AuthContext';
import PrivacyInspectorPage from '../components/PrivacyInspectorPage';
import AgentCapabilitiesPanel from '../components/AgentCapabilitiesPanel';
import {
  SettingRow, SettingGroup, Toggle, TabSaveBar, inputCls, numberCls, selectCls,
} from '../components/settings/SettingRow';

// Global Settings > Intelligence: AI provider, keys, analysis options and the
// Operations Agent, one tab each. The tab lives in ?tab= so it survives a
// reload; the old /admin/ai and /admin/agent* routes redirect here.

export const INTEL_TABS = [
  { key: 'provider', label: 'AI provider', icon: Sparkles },
  { key: 'keys', label: 'Keys', icon: KeyRound },
  { key: 'context', label: 'Estate context', icon: FileText },
  { key: 'status', label: 'Service Status AI', icon: Activity },
  { key: 'agent', label: 'Operations Agent', icon: Bot, requiresAi: true },
  { key: 'email', label: 'Agent email', icon: Mail, requiresAi: true },
  { key: 'capabilities', label: 'Capabilities', icon: Wrench, requiresAi: true },
  { key: 'privacy', label: 'Privacy', icon: ShieldCheck, requiresAi: true, permission: 'admin:ai-audit:view' },
];

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
    hint: 'Sent as a Bearer token to the custom endpoint URL. Leave empty if the endpoint takes no key.' },
];

// Which form fields each saving tab owns.
const TAB_FIELDS = {
  provider: ['llmProvider', 'llmCustomEndpoint', 'llmModel'],
  context: ['llmEstateContext', 'llmFlagUnprotected', 'llmAnalysisTtlHours', 'appServiceBackupStaleHours'],
  status: ['serviceStatusAiEnabled', 'serviceStatusAnalysesPerMinute', 'serviceStatusDedupeMinutes'],
  agent: ['agentEnabled', 'agentName', 'agentGrouping', 'agentMinSeverity', 'agentHoldMinutes', 'agentAnalysesPerHour',
    'agentRenotifyMinutes', 'agentAutoResolveMinutes', 'agentEvidenceResolve', 'agentPatternMin', 'agentPatternDays'],
  email: ['agentEmailEnabled', 'agentRecipients'],
};

const DEFAULT_FORM = {
  llmProvider: 'auto', llmCustomEndpoint: '', llmModel: '',
  llmEstateContext: '', llmFlagUnprotected: false, llmAnalysisTtlHours: 24, appServiceBackupStaleHours: 24,
  serviceStatusAiEnabled: true, serviceStatusAnalysesPerMinute: 3, serviceStatusDedupeMinutes: 60,
  agentEnabled: false, agentName: 'ICC Operations Agent', agentGrouping: 'platform', agentMinSeverity: 'warning',
  agentHoldMinutes: 10, agentAnalysesPerHour: 20, agentRenotifyMinutes: 60, agentAutoResolveMinutes: 30,
  agentEvidenceResolve: true, agentPatternMin: 3, agentPatternDays: 14,
  agentEmailEnabled: true, agentRecipients: '',
};

function formFromSettings(d) {
  const a = d.opsAgent || {};
  return {
    llmProvider: d.llmProvider || 'auto',
    llmCustomEndpoint: d.llmCustomEndpoint || '',
    llmModel: d.llmModel || '',
    llmEstateContext: d.llmEstateContext || '',
    llmFlagUnprotected: !!d.llmFlagUnprotected,
    llmAnalysisTtlHours: d.llmAnalysisTtlHours || 24,
    appServiceBackupStaleHours: d.appServiceBackupStaleHours || 24,
    serviceStatusAiEnabled: d.serviceStatusAiEnabled !== false,
    serviceStatusAnalysesPerMinute: d.serviceStatusAnalysesPerMinute || 3,
    serviceStatusDedupeMinutes: d.serviceStatusDedupeMinutes ?? 60,
    agentEnabled: !!a.enabled,
    agentName: a.name || 'ICC Operations Agent',
    agentGrouping: a.grouping || 'platform',
    agentMinSeverity: a.minSeverity || 'warning',
    agentHoldMinutes: a.holdMinutes ?? 10,
    agentAnalysesPerHour: a.analysesPerHour ?? 20,
    agentRenotifyMinutes: a.renotifyMinutes ?? 60,
    agentAutoResolveMinutes: a.autoResolveMinutes ?? 30,
    agentEvidenceResolve: a.evidenceResolve !== false,
    agentPatternMin: a.patternMin ?? 3,
    agentPatternDays: a.patternDays ?? 14,
    agentEmailEnabled: a.emailEnabled !== false,
    agentRecipients: a.recipients || '',
  };
}

// Request body for one tab; field names are the backend's, unchanged.
function payloadFor(tab, f) {
  switch (tab) {
    case 'provider':
      return { llmProvider: f.llmProvider, llmCustomEndpoint: f.llmCustomEndpoint.trim(), llmModel: f.llmModel };
    case 'context':
      return {
        llmEstateContext: f.llmEstateContext,
        llmFlagUnprotected: f.llmFlagUnprotected,
        llmAnalysisTtlHours: Number(f.llmAnalysisTtlHours) || 24,
        appServiceBackupStaleHours: Number(f.appServiceBackupStaleHours) || 24,
      };
    case 'status':
      return {
        serviceStatusAiEnabled: f.serviceStatusAiEnabled,
        serviceStatusAnalysesPerMinute: Number(f.serviceStatusAnalysesPerMinute) || 3,
        serviceStatusDedupeMinutes: Number(f.serviceStatusDedupeMinutes) || 0,
      };
    case 'agent':
      return {
        opsAgent: {
          enabled: f.agentEnabled, name: f.agentName, minSeverity: f.agentMinSeverity, grouping: f.agentGrouping,
          holdMinutes: Number(f.agentHoldMinutes), analysesPerHour: Number(f.agentAnalysesPerHour) || 20,
          renotifyMinutes: Number(f.agentRenotifyMinutes), autoResolveMinutes: Number(f.agentAutoResolveMinutes),
          evidenceResolve: f.agentEvidenceResolve, patternMin: Number(f.agentPatternMin), patternDays: Number(f.agentPatternDays),
        },
      };
    case 'email':
      return { opsAgent: { emailEnabled: f.agentEmailEnabled, recipients: f.agentRecipients } };
    default:
      return {};
  }
}

const SAVED_TITLES = {
  provider: 'AI provider saved', context: 'Estate context saved', status: 'Service Status AI saved',
  agent: 'Agent settings saved', email: 'Agent email saved',
};

function SourceBadge({ source }) {
  if (source === 'settings') return <Badge tone="ok">Stored encrypted</Badge>;
  if (source === 'env') return <Badge tone="warn">From .env (plain text)</Badge>;
  return <Badge tone="crit">Not set</Badge>;
}

function TabPanel({ title, intro, children }) {
  return (
    <div className="panel p-4">
      <p className="text-sm font-bold text-ink">{title}</p>
      {intro && <p className="text-[11px] text-ink-muted mt-0.5 leading-relaxed">{intro}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

const btnSecondary = 'flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 border border-cohesity-border text-ink-muted rounded-lg hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer';

export default function IntelligenceSettingsPage({ defaultTab = 'provider' }) {
  const [params, setParams] = useSearchParams();
  const { hasPermission, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const [form, setForm] = useState(DEFAULT_FORM);
  const [saved, setSaved] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(true);
  const [savingTab, setSavingTab] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(null); // null until known
  const [credSources, setCredSources] = useState({});
  const [credInputs, setCredInputs] = useState({});
  const [savingCreds, setSavingCreds] = useState(false);
  const [modelList, setModelList] = useState(null); // { provider, models, default } | null
  const [modelsError, setModelsError] = useState(null);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTest, setLlmTest] = useState(null);
  const [testingAgent, setTestingAgent] = useState(false);

  const visibleTabs = INTEL_TABS.filter(t =>
    (!t.requiresAi || aiEnabled !== false) && (!t.permission || authLoading || hasPermission(t.permission)));
  const requested = params.get('tab') || defaultTab;
  const tab = visibleTabs.some(t => t.key === requested) ? requested : 'provider';
  const selectTab = (key) => setParams({ tab: key }, { replace: true });

  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v && v.target ? v.target.value : v }));
  const isDirty = (k) => String(form[k]) !== String(saved[k]);
  const tabDirty = (t) => (t === 'keys'
    ? AI_TOKEN_FIELDS.some(fl => (credInputs[fl.name] || '').trim())
    : (TAB_FIELDS[t] || []).some(isDirty));
  const providerUnsaved = isDirty('llmProvider') || form.llmCustomEndpoint.trim() !== saved.llmCustomEndpoint;

  /** Reload the picker from the active provider; a picked model the new
   *  provider does not list is cleared (and the cleared value saved). */
  const refreshModels = async (currentModel) => {
    setModelList(null);
    setModelsError(null);
    try {
      const { data } = await client.get('/settings/llm-models');
      setModelList(data);
      const stale = currentModel && Array.isArray(data.models) && data.models.length > 0 && !data.models.includes(currentModel);
      if (stale) {
        setForm(f => ({ ...f, llmModel: '' }));
        setSaved(s => ({ ...s, llmModel: '' }));
        await client.put('/settings', { llmModel: '' }).catch(() => {});
      }
      return true;
    } catch (err) {
      setModelsError(err?.response?.data?.error || 'Could not load the model list from the AI provider.');
      return false;
    }
  };

  useEffect(() => {
    let model = '';
    Promise.allSettled([
      client.get('/settings'),
      client.get('/cohesity/insights/ai/config'),
      client.get('/settings/credentials'),
    ]).then(([s, c, cr]) => {
      if (s.status === 'fulfilled') {
        const next = formFromSettings(s.value.data || {});
        model = next.llmModel;
        setForm(next);
        setSaved(next);
      }
      setAiEnabled(c.status === 'fulfilled' ? !!c.value.data?.enabled : false);
      if (cr.status === 'fulfilled') setCredSources(cr.value.data || {});
    }).finally(() => {
      setLoading(false);
      refreshModels(model);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveTab = async (t) => {
    setSavingTab(t);
    try {
      await client.put('/settings', payloadFor(t, form));
      setSaved(s => {
        const next = { ...s };
        for (const k of TAB_FIELDS[t]) next[k] = form[k];
        if (t === 'provider') next.llmCustomEndpoint = form.llmCustomEndpoint.trim();
        return next;
      });
      if (t === 'provider') {
        // The server drops a stored endpoint key when the URL changes.
        const { data } = await client.get('/settings/credentials').catch(() => ({ data: null }));
        if (data) setCredSources(data);
        setLlmTest(null);
        window.dispatchEvent(new Event('ai-status-changed'));
        if (await refreshModels(form.llmModel)) setAiEnabled(true);
      }
      toast({ type: 'success', title: SAVED_TITLES[t], message: 'Applied immediately, no restart needed.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save settings. Try again.' });
    } finally {
      setSavingTab(null);
    }
  };

  const saveKeys = async () => {
    setSavingCreds(true);
    try {
      const payload = {};
      for (const fl of AI_TOKEN_FIELDS) {
        const v = (credInputs[fl.name] || '').trim();
        if (v) payload[fl.name] = v;
      }
      const { data } = await client.put('/settings/credentials', payload);
      setCredSources(data);
      setCredInputs({});
      window.dispatchEvent(new Event('ai-status-changed'));
      if (await refreshModels(form.llmModel)) setAiEnabled(true);
      toast({ type: 'success', title: 'Keys saved', message: 'Stored encrypted and applied immediately.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save the keys. Try again.' });
    } finally {
      setSavingCreds(false);
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

  const testLlm = async () => {
    setTestingLlm(true);
    setLlmTest(null);
    try {
      const { data } = await client.post('/settings/llm-test', {
        endpoint: form.llmCustomEndpoint.trim(),
        apiToken: (credInputs.customEndpointToken || '').trim(),
        model: form.llmModel,
      });
      setLlmTest(data);
    } catch (e) {
      setLlmTest({ error: e?.response?.data?.error || 'Test failed.' });
    } finally {
      setTestingLlm(false);
    }
  };

  const sendAgentTest = async () => {
    setTestingAgent(true);
    try {
      const { data } = await client.post('/ops-agent/test-email');
      toast({ type: 'success', title: 'Sample incident email sent', message: `Sent to ${data.to}.` });
    } catch (e) {
      toast({ type: 'error', title: 'Send failed', message: e?.response?.data?.error || 'Could not send the sample email.' });
    } finally {
      setTestingAgent(false);
    }
  };

  const saveBar = (t, label, extra) => (
    <TabSaveBar onSave={() => saveTab(t)} saving={savingTab === t} dirty={tabDirty(t)} label={label}>{extra}</TabSaveBar>
  );
  const loadingNote = <p className="text-gray-400 text-sm">Loading...</p>;

  const renderTab = () => {
    if (tab === 'capabilities') return <AgentCapabilitiesPanel />;
    if (tab === 'privacy') {
      return (
        <PrivacyInspectorPage platform="ops-agent" embedded title="Operations Agent privacy"
          emptyText="No Operations Agent AI requests in the last 30 days. Incidents triaged without an AI provider use the rule-based digest and send nothing to a model." />
      );
    }

    if (tab === 'provider') {
      return (
        <TabPanel title="AI provider" intro="Which service answers every AI analysis, and the model it uses. Keys are on the Keys tab.">
          {aiEnabled === false && (
            <p className="mb-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
              AI analysis is not configured. Pick a provider and add its key on the Keys tab, or point ICC at a custom
              OpenAI-compatible endpoint. The Operations Agent tabs appear once a provider is configured.
            </p>
          )}
          {loading ? loadingNote : (
            <>
              <SettingRow label="Provider" htmlFor="llm-provider" dirty={isDirty('llmProvider')}
                tip="Which service answers every AI analysis (cluster reviews, Ask AI, advisors, Service Status). Keys for the other providers stay stored, so switching back is one save.">
                <select id="llm-provider" value={form.llmProvider} onChange={set('llmProvider')} className={selectCls}>
                  {LLM_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </SettingRow>
              {form.llmProvider === 'custom' && (
                <SettingRow label="Endpoint URL" htmlFor="llm-custom-endpoint" dirty={isDirty('llmCustomEndpoint')}
                  tip={<>Any OpenAI-compatible server (a Copilot bridge, a local model server). Paste the chat completions URL or
                    the API base; ICC keeps the base and calls <code>/models</code> and <code>/chat/completions</code> under it.
                    Changing the URL drops the stored key, so type the key again with a new address.</>}>
                  <input id="llm-custom-endpoint" type="text" autoComplete="off" value={form.llmCustomEndpoint}
                    onChange={set('llmCustomEndpoint')} placeholder="http://127.0.0.1:8787/v1/chat/completions"
                    className={`${inputCls} font-mono`} />
                </SettingRow>
              )}
              <SettingRow label="Default AI model" htmlFor="llm-model" dirty={isDirty('llmModel')}
                tip="Model used for all AI analyses. Applies to the next run, no restart.">
                {modelList ? (
                  <>
                    <select id="llm-model" value={form.llmModel} onChange={set('llmModel')} className={selectCls}>
                      <option value="">Provider default ({modelList.default})</option>
                      {(modelList.models || []).map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    {modelList.provider && <p className="text-[10px] text-ink-faint mt-1">Listed by {modelList.provider}</p>}
                  </>
                ) : modelsError ? (
                  <>
                    <p className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5 mb-1.5">{modelsError}</p>
                    <input id="llm-model" type="text" value={form.llmModel} onChange={set('llmModel')}
                      placeholder="Type a model id" className={`${inputCls} font-mono`} />
                  </>
                ) : (
                  <p className="text-[11px] text-ink-faint md:pt-2">Loading models...</p>
                )}
              </SettingRow>
              {form.llmProvider === 'custom' && (
                <SettingRow label="Test endpoint"
                  tip="Checks the endpoint is alive, lists its models and sends a one-word chat. A blank key uses the stored key only for the saved URL. A key typed on the Keys tab is used for the test before it is saved.">
                  <button onClick={testLlm} disabled={testingLlm || !form.llmCustomEndpoint.trim()} className={btnSecondary}>
                    <Sparkles size={13} /> {testingLlm ? 'Testing...' : 'Test endpoint'}
                  </button>
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
                </SettingRow>
              )}
              {saveBar('provider', 'Save AI provider')}
            </>
          )}
        </TabPanel>
      );
    }

    if (tab === 'keys') {
      return (
        <TabPanel title="Keys"
          intro={<>Keys are stored AES-256-GCM encrypted in the local database, never displayed again, and applied immediately.
            A stored key overrides <code>.env</code>; once it shows "Stored encrypted" you can remove the token from <code>.env</code>.</>}>
          {providerUnsaved && (
            <p className="mb-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
              The AI provider tab has unsaved changes. Save it first: changing the endpoint URL drops the stored key.
            </p>
          )}
          {loading ? loadingNote : (
            <>
              {AI_TOKEN_FIELDS.map(fl => {
                const used = fl.providers.includes(saved.llmProvider);
                return (
                  <SettingRow key={fl.name} label={fl.label} htmlFor={`cred-${fl.name}`} tip={fl.hint}
                    dirty={!!(credInputs[fl.name] || '').trim()}>
                    <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                      <SourceBadge source={credSources[fl.name] || 'none'} />
                      {!used && <span className="text-[10px] text-ink-faint">Not used by the selected provider</span>}
                      {credSources[fl.name] === 'settings' && (
                        <button onClick={() => clearCredential(fl.name)} disabled={savingCreds}
                          className="text-[10px] text-ink-faint hover:text-status-crit underline underline-offset-2 transition-colors disabled:opacity-50 cursor-pointer">
                          Clear stored value
                        </button>
                      )}
                    </div>
                    <input id={`cred-${fl.name}`} type="password" autoComplete="off" value={credInputs[fl.name] || ''}
                      onChange={e => setCredInputs(s => ({ ...s, [fl.name]: e.target.value }))}
                      placeholder={credSources[fl.name] === 'settings' ? 'Stored, enter a new value to replace' : 'Paste token to store encrypted'}
                      className={`${inputCls} font-mono`} />
                  </SettingRow>
                );
              })}
              <TabSaveBar onSave={saveKeys} saving={savingCreds} dirty={tabDirty('keys') && !providerUnsaved} label="Save keys" />
            </>
          )}
        </TabPanel>
      );
    }

    if (tab === 'context') {
      return (
        <TabPanel title="Estate context"
          intro="Controls the on-demand AI analyses: the cluster-card System Analysis, the Intelligent Insights Ask AI (alerts), and the AI Advisor reports.">
          {loading ? loadingNote : (
            <>
              <SettingRow label="Operator context" htmlFor="estate-context" dirty={isDirty('llmEstateContext')}
                tip="What's normal for your estate. Injected into every AI analysis as authoritative context, so the model doesn't flag normal patterns. Applies immediately to the next run, no restart. Example: explain that objects unprotected on one cluster are protected on another, or describe what tagged target/archive clusters do.">
                <textarea id="estate-context" value={form.llmEstateContext} onChange={set('llmEstateContext')} rows={6} maxLength={4000}
                  placeholder='e.g. Objects shown as unprotected on a cluster are typically protected on another Cohesity cluster, which is normal and not a risk. Clusters tagged "target" or "archive" are replication/archive destinations where thousands of unprotected sources are expected.'
                  className={`${inputCls} resize-y`} />
                <p className="text-[10px] text-ink-faint mt-1 text-right tnum">{form.llmEstateContext.length}/4000</p>
              </SettingRow>
              <SettingRow label="Include protection coverage in System Analysis" htmlFor="flag-unprotected" dirty={isDirty('llmFlagUnprotected')}
                tip="Off by default. When off, the System Analysis ignores unprotected objects entirely and focuses on what the cluster is actively doing (capacity, backup jobs, replication). Turn on only if you want the AI to assess coverage gaps.">
                <Toggle id="flag-unprotected" checked={form.llmFlagUnprotected} onChange={set('llmFlagUnprotected')} />
              </SettingRow>
              <SettingRow label="Analysis freshness window (hours)" htmlFor="ttl-hours" dirty={isDirty('llmAnalysisTtlHours')}
                tip="Cached AI analyses older than this are flagged stale and the UI prompts a re-run. 1 to 720 hours.">
                <input id="ttl-hours" type="number" min="1" max="720" step="1" value={form.llmAnalysisTtlHours} onChange={set('llmAnalysisTtlHours')} className={numberCls} />
              </SettingRow>
              <SettingRow label="App Services acceptable backup age (hours)" htmlFor="app-service-backup-hours" dirty={isDirty('appServiceBackupStaleHours')}
                tip="On the App Services page a protected server shows Degraded when its newest Cohesity backup is older than this. Raise it to 48 or 96 for servers backed up less often than daily. No other page uses this value.">
                <input id="app-service-backup-hours" type="number" min="1" max="720" step="1" value={form.appServiceBackupStaleHours} onChange={set('appServiceBackupStaleHours')} className={numberCls} />
              </SettingRow>
              {saveBar('context', 'Save estate context')}
            </>
          )}
        </TabPanel>
      );
    }

    if (tab === 'status') {
      return (
        <TabPanel title="Service Status AI"
          intro="Each critical alert on the Service Status page gets one AI analysis. The cap limits how many run per minute; the rest wait in a queue.">
          {loading ? loadingNote : (
            <>
              <SettingRow label="Analyze critical alerts automatically" htmlFor="service-status-ai" dirty={isDirty('serviceStatusAiEnabled')}
                tip="Off leaves analysis on request only: the Analyze button on an alert still works.">
                <Toggle id="service-status-ai" checked={form.serviceStatusAiEnabled} onChange={set('serviceStatusAiEnabled')} />
              </SettingRow>
              <SettingRow label="AI analyses per minute" htmlFor="service-status-rate" dirty={isDirty('serviceStatusAnalysesPerMinute')}
                tip="The cap on automatic analyses per minute; the rest wait in a queue. 1 to 30.">
                <input id="service-status-rate" type="number" min="1" max="30" step="1" value={form.serviceStatusAnalysesPerMinute} onChange={set('serviceStatusAnalysesPerMinute')} className={numberCls} />
              </SettingRow>
              <SettingRow label="Reuse an identical analysis within (minutes)" htmlFor="service-status-dedupe" dirty={isDirty('serviceStatusDedupeMinutes')}
                tip="An alert that matches one analyzed inside this window reuses that analysis instead of a new model call. 0 to 1440.">
                <input id="service-status-dedupe" type="number" min="0" max="1440" step="1" value={form.serviceStatusDedupeMinutes} onChange={set('serviceStatusDedupeMinutes')} className={numberCls} />
              </SettingRow>
              {saveBar('status', 'Save Service Status AI')}
            </>
          )}
        </TabPanel>
      );
    }

    if (tab === 'agent') {
      return (
        <TabPanel title="Operations Agent"
          intro="Runs every minute in the poller: folds open alerts into incidents by host (or platform-wide when a source is unreachable), holds a window for related alerts, triages each incident against the evidence ICC holds, and emails the analysis with next steps for the next level. Uses the configured AI provider; without one it still sends a rule-based digest. Incidents are listed under Ops > Ops Agent.">
          {loading ? loadingNote : (
            <>
              <SettingGroup title="General">
                <SettingRow label="Run the Operations Agent" htmlFor="agent-enabled" dirty={isDirty('agentEnabled')}
                  tip="Off by default. Run now on the agent page works either way for a one-off pass.">
                  <Toggle id="agent-enabled" checked={form.agentEnabled} onChange={set('agentEnabled')} />
                </SettingRow>
                <SettingRow label="Agent name" htmlFor="agent-name" dirty={isDirty('agentName')}
                  tip="Shown as the sender name on its emails (over the SMTP from address), in the signature, and on the agent page. Subjects carry the severity, host and title only.">
                  <input id="agent-name" type="text" maxLength={80} value={form.agentName} onChange={set('agentName')} placeholder="ICC Operations Agent" className={inputCls} />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Triage">
                <SettingRow label="Group alerts into incidents by" htmlFor="agent-grouping" dirty={isDirty('agentGrouping')}
                  tip="A fleet is not always troubleshot as one. Component keeps every cluster, array, appliance and server on its own incident, which means many more incidents and more triage calls, so raise the hourly cap to match. Incidents already open keep the grouping they were created with.">
                  <select id="agent-grouping" value={form.agentGrouping} onChange={set('agentGrouping')} className={selectCls}>
                    <option value="platform">Platform: one incident per host, and one per platform when its source is down or bursting (default)</option>
                    <option value="service">App service: alerts on a watched app's servers roll into that app's incident, the rest by host</option>
                    <option value="component">Component: one incident per server, cluster, array or appliance, nothing folded</option>
                  </select>
                </SettingRow>
                <SettingRow label="Minimum severity" htmlFor="agent-min-sev" dirty={isDirty('agentMinSeverity')}
                  tip="Alerts below this never enter an incident.">
                  <select id="agent-min-sev" value={form.agentMinSeverity} onChange={set('agentMinSeverity')} className={`${selectCls} max-w-xs`}>
                    <option value="info">Info and above</option>
                    <option value="warning">Warning and above</option>
                    <option value="error">Error and above</option>
                    <option value="critical">Critical only</option>
                  </select>
                </SettingRow>
                <SettingRow label="Hold window (minutes)" htmlFor="agent-hold" dirty={isDirty('agentHoldMinutes')}
                  tip="How long a new incident collects related alerts before triage. 0 to 120.">
                  <input id="agent-hold" type="number" min={0} max={120} value={form.agentHoldMinutes} onChange={set('agentHoldMinutes')} className={numberCls} />
                </SettingRow>
                <SettingRow label="Triages per hour" htmlFor="agent-cap" dirty={isDirty('agentAnalysesPerHour')}
                  tip="Cap on AI analyses; incidents past the cap wait for the next hour. 1 to 200.">
                  <input id="agent-cap" type="number" min={1} max={200} value={form.agentAnalysesPerHour} onChange={set('agentAnalysesPerHour')} className={numberCls} />
                </SettingRow>
                <SettingRow label="Re-notify after growth (minutes)" htmlFor="agent-renotify" dirty={isDirty('agentRenotifyMinutes')}
                  tip="An emailed incident that gains alerts is triaged again and emailed once this many minutes have passed. 0 never re-emails.">
                  <input id="agent-renotify" type="number" min={0} max={1440} value={form.agentRenotifyMinutes} onChange={set('agentRenotifyMinutes')} className={numberCls} />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Resolution">
                <SettingRow label="Resolve after quiet for (minutes)" htmlFor="agent-autoresolve" dirty={isDirty('agentAutoResolveMinutes')}
                  tip="Once every alert in an incident has cleared, the agent waits this long before closing it, so a flapping condition does not close and reopen. 0 closes as soon as the alerts clear. 0 to 1440.">
                  <input id="agent-autoresolve" type="number" min={0} max={1440} value={form.agentAutoResolveMinutes} onChange={set('agentAutoResolveMinutes')} className={numberCls} />
                </SettingRow>
                <SettingRow label="Also close what the evidence shows is fixed" htmlFor="agent-evidence" dirty={isDirty('agentEvidenceResolve')}
                  tip="For an incident whose platform alert is still open while ICC's own evidence says the system is healthy, the agent asks once an hour whether it is fixed and closes it with the reason. Hardware faults and anything the evidence does not cover stay open.">
                  <Toggle id="agent-evidence" checked={form.agentEvidenceResolve} onChange={set('agentEvidenceResolve')} />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Repeats">
                <SettingRow label="Call it a repeat after (occurrences)" htmlFor="agent-pattern-min" dirty={isDirty('agentPatternMin')}
                  tip="A condition that opens, clears itself and opens again is invisible one incident at a time. Once the same incident key has come back this many times inside the window, the agent classes it recurring, says a person is required, and puts every earlier occurrence and how it was resolved in the email. 2 to 20.">
                  <input id="agent-pattern-min" type="number" min={2} max={20} value={form.agentPatternMin} onChange={set('agentPatternMin')} className={numberCls} />
                </SettingRow>
                <SettingRow label="Repeat window (days)" htmlFor="agent-pattern-days" dirty={isDirty('agentPatternDays')}
                  tip="How far back the agent counts occurrences of the same incident key. 1 to 90.">
                  <input id="agent-pattern-days" type="number" min={1} max={90} value={form.agentPatternDays} onChange={set('agentPatternDays')} className={numberCls} />
                </SettingRow>
              </SettingGroup>
              {saveBar('agent', 'Save agent settings')}
            </>
          )}
        </TabPanel>
      );
    }

    if (tab === 'email') {
      return (
        <TabPanel title="Agent email" intro="Where the Operations Agent sends its incident analyses.">
          {loading ? loadingNote : (
            <>
              <SettingRow label="Email the analysis" htmlFor="agent-email" dirty={isDirty('agentEmailEnabled')}
                tip="Uses the SMTP server under Alert Notifications. Off keeps triage on the page only.">
                <Toggle id="agent-email" checked={form.agentEmailEnabled} onChange={set('agentEmailEnabled')} />
              </SettingRow>
              <SettingRow label="Recipients" htmlFor="agent-recipients" dirty={isDirty('agentRecipients')}
                tip="Blank sends each incident to the union of its platforms' Alert Notifications recipients (falling back to the default list). Set an address list here to send every incident to one place instead.">
                <input id="agent-recipients" type="text" value={form.agentRecipients} onChange={set('agentRecipients')}
                  placeholder="ops@example.com, l2-storage@example.com" className={`${inputCls} font-mono`} />
              </SettingRow>
              {saveBar('email', 'Save agent email', (
                <>
                  <button onClick={sendAgentTest} disabled={testingAgent} className={btnSecondary}>
                    <Mail size={13} /> {testingAgent ? 'Sending...' : 'Send sample incident email'}
                  </button>
                  <span className="text-[11px] text-ink-faint">The sample shows the exact layout an incident email uses. Every model call the agent makes is logged on the Privacy tab.</span>
                </>
              ))}
            </>
          )}
        </TabPanel>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Intelligence settings" className="flex items-end gap-1 overflow-x-auto border-b border-cohesity-border">
        {visibleTabs.map(t => {
          const Icon = t.icon;
          const active = t.key === tab;
          return (
            <button key={t.key} role="tab" aria-selected={active} onClick={() => selectTab(t.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 -mb-px text-xs font-medium border-b-2 transition-colors cursor-pointer ${
                active ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
              style={{ borderTop: 'none', borderLeft: 'none', borderRight: 'none', background: 'none' }}>
              <Icon size={13} className={active ? 'text-brand' : 'text-ink-faint'} />
              {t.label}
              {tabDirty(t.key) && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="flex flex-col gap-4">{renderTab()}</div>
    </div>
  );
}
