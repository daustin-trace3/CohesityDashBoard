import { useEffect, useState, useCallback } from 'react';
import { Sparkles, RefreshCw, Lightbulb, AlertOctagon, X } from 'lucide-react';
import client from '../api/client';
import { Spinner, Badge } from './ui/primitives';

const CONFIDENCE_TONE = { high: 'ok', medium: 'warn', low: 'neutral' };

/**
 * Modal that requests and displays an AI-generated review of a single alert.
 * On open it POSTs to /alerts/:id/review (server returns cached result if the
 * alert is unchanged), and offers a Regenerate action (force refresh).
 */
export default function AlertReviewModal({ alert, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [review, setReview] = useState(null);

  const run = useCallback(async (force) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.post(
        `/alerts/${alert.id}/review${force ? '?force=1' : ''}`
      );
      setReview(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [alert.id]);

  useEffect(() => { run(false); }, [run]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative bg-cohesity-gray border border-cohesity-border rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cohesity-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={18} className="text-brand flex-shrink-0" />
            <div className="min-w-0">
              <h2 className="text-cohesity-text font-semibold">AI Alert Review</h2>
              <p className="text-xs text-gray-400 mt-0.5 truncate">
                {alert.cluster_name} · {alert.alert_type || 'Alert'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => run(true)}
              disabled={loading}
              aria-label="Regenerate review"
              className="text-xs px-2 py-1 border border-cohesity-border rounded text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Regenerate
            </button>
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-cohesity-text transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-5">
          <div className="mb-4 rounded-lg border border-cohesity-border bg-cohesity-black/40 px-3.5 py-2.5">
            <p className="text-xs text-gray-500 mb-1">Alert description</p>
            <p className="text-sm text-gray-300 leading-relaxed">{alert.description || '—'}</p>
          </div>

          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-6 justify-center">
              <Spinner size={16} />
              Generating review…
            </div>
          )}

          {error && !loading && (
            <div role="alert" className="bg-status-crit/10 border border-status-crit/30 text-status-crit rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          {!loading && !error && review && (
            <div className="space-y-4 animate-fade-in">
              <div className="flex items-center gap-2">
                {review.confidence && (
                  <Badge tone={CONFIDENCE_TONE[review.confidence] || 'neutral'}>
                    {review.confidence} confidence
                  </Badge>
                )}
                {review.model && (
                  <span className="text-[11px] text-gray-500">{review.model}</span>
                )}
              </div>

              {review.summary && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1">Summary</p>
                  <p className="text-sm text-cohesity-text leading-relaxed">{review.summary}</p>
                </div>
              )}

              {review.rootCause && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1 flex items-center gap-1.5">
                    <AlertOctagon size={13} className="text-status-warn" /> Likely root cause
                  </p>
                  <p className="text-sm text-gray-300 leading-relaxed">{review.rootCause}</p>
                </div>
              )}

              {review.actions?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1.5">
                    <Lightbulb size={13} className="text-brand" /> Recommended actions
                  </p>
                  <ol className="space-y-1.5">
                    {review.actions.map((a, i) => (
                      <li key={i} className="text-sm text-gray-300 leading-relaxed flex gap-2">
                        <span className="text-brand font-semibold flex-shrink-0">{i + 1}.</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <p className="text-[11px] text-gray-500 pt-1 border-t border-cohesity-border">
                AI-generated guidance — verify against your environment before acting.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
