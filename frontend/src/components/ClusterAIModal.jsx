import { useEffect, useState, useCallback } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import client from '../api/client';
import Markdown from './Markdown';

export default function ClusterAIModal({ cluster, onClose, mode = 'system' }) {
  const [enabled, setEnabled] = useState(true);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const title = mode === 'alerts' ? 'Alert Analysis' : 'System Analysis';
  const scope = mode === 'alerts'
    ? "this cluster's active alerts"
    : "this cluster's capacity, sources, and backup-job health";

  useEffect(() => {
    client.get(`/insights/ai/${cluster.id}?mode=${mode}`)
      .then(({ data }) => {
        setEnabled(data.enabled);
        setAnalysis(data.analysis || null);
      })
      .catch(() => setError('Could not load saved analysis.'))
      .finally(() => setLoading(false));
  }, [cluster.id, mode]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const { data } = await client.post(`/insights/ai/${cluster.id}?mode=${mode}`);
      setAnalysis(data);
      setEnabled(true);
    } catch (e) {
      const status = e.response?.status;
      if (status === 503) {
        setEnabled(false);
        setError(e.response?.data?.error || 'AI analysis is not configured.');
      } else {
        setError(e.response?.data?.error || 'Analysis failed. Check the server logs and try again.');
      }
    } finally {
      setRunning(false);
    }
  }, [cluster.id, mode]);

  const fmtTime = (ts) => {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cohesity-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <Sparkles size={14} className="text-brand" />
            </div>
            <div>
              <h2 className="text-cohesity-text font-semibold">{title} — {cluster.name}</h2>
              {analysis?.generatedAt && (
                <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span>{analysis.model ? `${analysis.model} · ` : ''}Generated {fmtTime(analysis.generatedAt)}</span>
                  {analysis.stale && (
                    <span
                      title={`Older than ${analysis.ttlHours || 24}h — re-run for current data`}
                      className="text-amber-400 border border-amber-400/40 bg-amber-400/10 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide"
                    >
                      Stale
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-cohesity-text transition-colors text-xl leading-none ml-1">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {loading ? (
            <p className="text-gray-400 text-sm">Loading…</p>
          ) : !enabled ? (
            <div className="text-xs text-ink-muted leading-relaxed">
              <p className="mb-2">AI analysis is not configured on the server.</p>
              <p>Set <code className="text-brand">GITHUB_MODELS_TOKEN</code> (a GitHub Personal Access Token with the <em>Models</em> permission) in the backend environment and restart, then this button will analyze the cluster's alerts and health using GitHub Models.</p>
              {error && <p className="text-red-400 mt-2">{error}</p>}
            </div>
          ) : (
            <>
              {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
              {running ? (
                <div className="flex items-center gap-2.5 py-8 justify-center text-ink-muted text-xs" role="status">
                  <RefreshCw size={16} className="animate-spin" /> Analyzing {cluster.name} with AI…
                </div>
              ) : analysis?.analysis ? (
                <>
                  {analysis.stale && (
                    <p className="mb-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
                      This analysis is over {analysis.ttlHours || 24}h old and may not reflect current alerts. Re-run for an up-to-date review.
                    </p>
                  )}
                  <Markdown text={analysis.analysis} />
                </>
              ) : (
                <p className="text-ink-muted text-xs py-6 text-center">
                  No analysis yet. Run one to have the LLM review {scope}.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {enabled && !loading && (
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-cohesity-border flex-shrink-0">
            <button
              onClick={run}
              disabled={running}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Sparkles size={13} />
              {analysis?.analysis ? 'Re-run analysis' : 'Analyze with AI'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
