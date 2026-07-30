import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Sparkles, Save, Layers, KeyRound, Settings, Mail } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import AdminNav from '../components/AdminNav';
import { SWITCHER_MODES, getSwitcherMode } from '../components/PlatformSwitcher';

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
  { key: 'netbackup', label: 'Veritas NetBackup' },
];

// Global AI provider tokens. Platform-specific credentials (Helios, Pure1,
// AIQUM) live on their own platform settings pages.
const AI_TOKEN_FIELDS = [
  { name: 'openaiToken', label: 'OpenAI API token',
    hint: 'Preferred AI provider (pay-per-use). When set, all AI analyses use OpenAI.' },
  { name: 'githubModelsToken', label: 'GitHub Models token',
    hint: 'Fallback AI provider (free PAT, daily caps). Used only when no OpenAI token is configured.' },
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
  const [ttlHours, setTtlHours] = useState(24);
  const [modelList, setModelList] = useState(null);   // { provider, models, default } | null
  const [modelsError, setModelsError] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [cohesityEnabled, setCohesityEnabled] = useState(true);
  const [pureEnabled, setPureEnabled] = useState(false);
  const [netappEnabled, setNetappEnabled] = useState(false);
  const [zertoEnabled, setZertoEnabled] = useState(false);
  const [vcenterEnabled, setVcenterEnabled] = useState(false);
  const [dellEnabled, setDellEnabled] = useState(false);
  const [ariaEnabled, setAriaEnabled] = useState(false);
  const [netbackupEnabled, setNetbackupEnabled] = useState(false);
  const [switcherMode, setSwitcherModeState] = useState(getSwitcherMode);
  const [dnsServer, setDnsServer] = useState('');
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

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/cohesity/insights/ai/config'),
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
        setTtlHours(d.llmAnalysisTtlHours || 24);
        setCohesityEnabled(d.platformCohesityEnabled !== false);
        setPureEnabled(!!d.platformPureEnabled);
        setNetappEnabled(!!d.platformNetappEnabled);
        setZertoEnabled(!!d.platformZertoEnabled);
        setVcenterEnabled(!!d.platformVcenterEnabled);
        setDellEnabled(!!d.platformDellEnabled);
        setAriaEnabled(!!d.platformAriaEnabled);
        setNetbackupEnabled(!!d.platformNetbackupEnabled);
        setDnsServer(d.dnsServer || '');
      }
      if (c.status === 'fulfilled') setAiEnabled(!!c.value.data.enabled);
    }).finally(() => setLoading(false));

    client.get('/settings/llm-models')
      .then(({ data }) => setModelList(data))
      .catch((err) => setModelsError(err?.response?.data?.error || 'Could not load the model list from the AI provider.'));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', {
        llmEstateContext: estateContext,
        llmFlagUnprotected: flagUnprotected,
        llmModel,
        llmAnalysisTtlHours: Number(ttlHours) || 24,
        platformCohesityEnabled: cohesityEnabled,
        platformPureEnabled: pureEnabled,
        platformNetappEnabled: netappEnabled,
        platformZertoEnabled: zertoEnabled,
        platformVcenterEnabled: vcenterEnabled,
        platformDellEnabled: dellEnabled,
        platformAriaEnabled: ariaEnabled,
        platformNetbackupEnabled: netbackupEnabled,
        dnsServer,
      });
      window.dispatchEvent(new Event('platforms-changed'));
      toast({ type: 'success', title: 'Settings saved', message: 'Global settings updated.' });
    } catch (e) {
      toast({ type: 'error', title: 'Save failed', message: e?.response?.data?.error || 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
    }
  };

  const saveCredentials = async () => {
    const payload = {};
    for (const f of AI_TOKEN_FIELDS) {
      const v = (credInputs[f.name] || '').trim();
      if (v) payload[f.name] = v;
    }
    if (Object.keys(payload).length === 0) return;
    setSavingCreds(true);
    try {
      const { data } = await client.put('/settings/credentials', payload);
      setCredSources(data);
      // AI-gated surfaces (nav item, Ask AI buttons) re-check live.
      window.dispatchEvent(new Event('ai-status-changed'));
      setCredInputs({});
      setAiEnabled(true);
      toast({ type: 'success', title: 'AI keys saved', message: 'Stored encrypted. Applied immediately — no restart needed.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save AI keys. Try again.' });
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
            <p className="text-sm font-bold text-ink">AI Provider Keys</p>
            <p className="text-[11px] text-ink-muted">
              Stored <span className="text-ink">AES-256-GCM encrypted</span> in the local database, never displayed again,
              and applied immediately. A stored key overrides <code>.env</code>; once it shows "Stored encrypted" you can
              remove the token from <code>.env</code>.
            </p>
          </div>
        </div>

        {!aiEnabled && (
          <p className="mt-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
            AI analysis is not configured — add an OpenAI or GitHub Models token below to enable it.
          </p>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
            {AI_TOKEN_FIELDS.map(f => (
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
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={saveCredentials}
                disabled={savingCreds || !AI_TOKEN_FIELDS.some(f => (credInputs[f.name] || '').trim())}
                className="flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <Save size={13} /> {savingCreds ? 'Saving…' : 'Save AI keys'}
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
                  <p className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">{modelsError}</p>
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

      {/* Platforms */}
      {tab === 'platforms' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Layers size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Platforms</p>
            <p className="text-[11px] text-ink-muted">
              Vendor tabs shown at the top of the dashboard. Enable each platform once its integration is
              configured. At least one platform must stay enabled; with only one, the platform bar is hidden.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={cohesityEnabled} onChange={e => setCohesityEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Cohesity</span><br />
                Show the Cohesity platform tab. Disable only if this deployment monitors other platforms
                (e.g. Pure and NetApp) without Cohesity.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={pureEnabled} onChange={e => setPureEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Pure Storage</span><br />
                Show the Pure Storage platform tab. Leave off until the Pure integration is configured.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={netappEnabled} onChange={e => setNetappEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">NetApp</span><br />
                Show the NetApp platform tab. Leave off until the NetApp integration is configured.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={zertoEnabled} onChange={e => setZertoEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Zerto</span><br />
                Show the Zerto platform tab. Leave off until the Zerto Analytics credentials are configured.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={vcenterEnabled} onChange={e => setVcenterEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">VMware vCenter</span><br />
                Show the vCenter platform tab. Register vCenters on its Settings page after enabling.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={dellEnabled} onChange={e => setDellEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Dell OpenManage Enterprise</span><br />
                Show the Dell OME platform tab. Register OME appliances on its Settings page after enabling.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={ariaEnabled} onChange={e => setAriaEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">VMware Aria Automation</span><br />
                Show the Aria Automation platform tab. Register vRA instances on its Settings page after enabling.
              </span>
            </label>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={netbackupEnabled} onChange={e => setNetbackupEnabled(e.target.checked)}
                className="accent-brand mt-0.5 cursor-pointer" />
              <span className="text-xs text-ink-muted leading-relaxed">
                <span className="font-semibold text-ink">Veritas NetBackup</span><br />
                Show the NetBackup platform tab. Register primary servers on its Settings page after enabling.
              </span>
            </label>

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
                <label htmlFor="smtp-recipients" className="block text-xs font-semibold text-ink mb-1">Recipients</label>
                <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">Comma-separated email addresses</p>
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
            <label htmlFor="alert-min-severity" className="block text-xs font-semibold text-ink mb-1">Minimum severity</label>
            <p className="text-[11px] text-ink-muted mb-1.5 leading-relaxed">Alerts below this severity are not emailed</p>
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
            {NOTIFY_PLATFORMS.map(p => (
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
