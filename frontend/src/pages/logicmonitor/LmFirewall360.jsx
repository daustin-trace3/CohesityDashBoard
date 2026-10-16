import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, DASH, arr, fmtNum, fmtPct, fmtMbps, fmtWhen, fmtShortTime, stateTone, stateLabel, severityTone, hostStatusTone, hostStatusLabel, chartOpts, titleCase,
} from './helpers';
import { Modal, SectionPanel, Fact, headRow } from './ui';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export const num = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));

const pctOpts = { ...chartOpts, scales: { x: chartOpts.scales.x, y: { ...chartOpts.scales.y, min: 0, suggestedMax: 100 } } };

// "inBps" -> "In bps", "member_avail" -> "Member avail".
export const humanKey = (k) => {
  const s = String(k || '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// A history series can arrive as [{epoch, value}] or under a named key of an
// object; epoch is seconds (milliseconds tolerated).
export function pointsOf(h, names) {
  if (Array.isArray(h)) return h;
  if (h && typeof h === 'object') {
    for (const n of names) if (Array.isArray(h[n])) return h[n];
  }
  return [];
}
const labelOf = (p) => {
  const e = num(p?.epoch);
  if (e == null) return '';
  return fmtShortTime(new Date(e > 1e11 ? e : e * 1000).toISOString());
};

// 140 px line chart like the Overview trends. series: [{label, points, color, dash}]
export function TrendLine({ series, pct = false, empty = 'No history collected yet.' }) {
  const base = (series || []).find((s) => arr(s.points).length);
  const data = useMemo(() => ({
    labels: arr(base?.points).map(labelOf),
    datasets: (series || []).map((s, i) => ({
      label: s.label, data: arr(s.points).map((p) => num(p?.value)),
      borderColor: s.color || (i === 0 ? BRAND : '#3FB950'), borderDash: s.dash, pointRadius: 0, borderWidth: 2, tension: 0.2,
    })),
  }), [series, base]);
  if (!base) return <p className="text-[12px] text-ink-muted py-4 text-center">{empty}</p>;
  return <div className="h-[140px]"><Line data={data} options={pct ? pctOpts : chartOpts} /></div>;
}

// Renders rows of unknown shape (route sections whose columns the contract
// does not pin): scalar keys become columns, nested values are skipped.
export function AutoTable({ rows, empty = 'None collected.', preferred = [], pageSize = 10 }) {
  const list = useMemo(() => (Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : []), [rows]);
  const cols = useMemo(() => {
    const seen = [];
    for (const r of list.slice(0, 50)) {
      for (const [k, v] of Object.entries(r)) {
        if (k === 'sampledAt' || k === 'epoch') continue;
        if (v != null && typeof v === 'object' && !('value' in v)) continue;
        if (!seen.includes(k)) seen.push(k);
      }
    }
    const first = preferred.filter((k) => seen.includes(k));
    return [...first, ...seen.filter((k) => !first.includes(k))].slice(0, 9);
  }, [list, preferred]);
  const ctl = useTableControls(list, { searchKeys: cols, paginate: true, defaultPageSize: pageSize, deepLink: false });
  if (list.length === 0) return <p className="text-[12px] text-ink-muted py-3 text-center">{empty}</p>;
  const cell = (r, k) => {
    let v = r[k];
    if (v != null && typeof v === 'object') v = v.value;
    if (v == null || v === '') return DASH;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return /pct|percent|util/i.test(k) ? fmtPct(v, 1) : /bps/i.test(k) ? fmtMbps(v / 1e6) : fmtNum(Math.round(v * 100) / 100);
    return String(v);
  };
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>{cols.map((k) => <SortTh key={k} k={k} label={humanKey(k)} ctl={ctl} />)}</tr></thead>
          <tbody>
            {ctl.pageRows.map((r, i) => (
              <tr key={i} className="border-b border-cohesity-border/40">
                {cols.map((k, ci) => <td key={k} className={`py-1.5 pr-3 text-[12px] ${ci === 0 ? 'text-ink' : 'text-ink-muted tnum'}`}>{cell(r, k)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[pageSize, 25, 50, 'all']} />
    </>
  );
}

// An object section (for example globalProtect) as a Fact grid.
export function FactGrid({ obj, empty = 'None collected.' }) {
  const entries = Object.entries(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}).filter(([, v]) => v == null || typeof v !== 'object');
  if (!entries.length) return <p className="text-[12px] text-ink-muted py-3 text-center">{empty}</p>;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {entries.map(([k, v]) => <Fact key={k} label={humanKey(k)}>{typeof v === 'number' ? fmtNum(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v}</Fact>)}
    </div>
  );
}

export function IssuesList({ issues }) {
  const list = arr(issues);
  if (!list.length) return <p className="text-sm text-status-ok py-3 text-center">No open issues on this device.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((i, n) => (
        <div key={i.id ?? n} className="flex items-start gap-2 text-[12px]">
          <Badge tone={severityTone(i.severity)}>{i.severity || 'info'}</Badge>
          <span className="text-ink-faint font-mono shrink-0">{i.type}</span>
          <span className="text-ink-muted">{i.message || i.target}</span>
        </div>
      ))}
    </div>
  );
}

// Config sync reads as boolean, 0/1 or text depending on the datapoint.
export function syncedOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  if (['1', 'yes', 'true', 'synced', 'in sync', 'synchronized'].includes(s)) return true;
  if (['0', 'no', 'false', 'unsynced', 'out of sync', 'not synced'].includes(s)) return false;
  return null;
}

function TunnelsTable({ rows }) {
  const list = useMemo(() => arr(rows).map((t) => ({ ...t, stateRank: stateTone(t.state) === 'crit' || /down/i.test(String(t.state)) ? 2 : /up|ok|active/i.test(String(t.state)) ? 0 : 1 })), [rows]);
  const ctl = useTableControls(list, { searchKeys: ['name'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true, defaultPageSize: 10, deepLink: false });
  if (!list.length) return <p className="text-[12px] text-ink-muted py-3 text-center">No IPSec tunnels collected yet. The metrics tier runs every 30 minutes by default; check Settings &gt; Scope &gt; Metric families.</p>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <SortTh k="name" label="Tunnel" ctl={ctl} />
            <SortTh k="stateRank" label="State" ctl={ctl} />
            <SortTh k="inBps" label="In" ctl={ctl} align="right" />
            <SortTh k="outBps" label="Out" ctl={ctl} align="right" />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((t, i) => (
              <tr key={`${t.name}-${i}`} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink text-[12px] truncate max-w-[320px]" title={t.name}>{t.name}</td>
                <td className="py-1.5 pr-3"><Badge tone={t.stateRank === 2 ? 'crit' : t.stateRank === 0 ? 'ok' : 'neutral'}>{typeof t.state === 'string' ? titleCase(t.state) : (t.stateRank === 0 ? 'Up' : t.stateRank === 2 ? 'Down' : String(t.state ?? 'Unknown'))}</Badge></td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{num(t.inBps) == null ? DASH : fmtMbps(num(t.inBps) / 1e6)}</td>
                <td className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{num(t.outBps) == null ? DASH : fmtMbps(num(t.outBps) / 1e6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </>
  );
}

export default function LmFirewall360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`/logicmonitor/firewalls/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Firewall not found. It may have been removed or is not a firewall.' : 'Failed to load the firewall.'));
  }, [deviceId, sourceId]);

  const s = data?.summary || {};
  const d = data?.device || {};
  const hw = data?.hardware || {};
  const routing = data?.routing || {};
  const hist = data?.sessionsHistory;
  const utilPts = pointsOf(hist, ['sessions_util_pct', 'utilPct', 'sessionsUtilPct']);
  const activePts = pointsOf(hist, ['sessions_active', 'active', 'sessionsActive']);
  const synced = syncedOf(s.configSynced);

  return (
    <Modal icon={ShieldCheck} title={s.deviceName || d.displayName || `Firewall ${deviceId}`} subtitle={[s.vendor, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading firewall..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            {s.haText ? <Badge tone="info">{s.haText}</Badge> : <Badge tone="neutral">{s.haEnabled ? 'HA' : 'Standalone'}</Badge>}
            {synced === false && <Badge tone="warn">Config unsynced</Badge>}
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="Site">{s.siteName || s.siteKey}</Fact>
            <Fact label="Sessions">{`${fmtNum(s.sessionsActive)} / ${fmtNum(s.sessionsMax)}`}</Fact>
            <Fact label="Dataplane CPU">{fmtPct(s.dataplaneCpuPct)}</Fact>
            <Fact label="Mgmt CPU">{fmtPct(s.mgmtCpuPct)}</Fact>
            <Fact label="Memory">{fmtPct(s.memPct)}</Fact>
            <Fact label="Tunnels up / down">{`${fmtNum(s.tunnelsUp)} / ${fmtNum(s.tunnelsDown)}`}</Fact>
            <Fact label="GlobalProtect users">{fmtNum(s.gpUsers)}</Fact>
            <Fact label="Threats per hour">{s.threatsPerHour == null ? DASH : fmtNum(Math.round(Number(s.threatsPerHour)))}</Fact>
            <Fact label="Dropped per min">{s.droppedPerMin == null ? DASH : fmtNum(Math.round(Number(s.droppedPerMin)))}</Fact>
            <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
          </div>

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Session utilization, 24 hours">
              <TrendLine pct series={[{ label: 'Session utilization %', points: utilPts }]} />
            </SectionPanel>
            <SectionPanel title="Active sessions, 24 hours">
              <TrendLine series={[{ label: 'Active sessions', points: activePts, color: '#3FB950' }]} />
            </SectionPanel>
          </div>

          <SectionPanel title="High availability" blurb="Local and peer state come from the HA DataSources. Enum text is mapped by ICC where the datapoint carries it; other values show as numbers.">
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              <Badge tone={s.haEnabled ? 'info' : 'neutral'}>{s.haEnabled ? 'HA enabled' : 'Standalone'}</Badge>
              {s.haEnabled ? <span className="text-[12px] text-ink-muted">Local {s.haLocalState ?? DASH}, peer {s.haPeerState ?? DASH}</span> : null}
            </div>
            <AutoTable rows={data.ha} empty="No HA interface rows collected." />
          </SectionPanel>

          <SectionPanel title="IPSec tunnels" blurb="Down tunnels sort first.">
            <TunnelsTable rows={data.tunnels} />
          </SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Zones"><AutoTable rows={data.zones} empty="No zone statistics collected." /></SectionPanel>
            <SectionPanel title="Virtual systems"><AutoTable rows={data.vsys} empty="No virtual systems collected." /></SectionPanel>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="GlobalProtect">
              {Array.isArray(data.globalProtect) ? <AutoTable rows={data.globalProtect} empty="No GlobalProtect gateway collected." /> : <FactGrid obj={data.globalProtect} empty="No GlobalProtect gateway collected." />}
            </SectionPanel>
            <SectionPanel title="Log forwarding"><AutoTable rows={data.logForwarding} empty="No log forwarding statistics collected." /></SectionPanel>
          </div>

          <SectionPanel title="Hardware" right={hw.chassisWatts != null ? <span className="text-[11px] text-ink-muted tnum">Chassis power {fmtNum(Math.round(Number(hw.chassisWatts)))} W</span> : null}>
            <div className="grid lg:grid-cols-3 gap-4">
              <div><p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Disks</p><AutoTable rows={hw.disks} empty="No disks collected." pageSize={5} /></div>
              <div><p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Power supplies</p><AutoTable rows={hw.psus} empty="No power supplies collected." pageSize={5} /></div>
              <div><p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Temperatures</p><AutoTable rows={hw.temps} empty="No temperature sensors collected." pageSize={5} /></div>
            </div>
          </SectionPanel>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="BGP peers"><AutoTable rows={routing.bgp} empty="No BGP peers collected." /></SectionPanel>
            <SectionPanel title="OSPF neighbours"><AutoTable rows={routing.ospf} empty="No OSPF neighbours collected." /></SectionPanel>
          </div>
        </div>
      )}
    </Modal>
  );
}

