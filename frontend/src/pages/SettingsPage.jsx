import { useEffect, useState } from 'react';
import { Sparkles, Save } from 'lucide-react';
import client from '../api/client';
import { useToast } from '../components/ui/Toaster';

export default function SettingsPage() {
  const [estateContext, setEstateContext] = useState('');
  const [flagUnprotected, setFlagUnprotected] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    Promise.allSettled([
      client.get('/settings'),
      client.get('/insights/ai/config'),
    ]).then(([s, c]) => {
      if (s.status === 'fulfilled') {
        setEstateContext(s.value.data.llmEstateContext || '');
        setFlagUnprotected(!!s.value.data.llmFlagUnprotected);
      }
      if (c.status === 'fulfilled') setAiEnabled(!!c.value.data.enabled);
    }).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await client.put('/settings', { llmEstateContext: estateContext, llmFlagUnprotected: flagUnprotected });
      toast({ type: 'success', title: 'Settings saved', message: 'Applies to the next AI analysis you run.' });
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
    </div>
  );
}
