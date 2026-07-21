import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, AlertOctagon, AlertTriangle, Info, CheckCircle2, RefreshCw,
  Lightbulb, ChevronDown, ChevronUp, ChevronRight, Database, WifiOff, Bell, ShieldAlert, ArrowLeftRight, Gauge, ClipboardCheck,
} from 'lucide-react';
import client from '../api/client';
import { Badge, Spinner } from './ui/primitives';
import ClusterAIModal from './ClusterAIModal';
import { useAiEnabled } from '../api/useAiEnabled';

const SEVERITY = {
  critical: { icon: AlertOctagon, color: 'text-status-crit', bg: 'bg-status-crit/10 border-status-crit/30', label: 'Critical' },
  warning: { icon: AlertTriangle, color: 'text-status-warn', bg: 'bg-status-warn/10 border-status-warn/30', label: 'Warning' },
  info: { icon: Info, color: 'text-status-info', bg: 'bg-status-info/10 border-status-info/30', label: 'Info' },
  ok: { icon: CheckCircle2, color: 'text-status-ok', bg: 'bg-status-ok/10 border-status-ok/30', label: 'Healthy' },
};

const CATEGORY_ICON = {
  capacity: Database,
  availability: WifiOff,
  alerts: Bell,
  protection: ShieldAlert,
  replication: ArrowLeftRight,
  efficiency: Gauge,
  governance: ClipboardCheck,
  health: CheckCircle2,
};

// Where clicking an insight takes the user. Alert insights deep-link to the
// Alerts page prefiltered to the affected cluster.
function insightRoute(insight) {
  switch (insight.category) {
    case 'alerts':
      return insight.clusterId != null ? `/alerts?clusterId=${insight.clusterId}` : '/alerts';
    case 'protection':
      return '/data-protection';
    case 'replication':
      return '/replication';
    case 'governance':
      return '/governance';
    case 'capacity':
    case 'availability':
    case 'efficiency':
      return '/clusters';
    default:
      return null;
  }
}

function InsightRow({ insight, onAskAi }) {
  const sev = SEVERITY[insight.severity] || SEVERITY.info;
  const SevIcon = sev.icon;
  const CatIcon = CATEGORY_ICON[insight.category] || Info;
  const navigate = useNavigate();
  const route = insightRoute(insight);
  return (
    <div
      onClick={route ? () => navigate(route) : undefined}
      role={route ? 'button' : undefined}
      tabIndex={route ? 0 : undefined}
      onKeyDown={route ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(route); } } : undefined}
      aria-label={route ? `${insight.title} — open details` : undefined}
      className={`group rounded-lg border px-3.5 py-3 flex gap-3 animate-fade-in text-left w-full ${sev.bg} ${
        route ? 'cursor-pointer transition-all duration-150 hover:brightness-125 hover:border-opacity-60' : ''
      }`}
    >
      <SevIcon size={17} className={`${sev.color} flex-shrink-0 mt-0.5`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[13px] font-semibold text-ink leading-snug">{insight.title}</p>
          <Badge tone="neutral" className="!py-0">
            <CatIcon size={10} />
            {insight.category}
          </Badge>
          {insight.clusterId != null && onAskAi && (
            <button
              onClick={(e) => { e.stopPropagation(); onAskAi(insight); }}
              aria-label={`Ask AI to analyze alerts on ${insight.clusterName}`}
              className="flex items-center gap-1 text-[11px] text-brand border border-brand/30 bg-brand/5 rounded-md px-1.5 py-0.5 hover:bg-brand/10 hover:border-brand/60 transition-colors cursor-pointer"
            >
              <Sparkles size={11} /> Ask AI
            </button>
          )}
        </div>
        {insight.detail && (
          <p className="text-xs text-ink-muted mt-1 leading-relaxed">{insight.detail}</p>
        )}
        {insight.recommendation && (
          <p className="text-xs mt-1.5 flex items-start gap-1.5 leading-relaxed">
            <Lightbulb size={13} className="text-brand flex-shrink-0 mt-px" />
            <span className="text-ink"><span className="font-semibold text-brand">Recommended:</span> {insight.recommendation}</span>
          </p>
        )}
      </div>
      {route && (
        <ChevronRight size={16} className="text-ink-faint group-hover:text-ink self-center flex-shrink-0 transition-colors" />
      )}
    </div>
  );
}

const COLLAPSED_COUNT = 4;

export default function InsightsPanel({ initialData = null }) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [aiCluster, setAiCluster] = useState(null);
  const aiEnabled = useAiEnabled();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await client.get('/insights');
      setData(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Adopt cached insights from the dashboard snapshot when they arrive, so the
  // panel renders instantly without its own round-trip.
  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setLoading(false);
    }
  }, [initialData]);

  // Only fetch on mount if the parent didn't already provide cached insights.
  useEffect(() => {
    if (!initialData) load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const insights = data?.insights || [];
  const visible = expanded ? insights : insights.slice(0, COLLAPSED_COUNT);
  const summary = data?.summary;

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Sparkles size={14} className="text-brand" />
          </div>
          <p className="text-sm font-bold text-ink">Intelligent Insights</p>
          {summary && (
            <div className="flex items-center gap-1.5 ml-1">
              {summary.critical > 0 && <Badge tone="crit" className="tnum">{summary.critical} critical</Badge>}
              {summary.warning > 0 && <Badge tone="warn" className="tnum">{summary.warning} warning</Badge>}
              {summary.info > 0 && <Badge tone="info" className="tnum">{summary.info} info</Badge>}
              {summary.critical === 0 && summary.warning === 0 && summary.info === 0 && (
                <Badge tone="ok">All clear</Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data?.generatedAt && (
            <span className="text-[10px] text-ink-faint">
              Updated {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            aria-label="Refresh insights"
            className="flex items-center justify-center h-7 w-7 rounded-lg border border-cohesity-border text-ink-muted hover:border-brand/50 hover:text-brand transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center gap-2.5 py-6 justify-center text-ink-muted text-xs" role="status">
          <Spinner size={16} /> Analyzing estate for risks and recommendations&hellip;
        </div>
      ) : error ? (
        <p className="text-xs text-ink-muted py-4 text-center">Could not load insights. <button onClick={load} className="text-brand hover:underline cursor-pointer">Retry</button></p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {visible.map((ins, i) => (
              <InsightRow
                key={`${ins.category}-${ins.clusterId ?? 'g'}-${i}`}
                insight={ins}
                onAskAi={aiEnabled ? (x) => setAiCluster({ id: x.clusterId, name: x.clusterName }) : undefined}
              />
            ))}
          </div>
          {insights.length > COLLAPSED_COUNT && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="mt-2.5 flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-bright transition-colors cursor-pointer"
            >
              {expanded ? <><ChevronUp size={14} /> Show fewer</> : <><ChevronDown size={14} /> Show all {insights.length} insights</>}
            </button>
          )}
        </>
      )}

      {aiCluster && (
        <ClusterAIModal cluster={aiCluster} mode="alerts" onClose={() => setAiCluster(null)} />
      )}
    </div>
  );
}
