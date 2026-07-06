import { useEffect, useState } from 'react';
import { Sparkles, Save, BadgeCheck, Layers } from 'lucide-react';
import client from '../api/client';
import { useToast } from '../components/ui/Toaster';

export default function SettingsPage() {
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/insights/ai/config'),
    ]).then(([s, c]) => {
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

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-lg font-bold text-ink">Settings</h1>
        <p className="text-xs text-ink-muted mt-0.5">Global configuration for the dashboard. Applies across the whole estate.</p>
      </div>

      {/* AI Analysis section */}
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

      {/* Platforms section */}
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

      {/* Licensing section */}
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
    </div>
  );
}
