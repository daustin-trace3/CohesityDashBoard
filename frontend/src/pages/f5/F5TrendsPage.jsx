import { useMemo, useState } from 'react';
import { TrendingUp, Cpu, MemoryStick, Activity, HardDrive } from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, chipBtn } from '../logicmonitor/ui';
import { useF5Get } from './f5Shared';
import { sevTone, n1, pct1, ForecastCell, FeedNote, PageError, CtlTable } from './f5Kit';

const DAYS = [7, 30, 90];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The hourlyProfile feed describes its basis as { windowDays, samples, metric }; older shapes may send text.
function basisText(b) {
  if (!b) return 'Hour-of-day profile';
  if (typeof b === 'string') return b;
  const parts = [];
  if (b.windowDays) parts.push(`${b.windowDays} day window`);
  if (b.samples) parts.push(`${b.samples} samples`);
  if (b.metric) parts.push(String(b.metric).replace(/_/g, ' '));
  return parts.length ? `Hour-of-day profile over a ${parts.join(', ')}` : 'Hour-of-day profile';
}

function Heatmap({ heatmap }) {
  const cells = Array.isArray(heatmap?.cells) ? heatmap.cells : [];
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array(24).fill(null));
    let max = 0;
    for (const c of cells) {
      const d = Number(c.dow ?? c.weekday);
      const h = Number(c.hour);
      const v = Number(c.median ?? c.value);
      if (d >= 0 && d < 7 && h >= 0 && h < 24 && Number.isFinite(v)) { g[d][h] = v; if (v > max) max = v; }
    }
    return { g, max };
  }, [cells]);
  if (!cells.length) return <p className="text-[12px] text-ink-muted py-4 text-center">The hour-by-weekday profile is not available yet. It needs the connection baselines to have run for a week.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] border-separate" style={{ borderSpacing: 2 }}>
        <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="text-ink-faint font-normal w-6">{h}</th>)}</tr></thead>
        <tbody>
          {grid.g.map((row, d) => (
            <tr key={DOW[d]}>
              <td className="text-ink-faint pr-2">{DOW[d]}</td>
              {row.map((v, h) => (
                <td key={h} title={v == null ? 'no data' : `${DOW[d]} ${h}:00 median ${fmtNum(Math.round(v))}`}
                  style={{ background: v == null ? 'transparent' : `rgba(228,0,43,${0.12 + 0.78 * (grid.max ? v / grid.max : 0)})`, width: 22, height: 18 }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-ink-faint mt-2">{basisText(heatmap.basis)}. Darker is busier (client connections, fleet median per hour).</p>
    </div>
  );
}

export default function F5TrendsPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/trends', 'F5 trends', { params: { days } });
  const devices = useMemo(() => (Array.isArray(data?.devices) ? data.devices : []), [data]);
  const anomalies = Array.isArray(data?.anomalies) ? data.anomalies : [];
  const forecast30 = devices.filter((d) => d.cpu.forecast.days != null && d.cpu.forecast.days <= 30).length;
  const creep = devices.filter((d) => d.mem.creep).length;
  const fsRows = useMemo(() => devices.flatMap((d) => d.filesystems.map((f) => ({ device: d.device, fs: f.fs, usedPct: f.usedPct, forecast: f.forecast, days: f.forecast.days }))), [devices]);

  const rows = devices.map((d) => ({
    ...d, cpuNow: d.cpu.now, cpuP95: d.cpu.p95, memP95: d.mem.p95, connNow: d.connections.clientNow, connPeak: d.connections.peak,
    slope: d.cpu.slopePerDay, daysTo80: d.cpu.forecast.days, ratio: d.connections.ratio,
  }));

  return (
    <div className="animate-fade-in">
      <PageHeader icon={TrendingUp} title="Capacity Trends" description="CPU, memory, connections and filesystem forecasts per unit, from LogicMonitor daily history">
        <div className="flex items-center gap-1.5">
          {DAYS.map((d) => <button key={d} className={chipBtn(days === d)} onClick={() => setDays(d)}>{d} d</button>)}
        </div>
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Cpu} label="CPU to 80% in 30 d" value={fmtNum(forecast30)} tone={forecast30 ? 'warn' : 'ok'} sub="linear-fit estimate" loading={loading} />
        <StatCard icon={MemoryStick} label="Memory creep" value={fmtNum(creep)} tone={creep ? 'warn' : 'ok'} sub="rising, no reboot" loading={loading} />
        <StatCard icon={Activity} label="Connection anomalies" value={fmtNum(anomalies.length)} tone={anomalies.length ? 'warn' : 'ok'} sub="outside the hour baseline" loading={loading} />
        <StatCard icon={HardDrive} label="Filesystems tracked" value={fmtNum(fsRows.length)} loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading trends..." height={200} /> : data && data.available === false ? <FeedNote what="Device resource history" /> : (
        <div className="flex flex-col gap-4">
          <SectionPanel title="Units" blurb="Days to 80 percent CPU is a linear-fit estimate over the daily history and shows its basis. insufficient data means too few days or a weak fit. Peak connections appear when the feed carries them.">
            <CtlTable rows={rows} searchKeys={['device', 'site']} defaultSortKey="daysTo80" empty="No units reported resource history yet." rowKey={(r) => `${r.sourceId}-${r.deviceId}`}
              columns={[
                { k: 'device', label: 'Unit', render: (r) => <span className="text-ink">{r.device}</span> },
                { k: 'site', label: 'Site' },
                { k: 'cpuNow', label: 'CPU now', align: 'right', render: (r) => pct1(r.cpuNow) },
                { k: 'cpuP95', label: 'CPU p95', align: 'right', render: (r) => pct1(r.cpuP95) },
                { k: 'memP95', label: 'Mem p95', align: 'right', render: (r) => pct1(r.memP95) },
                { k: 'connNow', label: 'Client conns', align: 'right', render: (r) => (r.connNow == null ? DASH : fmtNum(r.connNow)) },
                { k: 'connPeak', label: 'Peak conns', align: 'right', render: (r) => (r.connPeak == null ? DASH : fmtNum(r.connPeak)) },
                { k: 'ratio', label: 'Client:server', align: 'right', render: (r) => (r.ratio == null ? DASH : n1(r.ratio)) },
                { k: 'slope', label: 'CPU slope / day', align: 'right', render: (r) => (r.slope == null ? DASH : `${n1(r.slope)} pts`) },
                { k: 'daysTo80', label: 'Days to 80% CPU', render: (r) => <ForecastCell f={r.cpu.forecast} /> },
                { k: 'mem', label: 'Memory', sortValue: (r) => (r.mem.creep ? 0 : 1), render: (r) => (r.mem.creep ? <Badge tone="warn">creep</Badge> : DASH) },
              ]} />
          </SectionPanel>

          <div className="grid xl:grid-cols-2 gap-4">
            <SectionPanel title="Filesystems" blurb="Days until a filesystem reaches 90 percent, from the daily fill history; /var/log and /shared are the usual ones.">
              <CtlTable rows={fsRows} searchKeys={['device', 'fs']} defaultSortKey="days" empty="No filesystem history yet." pageSize={8}
                columns={[
                  { k: 'device', label: 'Unit' },
                  { k: 'fs', label: 'Filesystem' },
                  { k: 'usedPct', label: 'Used', align: 'right', render: (r) => pct1(r.usedPct) },
                  { k: 'days', label: 'Days to 90%', render: (r) => <ForecastCell f={r.forecast} /> },
                ]} />
            </SectionPanel>
            <SectionPanel title="Connection anomalies" blurb="Client connections more than 3 median absolute deviations from the hour-of-day baseline; a sudden drop can mean an upstream outage.">
              <CtlTable rows={anomalies} searchKeys={['device']} defaultSortKey="severity" empty="No connection anomalies right now." pageSize={8} search={false}
                columns={[
                  { k: 'device', label: 'Unit' },
                  { k: 'direction', label: 'Direction', render: (r) => (r.direction ? <Badge tone={r.direction === 'drop' ? 'crit' : 'warn'}>{r.direction}</Badge> : DASH) },
                  { k: 'value', label: 'Connections', align: 'right', render: (r) => (r.value == null ? DASH : fmtNum(Math.round(r.value))) },
                  { k: 'severity', label: 'Severity', render: (r) => <Badge tone={sevTone(r.severity)}>{r.severity || DASH}</Badge> },
                ]} />
            </SectionPanel>
          </div>

          <SectionPanel title="Peak-hour profile" blurb="Client connections by hour of day and weekday.">
            <Heatmap heatmap={data?.heatmap} />
          </SectionPanel>
          {(data?.notes || []).map((n) => <p key={n} className="text-[11px] text-ink-faint">{n}</p>)}
        </div>
      )}
    </div>
  );
}
