// Ported from frontend/src/pages/aws/AwsBedrockPage.jsx — react-chartjs-2
// <Line> replaced with charts.jsx LineChart (window.Chart).
import { BrainCircuit } from '../icons.jsx';
import {
  apiFetch, PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, BRAND, fmtNum,
} from '../ui.jsx';
import { LineChart } from '../charts.jsx';

const MODEL_COLORS = ['#FF9900', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8'];

export default function AwsBedrockPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aws/bedrock')
    .then((json) => { setData(json); setLastRefreshed(new Date()); setError(null); })
    .catch(() => { setData({ models: [], totals: {} }); setError('Failed to load Bedrock data'); }), []);

  React.useEffect(() => { load(); }, [load]);

  const models = data?.models || [];
  const totals = data?.totals || {};

  const invocationsTrend = React.useMemo(() => {
    const days = [...new Set(models.map((m) => m.day))].sort();
    const modelIds = [...new Set(models.map((m) => m.modelId))].sort();
    return {
      labels: days,
      datasets: modelIds.map((id, i) => ({
        label: id,
        data: days.map((d) => models.find((m) => m.modelId === id && m.day === d)?.invocations ?? null),
        borderColor: MODEL_COLORS[i % MODEL_COLORS.length],
        backgroundColor: MODEL_COLORS[i % MODEL_COLORS.length],
        borderWidth: 2, pointRadius: days.length > 45 ? 0 : 2, tension: 0.25, spanGaps: true,
      })),
    };
  }, [models]);

  const summary = React.useMemo(() => {
    const byModel = new Map();
    for (const m of models) {
      const cur = byModel.get(m.modelId) || { modelId: m.modelId, invocations: 0, inputTokens: 0, outputTokens: 0, latencySum: 0, latencyCount: 0 };
      cur.invocations += m.invocations || 0;
      cur.inputTokens += m.inputTokens || 0;
      cur.outputTokens += m.outputTokens || 0;
      if (m.avgLatencyMs != null) { cur.latencySum += m.avgLatencyMs; cur.latencyCount += 1; }
      byModel.set(m.modelId, cur);
    }
    return [...byModel.values()].map((m) => ({ ...m, avgLatencyMs: m.latencyCount ? m.latencySum / m.latencyCount : null }));
  }, [models]);

  const ctl = useTableControls(summary, {
    searchKeys: ['modelId'],
    defaultSortKey: 'invocations', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={BrainCircuit} title="Bedrock" description="Per-model daily invocations and token usage across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {error && <div className="panel p-3 mb-4 border border-status-crit/50"><p className="text-sm text-status-crit">{error}</p></div>}

      <div className="grid grid-cols-3 gap-3 mb-4">
        <StatCard icon={BrainCircuit} label="Invocations (30d)" value={fmtNum(totals.invocations30d)} tone="brand" />
        <StatCard icon={BrainCircuit} label="Input Tokens (30d)" value={fmtNum(totals.inputTokens30d)} />
        <StatCard icon={BrainCircuit} label="Output Tokens (30d)" value={fmtNum(totals.outputTokens30d)} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Daily Invocations by Model</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={220} />
        ) : invocationsTrend.labels.length === 0 ? (
          <div className="text-sm text-ink-muted py-8 text-center">No Bedrock usage data yet.</div>
        ) : (
          <div className="h-64"><LineChart data={invocationsTrend} height={256} /></div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">By Model (30d)</p>
        <TableControls ctl={ctl} rows={summary} searchPlaceholder="Filter by model…" filters={[]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={140} />
        ) : summary.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No Bedrock usage data yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="modelId" label="Model" ctl={ctl} />
                <SortTh k="invocations" label="Invocations" ctl={ctl} align="right" />
                <SortTh k="inputTokens" label="Input Tokens" ctl={ctl} align="right" />
                <SortTh k="outputTokens" label="Output Tokens" ctl={ctl} align="right" />
                <SortTh k="avgLatencyMs" label="Avg Latency" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((m) => (
                  <tr key={m.modelId} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{m.modelId}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(m.invocations)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(m.inputTokens)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(m.outputTokens)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{m.avgLatencyMs != null ? `${Math.round(m.avgLatencyMs)}ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
