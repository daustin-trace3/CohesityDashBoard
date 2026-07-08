import { useEffect, useState } from 'react';
import { Sparkles, Save, BadgeCheck, Layers, KeyRound } from 'lucide-react';
import client from '../api/client';
import { Badge } from '../components/ui/primitives';
import { useToast } from '../components/ui/Toaster';

const TABS = [
  { key: 'ai', label: 'AI Analysis', icon: Sparkles },
  { key: 'entitlement', label: 'Licensing', icon: BadgeCheck },
  { key: 'platforms', label: 'Platforms', icon: Layers },
  { key: 'license', label: 'Product License', icon: KeyRound },
];

export default function SettingsPage() {
  const [tab, setTab] = useState('ai');
  const [estateContext, setEstateContext] = useState('');
  const [flagUnprotected, setFlagUnprotected] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [dpTib, setDpTib] = useState('');
  const [replicaTib, setReplicaTib] = useState('');
  const [smartFilesTib, setSmartFilesTib] = useState('');
  const [licenseExpiry, setLicenseExpiry] = useState('');
  const [licenseEdition, setLicenseEdition] = useState('');
  const [pureEnabled, setPureEnabled] = useState(false);
  const [netappEnabled, setNetappEnabled] = useState(false);
  const [dnsServer, setDnsServer] = useState('');
  const [license, setLicense] = useState(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [activating, setActivating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/insights/ai/config'),
      client.get('/license/status'),
    ]).then(([s, c, l]) => {
      if (l.status === 'fulfilled') setLicense(l.value.data);
      if (s.status === 'fulfilled') {
        const d = s.value.data;
        setEstateContext(d.llmEstateContext || '');
        setFlagUnprotected(!!d.llmFlagUnprotected);
        const e = d.entitled || {};
        setDpTib(e.dataProtect ? String(e.dataProtect) : '');
        setReplicaTib(e.replica ? String(e.replica) : '');
        setSmartFilesTib(e.smartFiles ? String(e.smartFiles) : '');
        setLicenseExpiry(d.licenseExpiry || '');
        setLicenseEdition(d.licenseEdition || '');
        setPureEnabled(!!d.platformPureEnabled);
        setNetappEnabled(!!d.platformNetappEnabled);
        setDnsServer(d.dnsServer || '');
      }
      if (c.status === 'fulfilled') setAiEnabled(!!c.value.data.enabled);
    }).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', {
        llmEstateContext: estateContext,
        llmFlagUnprotected: flagUnprotected,
        licenseEntitledDataProtectTb: Number(dpTib) || 0,
        licenseEntitledReplicaTb: Number(replicaTib) || 0,
        licenseEntitledSmartFilesTb: Number(smartFilesTib) || 0,
        licenseExpiry,
        licenseEdition,
        platformPureEnabled: pureEnabled,
        platformNetappEnabled: netappEnabled,
        dnsServer,
      });
      // Tell the layout to re-read platform visibility without a full reload.
      window.dispatchEvent(new Event('platforms-changed'));
      toast({ type: 'success', title: 'Settings saved', message: 'AI context, licensing, and platform settings updated.' });
    } catch {
      toast({ type: 'error', title: 'Save failed', message: 'Could not save settings. Try again.' });
    } finally {
      setSaving(false);
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
      <div>
        <h1 className="text-lg font-bold text-ink">Settings</h1>
        <p className="text-xs text-ink-muted mt-0.5">Global configuration for the dashboard. Applies across the whole estate.</p>
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

      {/* AI Analysis section */}
      {tab === 'ai' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Sparkles size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">AI Analysis</p>
            <p className="text-[11px] text-ink-muted">
              Controls the on-demand AI analyses — both the cluster-card <span className="text-ink">System Analysis</span> and the
              Intelligent Insights <span className="text-ink">Ask AI</span> (alerts).
            </p>
          </div>
        </div>

        {!aiEnabled && (
          <p className="mt-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
            AI analysis is not configured on the server (no <code className="text-brand">GITHUB_MODELS_TOKEN</code>). These settings
            are saved but have no effect until a token is set.
          </p>
        )}

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
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
      )}

      {/* Product license section — status only, key is never displayed */}
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

      {/* Update license key — paste a new CDBL key (e.g. a multi-year renewal) */}
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

      {/* Platforms section */}
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

      {/* Licensing section */}
      {tab === 'entitlement' && (
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <BadgeCheck size={14} className="text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Licensing Entitlement</p>
            <p className="text-[11px] text-ink-muted">
              Your purchased capacity (decimal TB, as on the Cohesity license report) per license type. Consumed usage is
              pulled live from Helios; these are the baselines the <span className="text-ink">Licensing</span> page compares
              each type against.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm mt-4">Loading…</p>
        ) : (
          <div className="flex flex-col gap-5 mt-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="dp-tib" className="block text-xs font-semibold text-ink mb-1">DataProtect (TB)</label>
                <input id="dp-tib" type="number" min="0" step="1" value={dpTib} onChange={e => setDpTib(e.target.value)}
                  placeholder="e.g. 15000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">All backed-up workloads (VMs, DBs, physical, M365, NAS backups).</p>
              </div>
              <div>
                <label htmlFor="replica-tib" className="block text-xs font-semibold text-ink mb-1">Replica (TB)</label>
                <input id="replica-tib" type="number" min="0" step="1" value={replicaTib} onChange={e => setReplicaTib(e.target.value)}
                  placeholder="e.g. 5000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">Replicated data on Cohesity clusters.</p>
              </div>
              <div>
                <label htmlFor="sf-tib" className="block text-xs font-semibold text-ink mb-1">SmartFiles (TB)</label>
                <input id="sf-tib" type="number" min="0" step="1" value={smartFilesTib} onChange={e => setSmartFilesTib(e.target.value)}
                  placeholder="e.g. 8000"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
                <p className="text-[10px] text-ink-faint mt-1">Data in Cohesity Views / NAS shares.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="license-edition" className="block text-xs font-semibold text-ink mb-1">Edition <span className="text-ink-faint font-normal">(optional)</span></label>
                <input id="license-edition" type="text" value={licenseEdition} onChange={e => setLicenseEdition(e.target.value)}
                  placeholder="e.g. DataProtect Enterprise"
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
              </div>
              <div>
                <label htmlFor="license-expiry" className="block text-xs font-semibold text-ink mb-1">Expiry <span className="text-ink-faint font-normal">(optional)</span></label>
                <input id="license-expiry" type="date" value={licenseExpiry} onChange={e => setLicenseExpiry(e.target.value)}
                  className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none" />
              </div>
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
    </div>
  );
}
