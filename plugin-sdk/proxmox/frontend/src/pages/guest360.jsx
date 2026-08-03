// Proxmox Guest 360 — ports host frontend/src/pages/proxmox/PxGuest360Page.jsx.
// Chart.js replaced with charts.jsx's LineChart; useParams comes from the
// global ReactRouterDOM (build-banner global, no ESM import available).
import {
  injectStyles, PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated,
  CrosshairIcon, HardDriveIcon, NetworkIcon, CameraIcon, Settings2Icon, MonitorIcon, CpuIcon,
  fmtBytes, fmtWhen, humanizeSeconds, parseIpAddresses, daysAgo,
} from '../ui.jsx';
import { LineChart } from '../charts.jsx';

injectStyles();

const TIMEFRAMES = ['hour', 'day', 'week'];

function apiGet(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return fetch(`/api/proxmox${path}${qs}`, { credentials: 'include' }).then((res) => {
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return res.json();
  });
}

function guestTypeLabel(t) {
  return t === 'qemu' ? 'VM' : t === 'lxc' ? 'LXC' : t || '—';
}
function snapshotAgeTone(iso, thresholdDays = 30) {
  const age = daysAgo(iso);
  if (age == null) return 'neutral';
  return age >= thresholdDays ? 'warn' : 'ok';
}

function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--px-ink-faint)', margin: 0 }}>{label}</p>
      <div style={{ fontSize: 14, color: 'var(--px-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children ?? '—'}</div>
    </div>
  );
}

function buildSeries(rrd, spec) {
  if (!rrd || rrd.length === 0) return null;
  return spec.map((s) => ({
    label: s.label,
    color: s.color,
    points: rrd.map((r, i) => ({ x: i, y: r[s.key] == null ? null : (s.transform ? s.transform(r[s.key]) : r[s.key]) })),
  }));
}

export default function PxGuest360Page() {
  const { id } = ReactRouterDOM.useParams();
  const navigate = ReactRouterDOM.useNavigate();
  const [detail, setDetail] = React.useState(null);
  const [config, setConfig] = React.useState(null);
  const [rrd, setRrd] = React.useState(null);
  const [timeframe, setTimeframe] = React.useState('hour');
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [notFound, setNotFound] = React.useState(false);

  const load = React.useCallback(() => {
    setNotFound(false);
    apiGet(`/guests/${id}/detail`)
      .then((d) => { setDetail(d); setLastRefreshed(new Date()); })
      .catch(() => { setDetail(null); setNotFound(true); });
  }, [id]);

  const loadRrd = React.useCallback((tf) => {
    setRrd(null);
    apiGet(`/guests/${id}/rrd`, { timeframe: tf })
      .then((d) => setRrd(Array.isArray(d) ? d : []))
      .catch(() => setRrd([]));
  }, [id]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { loadRrd(timeframe); }, [loadRrd, timeframe]);
  React.useEffect(() => { apiGet('/config').then((d) => setConfig(d)).catch(() => setConfig({ snapshotAgeDays: 30 })); }, []);

  const guest = detail?.guest;
  const cfg = detail?.config || {};
  const disks = detail?.disks || [];
  const nics = detail?.nics || [];
  const snapshots = detail?.snapshots || [];
  const ipList = parseIpAddresses(guest?.ipAddresses);
  const snapshotAgeDays = config?.snapshotAgeDays ?? 30;

  // mem % needs maxmem from the same row, so it's computed directly rather
  // than via the generic transform helper (which only sees a single value).
  const cpuMemSeriesFixed = React.useMemo(() => {
    if (!rrd || rrd.length === 0) return null;
    return [
      { label: 'CPU %', color: '#E57000', points: rrd.map((r, i) => ({ x: i, y: r.cpu == null ? null : r.cpu * 100 })) },
      { label: 'Mem %', color: '#0091DA', points: rrd.map((r, i) => ({ x: i, y: r.mem == null || !r.maxmem ? null : (r.mem / r.maxmem) * 100 })) },
    ];
  }, [rrd]);
  const diskIoSeries = React.useMemo(() => buildSeries(rrd, [
    { key: 'diskread', label: 'Read B/s', color: '#6CB33F' },
    { key: 'diskwrite', label: 'Write B/s', color: '#C75D5D' },
  ]), [rrd]);
  const netSeries = React.useMemo(() => buildSeries(rrd, [
    { key: 'netin', label: 'Net In B/s', color: '#9B6CD4' },
    { key: 'netout', label: 'Net Out B/s', color: '#4ED4B8' },
  ]), [rrd]);

  return (
    <div className="px-root px-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader icon={CrosshairIcon} title={guest ? guest.name : 'Guest 360'}
        description={guest ? `VMID ${guest.vmid} · ${guest.node} · ${guest.serverName}` : 'Everything Proxmox knows about one guest'}>
        {guest && <Badge tone={guest.type === 'qemu' ? 'brand' : 'info'}>{guestTypeLabel(guest.type)}</Badge>}
        {guest && <Badge tone={guest.status === 'running' ? 'ok' : 'neutral'}>{guest.status || '—'}</Badge>}
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="px-panel" style={{ padding: 12 }}>
        <a onClick={(e) => { e.preventDefault(); navigate('/proxmox/guests'); }} href="/proxmox/guests" style={{ fontSize: 11, color: 'var(--px-brand)', textDecoration: 'underline', cursor: 'pointer' }}>
          ← Back to Guests
        </a>
      </div>

      {notFound && (
        <div className="px-panel" style={{ padding: 24, fontSize: 13, color: 'var(--px-ink-muted)', textAlign: 'center' }}>Guest not found.</div>
      )}

      {!guest && !notFound && <LoadingPanel label="Loading guest…" height={200} />}

      {guest && (
        <React.Fragment>
          <Panel title="Config" icon={Settings2Icon}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
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

          <Panel title="OS & IP Addresses" icon={MonitorIcon}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, alignItems: 'start' }}>
              <Fact label="OS">{guest.osName || '—'}</Fact>
              <Fact label="Agent">
                <Badge tone={guest.agentRunning ? 'ok' : 'neutral'}>{guest.agentRunning ? 'running' : cfg.agent ? 'enabled, not running' : 'disabled'}</Badge>
              </Fact>
              <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
                <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--px-ink-faint)', margin: 0 }}>IP Addresses</p>
                <div style={{ fontSize: 14, color: 'var(--px-ink)' }}>{ipList.length ? ipList.join(', ') : '—'}</div>
              </div>
            </div>
          </Panel>

          <Panel title="Disks" icon={HardDriveIcon}>
            {disks.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--px-ink-faint)' }}>No disk devices found in config.</p>
            ) : (
              <div className="px-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Device</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Storage</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Size</th>
                      <th style={{ padding: '6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Raw</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disks.map((d, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--px-border)' }}>
                        <td className="px-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink)' }}>{d.key}</td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-muted)' }}>{d.storage || '—'}</td>
                        <td className="px-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-muted)' }}>{d.size || '—'}</td>
                        <td style={{ padding: '6px 0', color: 'var(--px-ink-faint)', fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.raw}>{d.raw}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="NICs" icon={NetworkIcon}>
            {nics.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--px-ink-faint)' }}>No NIC devices found in config.</p>
            ) : (
              <div className="px-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Device</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Model</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>MAC</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Bridge</th>
                      <th style={{ padding: '6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>VLAN Tag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nics.map((n, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--px-border)' }}>
                        <td className="px-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink)' }}>{n.key}</td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-muted)' }}>{n.model || '—'}</td>
                        <td className="px-tnum" style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-faint)', fontSize: 11 }}>{n.mac || '—'}</td>
                        <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-muted)' }}>{n.bridge || '—'}</td>
                        <td className="px-tnum" style={{ padding: '6px 0', color: 'var(--px-ink-muted)' }}>{n.tag ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Snapshots" icon={CameraIcon}>
            {snapshots.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--px-ink-faint)' }}>No snapshots.</p>
            ) : (
              <div className="px-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--px-border)' }}>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Name</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Parent</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Description</th>
                      <th style={{ padding: '6px 12px 6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Age</th>
                      <th style={{ padding: '6px 0', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--px-ink-faint)' }}>Taken</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshots.map((s, i) => {
                      const age = daysAgo(s.snapTime);
                      const tone = snapshotAgeTone(s.snapTime, snapshotAgeDays);
                      return (
                        <tr key={i} style={{ borderBottom: '1px solid var(--px-border)' }}>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink)' }}>{s.name}</td>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-muted)' }}>{s.parent || '—'}</td>
                          <td style={{ padding: '6px 12px 6px 0', color: 'var(--px-ink-faint)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description}>{s.description || '—'}</td>
                          <td style={{ padding: '6px 12px 6px 0' }}><Badge tone={tone}>{age != null ? `${age}d` : '—'}</Badge></td>
                          <td className="px-tnum" style={{ padding: '6px 0', color: 'var(--px-ink-faint)' }}>{fmtWhen(s.snapTime)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Trend" icon={CpuIcon} actions={(
            <div style={{ display: 'flex', gap: 4 }}>
              {TIMEFRAMES.map((tf) => (
                <button key={tf} onClick={() => setTimeframe(tf)} className={`px-pill${timeframe === tf ? ' px-pill-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11 }}>
                  {tf}
                </button>
              ))}
            </div>
          )}>
            {rrd == null ? (
              <LoadingPanel label="Loading trend…" height={160} />
            ) : rrd.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--px-ink-muted)', padding: '32px 0', textAlign: 'center' }}>No RRD data available for this timeframe.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div>
                  <p style={{ fontSize: 12, color: 'var(--px-ink-muted)', marginBottom: 8 }}>CPU / Memory %</p>
                  <LineChart series={cpuMemSeriesFixed} height={160} yFmt={(v) => `${Math.round(v)}%`} />
                </div>
                <div>
                  <p style={{ fontSize: 12, color: 'var(--px-ink-muted)', marginBottom: 8 }}>Disk I/O (bytes/s)</p>
                  <LineChart series={diskIoSeries} height={160} yFmt={(v) => fmtBytes(v)} />
                </div>
                <div>
                  <p style={{ fontSize: 12, color: 'var(--px-ink-muted)', marginBottom: 8 }}>Network (bytes/s)</p>
                  <LineChart series={netSeries} height={160} yFmt={(v) => fmtBytes(v)} />
                </div>
              </div>
            )}
          </Panel>
        </React.Fragment>
      )}
    </div>
  );
}
