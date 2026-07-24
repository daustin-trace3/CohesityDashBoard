import { useEffect, useState } from 'react';
import { Sparkles, Save, Layers, KeyRound, Settings, Users } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';
import { SWITCHER_MODES, getSwitcherMode } from '../components/PlatformSwitcher';
import AdminUsersPage from './AdminUsersPage';

const TABS = [
  { key: 'ai', label: 'AI Analysis & Keys', icon: Sparkles },
  { key: 'platforms', label: 'Platforms', icon: Layers },
  { key: 'license', label: 'Product License', icon: KeyRound },
  { key: 'access', label: 'Users & Access', icon: Users },
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
  const [tab, setTab] = useState('ai');
  const [estateContext, setEstateContext] = useState('');
  const [flagUnprotected, setFlagUnprotected] = useState(false);
  const [llmModel, setLlmModel] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [modelList, setModelList] = useState(null);   // { provider, models, default } | null
  const [modelsError, setModelsError] = useState(null);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [pureEnabled, setPureEnabled] = useState(false);
  const [netappEnabled, setNetappEnabled] = useState(false);
  const [zertoEnabled, setZertoEnabled] = useState(false);
  const [vcenterEnabled, setVcenterEnabled] = useState(false);
  const [dellEnabled, setDellEnabled] = useState(false);
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

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/insights/ai/config'),
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
        setPureEnabled(!!d.platformPureEnabled);
        setNetappEnabled(!!d.platformNetappEnabled);
        setZertoEnabled(!!d.platformZertoEnabled);
        setVcenterEnabled(!!d.platformVcenterEnabled);
        setDellEnabled(!!d.platformDellEnabled);
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
        platformPureEnabled: pureEnabled,
        platformNetappEnabled: netappEnabled,
        platformZertoEnabled: zertoEnabled,
        platformVcenterEnabled: vcenterEnabled,
        platformDellEnabled: dellEnabled,
        dnsServer,
      });
      window.dispatchEvent(new Event('platforms-changed'));
      toast({ type: 'success', title: 'Settings saved', message: 'Global settings updated.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save settings. Try again.' });
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
      setCredInputs({});
      setAiEnabled(true);
      window.dispatchEvent(new Event('ai-status-changed'));
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

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
          <Settings size={16} className="text-brand" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">Global Settings</h1>
          <p className="text-xs text-ink-muted mt-0.5">Estate-wide administration — AI, platforms, and product licensing. Platform-specific credentials live on each platform's own Settings page.</p>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 self-start">
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
              Vendor tabs shown at the top of the dashboard. Cohesity is always on; enable the others once their
              integrations are configured. With only Cohesity enabled, the platform bar is hidden.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 mt-4">
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
                Show the Dell platform tab. Register OME appliances on its Settings page after enabling.
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

      {tab === 'access' && <AdminUsersPage embedded />}
    </div>
  );
}
