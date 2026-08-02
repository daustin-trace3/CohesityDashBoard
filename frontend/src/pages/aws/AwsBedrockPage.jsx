import { useEffect, useState, useCallback, useMemo } from 'react';
import { BrainCircuit } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const MODEL_COLORS = ['#FF9900', '#0091DA', '#6CB33F', '#D4A24E', '#C75D5D', '#9B6CD4', '#4ED4B8'];

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 10, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

export default function AwsBedrockPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/aws/bedrock')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ models: [], totals: {} }); toast({ type: 'error', title: 'Failed to load Bedrock data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const models = data?.models || [];
  const totals = data?.totals || {};

  const invocationsTrend = useMemo(() => {
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

  const summary = useMemo(() => {
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
          <div className="h-64"><Line data={invocationsTrend} options={chartOpts} /></div>
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
