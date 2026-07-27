import { useEffect, useState, useCallback, useRef } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import client from '../api/client';
import Markdown from './Markdown';
import { LoadingPanel } from './ui/primitives';

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

export default function AdvisorReportModal({ tab, initialReport, enabled, autoRun = false, basePath = '/cohesity/advisor', onClose, onUpdated }) {
  const [report, setReport] = useState(initialReport || null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const Icon = tab.icon;

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const { data } = await client.post(`${basePath}/${tab.slug}`);
      setReport(data);
      onUpdated?.(data);
    } catch (e) {
      const status = e.response?.status;
      setError(e.response?.data?.error || (status === 503
        ? 'AI analysis is not configured.'
        : 'Report generation failed. Try again.'));
    } finally {
      setRunning(false);
    }
  }, [tab.slug, basePath, onUpdated]);

  // Kick off a fresh run immediately if opened via "Run new".
  const didAuto = useRef(false);
  useEffect(() => {
    if (autoRun && !didAuto.current) { didAuto.current = true; run(); }
  }, [autoRun, run]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-3xl max-h-[88vh] flex flex-col shadow-xl animate-fade-in">
        <div className="flex items-center justify-between px-6 py-4 border-b border-cohesity-border flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
              <Icon size={14} className="text-brand" />
            </div>
            <div>
              <h2 className="text-cohesity-text font-semibold">{tab.label}</h2>
              {report?.generatedAt && (
                <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span>{report.model ? `${report.model} · ` : ''}Generated {fmtTime(report.generatedAt)}</span>
                  {report.stale && (
                    <span title={`Older than ${report.ttlHours || 24}h — re-run for current data`}
                      className="text-amber-400 border border-amber-400/40 bg-amber-400/10 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide">
                      Stale
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-cohesity-text transition-colors text-xl leading-none ml-1">×</button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {!enabled ? (
            <p className="text-xs text-ink-muted leading-relaxed">
              AI analysis is not configured on the server. Set <code className="text-brand">OPENAI_TOKEN</code> (or
              <code className="text-brand"> GITHUB_MODELS_TOKEN</code>) and restart.
            </p>
          ) : running ? (
            <LoadingPanel label="Analyzing the estate…" height={180} />
          ) : report?.content ? (
            <>
              {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
              {report.stale && (
                <p className="mb-3 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-md px-2.5 py-1.5">
                  This report is over {report.ttlHours || 24}h old and may not reflect current data. Re-run for an up-to-date view.
                </p>
              )}
              <Markdown text={report.content} />
            </>
          ) : (
            <p className="text-ink-muted text-xs py-10 text-center">
              {error ? <span className="text-red-400">{error}</span> : 'No report yet. Run one to analyze the estate.'}
            </p>
          )}
        </div>

        {enabled && (
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-cohesity-border flex-shrink-0">
            <button
              onClick={run}
              disabled={running}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <Sparkles size={13} />
              {report?.content ? 'Re-run' : 'Generate report'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
