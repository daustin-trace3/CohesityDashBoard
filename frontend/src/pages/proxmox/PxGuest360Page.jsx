import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Crosshair, Cpu, HardDrive, Network as NetworkIcon, Camera, Settings2, MonitorSmartphone } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import {
  fmtBytes, fmtWhen, guestTypeLabel, humanizeSeconds, parseIpAddresses, snapshotAgeTone, daysAgo,
} from './helpers';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const TIMEFRAMES = ['hour', 'day', 'week'];

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-sm text-ink truncate">{children ?? '—'}</div>
    </div>
  );
}

const chartOpts = (yMax) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#E5E5E5', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' }, min: 0, max: yMax },
  },
});

function buildDataset(rrd, series) {
  if (!rrd || rrd.length === 0) return null;
  const labels = rrd.map(r => {
    const d = new Date(Number(r.time) * 1000);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  return {
    labels,
    datasets: series.map(s => ({
      label: s.label,
      data: rrd.map(r => (r[s.key] == null ? null : s.transform ? s.transform(r[s.key]) : r[s.key])),
      borderColor: s.color,
      backgroundColor: s.color,
      pointRadius: rrd.length > 60 ? 0 : 2,
      borderWidth: 2, tension: 0.25, spanGaps: true,
    })),
  };
}

export default function PxGuest360Page() {
  const { id } = useParams();
  const { toast } = useToast();
  const [detail, setDetail] = useState(null);
  const [config, setConfig] = useState(null);
  const [rrd, setRrd] = useState(null);
  const [timeframe, setTimeframe] = useState('hour');
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    setNotFound(false);
    client.get(`/proxmox/guests/${id}/detail`)
      .then(({ data }) => { setDetail(data); setLastRefreshed(new Date()); })
      .catch(() => { setDetail(null); setNotFound(true); toast({ type: 'error', title: 'Failed to load guest' }); });
  }, [id, toast]);

  const loadRrd = useCallback((tf) => {
    setRrd(null);
    client.get(`/proxmox/guests/${id}/rrd`, { params: { timeframe: tf } })
      .then(({ data }) => setRrd(Array.isArray(data) ? data : []))
      .catch(() => setRrd([]));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRrd(timeframe); }, [loadRrd, timeframe]);

  useEffect(() => {
    client.get('/proxmox/config')
      .then(({ data }) => setConfig(data))
      .catch(() => setConfig({ snapshotAgeDays: 30 }));
  }, []);

  const guest = detail?.guest;
  const cfg = detail?.config || {};
  const disks = detail?.disks || [];
  const nics = detail?.nics || [];
  const snapshots = detail?.snapshots || [];
  const ipList = parseIpAddresses(guest?.ipAddresses);
  const snapshotAgeDays = config?.snapshotAgeDays ?? 30;

  const cpuMemChartFixed = useMemo(() => {
    if (!rrd || rrd.length === 0) return null;
    const labels = rrd.map(r => {
      const d = new Date(Number(r.time) * 1000);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    return {
      labels,
      datasets: [
        {
          label: 'CPU %', data: rrd.map(r => (r.cpu == null ? null : r.cpu * 100)),
          borderColor: '#E57000', backgroundColor: '#E57000', pointRadius: rrd.length > 60 ? 0 : 2, borderWidth: 2, tension: 0.25, spanGaps: true,
        },
        {
          label: 'Mem %', data: rrd.map(r => (r.mem == null || !r.maxmem ? null : (r.mem / r.maxmem) * 100)),
          borderColor: '#0091DA', backgroundColor: '#0091DA', pointRadius: rrd.length > 60 ? 0 : 2, borderWidth: 2, tension: 0.25, spanGaps: true,
        },
      ],
    };
  }, [rrd]);

  const diskIoChart = useMemo(() => buildDataset(rrd, [
    { key: 'diskread', label: 'Read B/s', color: '#6CB33F' },
    { key: 'diskwrite', label: 'Write B/s', color: '#C75D5D' },
  ]), [rrd]);

  const netChart = useMemo(() => buildDataset(rrd, [
    { key: 'netin', label: 'Net In B/s', color: '#9B6CD4' },
    { key: 'netout', label: 'Net Out B/s', color: '#4ED4B8' },
  ]), [rrd]);

  return (
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Crosshair} title={guest ? guest.name : 'Guest 360'}
        description={guest ? `VMID ${guest.vmid} · ${guest.node} · ${guest.serverName}` : 'Everything Proxmox knows about one guest'}>
        {guest && <Badge tone={guest.type === 'qemu' ? 'brand' : 'info'}>{guestTypeLabel(guest.type)}</Badge>}
        {guest && <Badge tone={guest.status === 'running' ? 'ok' : 'neutral'}>{guest.status || '—'}</Badge>}
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-3">
        <Link to="/proxmox/guests" className="text-[11px] text-brand hover:underline">← Back to Guests</Link>
      </div>

      {notFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">Guest not found.</div>
      )}

      {!guest && !notFound && <LoadingPanel label="Loading guest…" height={200} />}

      {guest && (
        <>
          <Panel title="Config" icon={Settings2}>
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
              <Fact label="Cores / Sockets">{cfg.cores ?? guest.cpuCount ?? '—'} / {cfg.sockets ?? guest.cpuSockets ?? '—'}</Fact>
              <Fact label="Memory">{cfg.memory ? `${Number(String(cfg.memory).split(',')[0]).toLocaleString()} MB` : fmtBytes(guest.memTotal)}</Fact>
              <Fact label="BIOS">{cfg.bios || '—'}</Fact>
              <Fact label="Machine">{cfg.machine || '—'}</Fact>
              <Fact label="Boot Order">{cfg.boot || '—'}</Fact>
              <Fact label="Start on Boot"><Badge tone={cfg.onboot ? 'ok' : 'neutral'}>{cfg.onboot ? 'yes' : 'no'}</Badge></Fact>
              <Fact label="Tags">{cfg.tags || guest.tags || '—'}</Fact>
              <Fact label="Uptime">{guest.status === 'running' ? humanizeSeconds(guest.uptimeSeconds) : '—'}</Fact>
            </div>
          </Panel>

          <Panel title="OS & IP Addresses" icon={MonitorSmartphone}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-start">
              <Fact label="OS">{guest.osName || '—'}</Fact>
              <Fact label="Agent">
                <Badge tone={guest.agentRunning ? 'ok' : 'neutral'}>{guest.agentRunning ? 'running' : cfg.agent ? 'enabled, not running' : 'disabled'}</Badge>
              </Fact>
              <div className="col-span-2 min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">IP Addresses</p>
                <div className="text-sm text-ink">{ipList.length ? ipList.join(', ') : '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel title="Disks" icon={HardDrive}>
            {disks.length === 0 ? (
              <p className="text-xs text-ink-faint">No disk devices found in config.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Device</th>
                    <th className="py-1.5 pr-3">Storage</th>
                    <th className="py-1.5 pr-3">Size</th>
                    <th className="py-1.5 pr-3">Raw</th>
                  </tr></thead>
                  <tbody>
                    {disks.map((d, i) => (
                      <tr key={i} className="border-b border-cohesity-border/50">
                        <td className="py-1.5 pr-3 text-ink tnum">{d.key}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{d.storage || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted tnum">{d.size || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-faint text-[11px] max-w-[320px] truncate" title={d.raw}>{d.raw}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="NICs" icon={NetworkIcon}>
            {nics.length === 0 ? (
              <p className="text-xs text-ink-faint">No NIC devices found in config.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Device</th>
                    <th className="py-1.5 pr-3">Model</th>
                    <th className="py-1.5 pr-3">MAC</th>
                    <th className="py-1.5 pr-3">Bridge</th>
                    <th className="py-1.5 pr-3">VLAN Tag</th>
                  </tr></thead>
                  <tbody>
                    {nics.map((n, i) => (
                      <tr key={i} className="border-b border-cohesity-border/50">
                        <td className="py-1.5 pr-3 text-ink tnum">{n.key}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{n.model || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-faint tnum text-[11px]">{n.mac || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{n.bridge || '—'}</td>
                        <td className="py-1.5 pr-3 text-ink-muted tnum">{n.tag ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Snapshots" icon={Camera}>
            {snapshots.length === 0 ? (
              <p className="text-xs text-ink-faint">No snapshots.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <th className="py-1.5 pr-3">Name</th>
                    <th className="py-1.5 pr-3">Parent</th>
                    <th className="py-1.5 pr-3">Description</th>
                    <th className="py-1.5 pr-3">Age</th>
                    <th className="py-1.5 pr-3">Taken</th>
                  </tr></thead>
                  <tbody>
                    {snapshots.map((s, i) => {
                      const age = daysAgo(s.snapTime);
                      const tone = snapshotAgeTone(s.snapTime, snapshotAgeDays);
                      return (
                        <tr key={i} className="border-b border-cohesity-border/50">
                          <td className="py-1.5 pr-3 text-ink">{s.name}</td>
                          <td className="py-1.5 pr-3 text-ink-muted">{s.parent || '—'}</td>
                          <td className="py-1.5 pr-3 text-ink-faint max-w-[260px] truncate" title={s.description}>{s.description || '—'}</td>
                          <td className="py-1.5 pr-3"><Badge tone={tone}>{age != null ? `${age}d` : '—'}</Badge></td>
                          <td className="py-1.5 pr-3 text-ink-faint tnum">{fmtWhen(s.snapTime)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Trend" icon={Cpu} actions={(
            <div className="flex gap-1">
              {TIMEFRAMES.map(tf => (
                <button key={tf} onClick={() => setTimeframe(tf)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${
                    timeframe === tf ? 'bg-brand text-cohesity-black border-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'
                  }`}>
                  {tf}
                </button>
              ))}
            </div>
          )}>
            {rrd == null ? (
              <LoadingPanel label="Loading trend…" height={160} />
            ) : rrd.length === 0 ? (
              <div className="text-sm text-ink-muted py-8 text-center">No RRD data available for this timeframe.</div>
            ) : (
              <div className="flex flex-col gap-5">
                <div>
                  <p className="text-xs text-ink-muted mb-2">CPU / Memory %</p>
                  <div className="h-40"><Line data={cpuMemChartFixed} options={chartOpts(100)} /></div>
                </div>
                <div>
                  <p className="text-xs text-ink-muted mb-2">Disk I/O (bytes/s)</p>
                  <div className="h-40"><Line data={diskIoChart} options={chartOpts(undefined)} /></div>
                </div>
                <div>
                  <p className="text-xs text-ink-muted mb-2">Network (bytes/s)</p>
                  <div className="h-40"><Line data={netChart} options={chartOpts(undefined)} /></div>
                </div>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
