import { LineChart as LineChartIcon } from '../icons.jsx';
import { LineChart } from '../charts.jsx';
import client from '../api.js';
import { useToast, PageHeader, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtWhen } from '../ui.jsx';

const RANGES = [{ label: '24h', v: 24 }, { label: '7d', v: 168 }, { label: '30d', v: 720 }];

function ChartPanel({ title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><LineChartIcon size={15} className="text-brand" /> {title}</p>
      <div className="h-56">{children}</div>
    </div>
  );
}

export default function BrocadeTrendsPage() {
  const { toast } = useToast();
  const [sources, setSources] = React.useState([]);
  const [sourceId, setSourceId] = React.useState('');
  const [hours, setHours] = React.useState(168);
  const [metrics, setMetrics] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  React.useEffect(() => {
    client.get('/brocade/sources').then(({ data }) => setSources(data.sources || [])).catch(() => setSources([]));
  }, []);

  const load = React.useCallback(() => {
    const params = { hours };
    if (sourceId) params.sourceId = sourceId;
    return client.get('/brocade/trends', { params })
      .then(({ data }) => { setMetrics(data.metrics || []); setLastRefreshed(new Date()); })
      .catch(() => { setMetrics([]); toast({ type: 'error', title: 'Failed to load trends' }); });
  }, [hours, sourceId, toast]);

  React.useEffect(() => { load(); }, [load]);

  const list = metrics || [];
  const labels = React.useMemo(() => list.map((m) => fmtWhen(m.ts)), [list]);

  const switchStatusData = {
    labels,
    datasets: [
      { label: 'Healthy', data: list.map((m) => m.switchesHealthy), borderColor: '#3FB950', backgroundColor: 'rgba(63,185,80,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true },
      { label: 'Marginal', data: list.map((m) => m.switchesMarginal), borderColor: '#D4A24E', backgroundColor: 'rgba(212,162,78,0.1)', pointRadius: 0, borderWidth: 2, tension: 0.25 },
      { label: 'Critical', data: list.map((m) => m.switchesCritical), borderColor: '#C75D5D', backgroundColor: 'rgba(199,93,93,0.1)', pointRadius: 0, borderWidth: 2, tension: 0.25 },
    ],
  };

  const portsData = {
    labels,
    datasets: [{ label: 'Ports online', data: list.map((m) => m.portsOnline), borderColor: BRAND, backgroundColor: 'rgba(204,9,47,0.15)', pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true }],
  };

  const eventsData = {
    labels,
    datasets: [
      { label: 'Critical (24h)', data: list.map((m) => m.eventsCritical24h), borderColor: '#C75D5D', backgroundColor: 'rgba(199,93,93,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true },
      { label: 'Warning (24h)', data: list.map((m) => m.eventsWarning24h), borderColor: '#D4A24E', backgroundColor: 'rgba(212,162,78,0.1)', pointRadius: 0, borderWidth: 2, tension: 0.25 },
    ],
  };

  const zonesData = {
    labels,
    datasets: [{ label: 'Zones total', data: list.map((m) => m.zonesTotal), borderColor: '#8A63D2', backgroundColor: 'rgba(138,99,210,0.12)', pointRadius: 0, borderWidth: 2, tension: 0.25, fill: true }],
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={LineChartIcon} title="Trends" description="Historical Brocade SAN metrics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
          className="bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-sm text-ink focus:border-brand/60 outline-none cursor-pointer">
          <option value="">All sources</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button key={r.v} onClick={() => setHours(r.v)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${hours === r.v ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {metrics == null ? (
        <LoadingPanel label="Loading trends…" height={240} />
      ) : list.length < 2 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">Not enough history yet.</div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <ChartPanel title="Switch Status"><LineChart data={switchStatusData} height={224} /></ChartPanel>
          <ChartPanel title="Ports Online"><LineChart data={portsData} height={224} /></ChartPanel>
          <ChartPanel title="Events per Day"><LineChart data={eventsData} height={224} /></ChartPanel>
          <ChartPanel title="Zones Total"><LineChart data={zonesData} height={224} /></ChartPanel>
        </div>
      )}
    </div>
  );
}
