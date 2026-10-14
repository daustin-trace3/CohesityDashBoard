import { useEffect, useState, useCallback, useMemo } from 'react';
import { LineChart } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtShortTime, chartOpts } from './helpers';
import { chipBtn } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const RANGES = ['24h', '7d', '30d'];

function ChartPanel({ title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><LineChart size={15} className="text-brand" /> {title}</p>
      <div className="h-56">{children}</div>
    </div>
  );
}

const line = (label, data, color, fill = false) => ({
  label, data, borderColor: color, backgroundColor: fill ? `${color}26` : undefined,
  pointRadius: 0, borderWidth: 2, tension: 0.25, fill,
});

export default function LmTrendsPage() {
  const { toast } = useToast();
  const [range, setRange] = useState('7d');
  const [points, setPoints] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/trends', { params: { range } })
    .then(({ data }) => { setPoints(Array.isArray(data?.points) ? data.points : []); setLastRefreshed(new Date()); })
    .catch(() => { setPoints([]); toast({ type: 'error', title: 'Failed to load trends' }); }), [range, toast]);

  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => points || [], [points]);
  const labels = useMemo(() => list.map((p) => fmtShortTime(p.at)), [list]);
  const col = (k) => list.map((p) => p[k]);

  const devices = { labels, datasets: [line('Normal', col('devicesNormal'), '#3FB950', true), line('Dead', col('devicesDead'), '#C75D5D'), line('Dead collector', col('devicesDeadCollector'), '#D4A24E')] };
  const ifaces = { labels, datasets: [line('Up', col('interfacesUp'), BRAND, true), line('Down', col('interfacesDown'), '#C75D5D')] };
  const alerts = { labels, datasets: [line('Critical', col('alertsCritical'), '#C75D5D', true), line('Warning', col('alertsWarning'), '#D4A24E'), line('Info', col('alertsInfo'), '#4C9BE8')] };
  const health = { labels, datasets: [line('Collectors down', col('collectorsDown'), '#C75D5D'), line('Checks down', col('checksDown'), '#E8794C'), line('Checks degraded', col('checksDegraded'), '#D4A24E')] };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={LineChart} title="Trends" description="LogicMonitor estate history from ICC's metrics snapshots">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 mb-4">
        {RANGES.map((r) => <button key={r} onClick={() => setRange(r)} className={chipBtn(range === r)}>{r}</button>)}
      </div>

      {points == null ? <LoadingPanel label="Loading trends..." height={240} /> : list.length < 2 ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">Not enough history yet. Each poll adds one snapshot.</div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <ChartPanel title="Devices by Status"><Line data={devices} options={chartOpts} /></ChartPanel>
          <ChartPanel title="Interfaces"><Line data={ifaces} options={chartOpts} /></ChartPanel>
          <ChartPanel title="Open Alerts by Severity"><Line data={alerts} options={chartOpts} /></ChartPanel>
          <ChartPanel title="Collectors and Checks"><Line data={health} options={chartOpts} /></ChartPanel>
        </div>
      )}
    </div>
  );
}
