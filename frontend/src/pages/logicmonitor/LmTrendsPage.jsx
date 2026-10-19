import { useEffect, useState, useCallback, useMemo } from 'react';
import { LineChart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtShortTime, chartOpts, arr, fmtNum, issueTypeLabel, PALETTE } from './helpers';
import { chipBtn, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

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

const stackedOpts = {
  ...chartOpts,
  scales: {
    x: { ...chartOpts.scales.x, stacked: true },
    y: { ...chartOpts.scales.y, stacked: true, beginAtZero: true, ticks: { ...chartOpts.scales.y.ticks, precision: 0 } },
  },
};

const bucketLabel = (b, hourly) => {
  const t = String(b || '');
  if (hourly) return t.length >= 13 ? `${t.slice(5, 10)} ${t.slice(11, 13)}:00` : t;
  return t.slice(5, 10) || t;
};

const EPISODE_COLORS = { 'one-off': '#3FB950', sustained: '#D4A24E', escalated: '#C75D5D', open: '#4C9BE8' };

const pctText = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Math.round(Number(v) * 10) / 10}%`);
const msText = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Math.round(Number(v) * 10) / 10} ms`);
const signed = (v, unit) => (v == null || !Number.isFinite(Number(v)) ? '-' : `${Number(v) > 0 ? '+' : ''}${Math.round(Number(v) * 10) / 10}${unit}`);

function MoverTable({ title, rows, cols, empty }) {
  return (
    <div className="panel p-3" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-2">{title}</p>
      {rows.length === 0 ? <p className="text-xs text-ink-muted py-3">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>{cols.map((c) => <th key={c.label} className={`py-1.5 pr-2 ${c.right ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-cohesity-border/40">
                  {cols.map((c) => <td key={c.label} className={`py-1.5 pr-2 text-[12px] ${c.right ? 'text-right tnum' : ''} ${c.cls ? c.cls(r) : 'text-ink-muted'}`}>{c.render(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const EMPTY_MOVE = 'Nothing rose by 5 points or more in this range.';
const lnk = (to, text) => <Link to={to} className="text-brand hover:underline">{text}</Link>;
const enc = encodeURIComponent;

function Movers({ movers }) {
  const m = movers || {};
  const ifaces = arr(m.interfaces).slice(0, 10);
  const checks = arr(m.checks).slice(0, 10);
  const devices = arr(m.devices).slice(0, 10);
  const errors = arr(m.errors).slice(0, 10);
  const circuits = arr(m.circuits).slice().sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0)).slice(0, 10);
  const ba = (r) => `${pctText(r.before)} > ${pctText(r.after)}`;
  return (
    <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-4 mb-6 items-start">
      <MoverTable title="Interfaces rising" rows={ifaces} empty={EMPTY_MOVE} cols={[
        { label: 'Device', render: (r) => lnk(`/logicmonitor/interfaces?q=${enc(r.deviceName || '')}`, r.deviceName || '-'), cls: () => '' },
        { label: 'Port', render: (r) => r.port || '-' },
        { label: 'Before > after', render: ba, right: true },
        { label: 'Delta', render: (r) => signed(r.delta, ' pts'), right: true, cls: () => 'text-status-warn' },
      ]} />
      <MoverTable title="Errors rising" rows={errors} empty="No interface error counts rose in this range." cols={[
        { label: 'Device', render: (r) => lnk(`/logicmonitor/interfaces?q=${enc(r.deviceName || '')}`, r.deviceName || '-'), cls: () => '' },
        { label: 'Port', render: (r) => r.port || '-' },
        { label: 'Before > after', render: (r) => `${fmtNum(Math.round(r.before ?? 0))} > ${fmtNum(Math.round(r.after ?? 0))}`, right: true },
        { label: 'Delta', render: (r) => signed(r.delta, ''), right: true, cls: () => 'text-status-warn' },
      ]} />
      <MoverTable title="Checks slower" rows={checks} empty="No check got slower by 5 ms and 20 percent in this range." cols={[
        { label: 'Check', render: (r) => lnk(`/logicmonitor/reachability?q=${enc(r.checkName || '')}`, r.checkName || '-'), cls: () => '' },
        { label: 'From', render: (r) => r.label || '-' },
        { label: 'Before > after', render: (r) => `${msText(r.beforeMs)} > ${msText(r.afterMs)}`, right: true },
        { label: 'Delta', render: (r) => signed(r.deltaPct, '%'), right: true, cls: () => 'text-status-warn' },
      ]} />
      <MoverTable title="Devices busier" rows={devices} empty={EMPTY_MOVE} cols={[
        { label: 'Device', render: (r) => (r.deviceId ? lnk(`/logicmonitor/devices?device=${r.deviceId}`, r.deviceName || '-') : (r.deviceName || '-')), cls: () => '' },
        { label: 'Metric', render: (r) => (r.metric === 'cpu_pct' ? 'CPU' : r.metric === 'mem_pct' ? 'Memory' : r.metric || '-') },
        { label: 'Before > after', render: ba, right: true },
      ]} />
      <MoverTable title="WAN circuits" rows={circuits} empty="No WAN circuit history in this range." cols={[
        { label: 'Device', render: (r) => lnk(`/logicmonitor/circuits?q=${enc(r.deviceName || '')}`, r.deviceName || '-'), cls: () => '' },
        { label: 'Port', render: (r) => r.port || '-' },
        { label: 'Before > after', render: ba, right: true },
        { label: 'Delta', render: (r) => signed(r.delta, ' pts'), right: true, cls: (r) => (r.delta > 0 ? 'text-status-warn' : 'text-ink-muted') },
      ]} />
    </div>
  );
}

function DayByDay({ daily, range }) {
  const hourly = range === '24h';
  const buckets = arr(daily.buckets || daily.labels);
  const alerts = daily.alerts || {};
  const n = buckets.length || Math.max(arr(alerts.critical).length, arr(alerts.warning).length);
  const labels = buckets.length ? buckets.map((b) => bucketLabel(b, hourly)) : Array.from({ length: n }, (_, i) => String(i + 1));
  const bar = (label, data, color) => ({ label, data: arr(data), backgroundColor: color, borderWidth: 0 });
  const alertData = { labels, datasets: [bar('Critical', alerts.critical, '#C75D5D'), bar('Warning', alerts.warning, '#D4A24E'), bar('Info', alerts.info, '#4C9BE8')] };
  const types = arr(daily.issues?.types);
  const issueData = { labels, datasets: types.map((t, i) => bar(t === 'other' ? 'Other' : issueTypeLabel(t), daily.issues?.series?.[t], PALETTE[i % PALETTE.length])) };
  const ep = daily.episodes || {};
  const epData = { labels, datasets: ['one-off', 'sustained', 'escalated', 'open'].map((k) => bar(k === 'one-off' ? 'One-off' : k.charAt(0).toUpperCase() + k.slice(1), ep[k], EPISODE_COLORS[k])) };
  return (
    <div className="grid xl:grid-cols-3 gap-4 mb-6">
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Alerts raised by severity</p>
        <div className="h-[220px]"><Bar data={alertData} options={stackedOpts} /></div>
      </div>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Issues opened by type</p>
        <div className="h-[220px]"><Bar data={issueData} options={stackedOpts} /></div>
      </div>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Latency episodes by outcome</p>
        <div className="h-[220px]"><Bar data={epData} options={stackedOpts} /></div>
      </div>
    </div>
  );
}

const NA = <p className="text-xs text-ink-muted mb-6">Not available until the backend is updated.</p>;
const H = ({ children }) => <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-2 mx-1">{children}</p>;

export default function LmTrendsPage() {
  const { toast } = useToast();
  const [range, setRange] = useState('7d');
  const [points, setPoints] = useState(null);
  const [extra, setExtra] = useState({ daily: null, movers: null });
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/trends', { params: { range } })
    .then(({ data }) => { setPoints(Array.isArray(data?.points) ? data.points : []); setExtra({ daily: data?.daily || null, movers: data?.movers || null }); setLastRefreshed(new Date()); })
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

      {points == null ? <LoadingPanel label="Loading trends..." height={240} /> : (
        <>
          <H>What is moving</H>
          {extra.movers ? <Movers movers={extra.movers} /> : NA}
          <H>Day by day</H>
          {extra.daily ? <DayByDay daily={extra.daily} range={range} /> : NA}
          <H>Estate</H>
          {list.length < 2 ? (
            <div className="panel p-6 text-sm text-ink-muted text-center">Not enough history yet. Each poll adds one snapshot.</div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-4">
              <ChartPanel title="Devices by Status"><Line data={devices} options={chartOpts} /></ChartPanel>
              <ChartPanel title="Interfaces"><Line data={ifaces} options={chartOpts} /></ChartPanel>
              <ChartPanel title="Open Alerts by Severity"><Line data={alerts} options={chartOpts} /></ChartPanel>
              <ChartPanel title="Collectors and Checks"><Line data={health} options={chartOpts} /></ChartPanel>
            </div>
          )}
        </>
      )}
    </div>
  );
}
