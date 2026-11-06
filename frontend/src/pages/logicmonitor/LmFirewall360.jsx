import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager } from '../../components/ui/tableTools';
import {
  DASH, arr, fmtNum, fmtPct, fmtMbps, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel, titleCase,
} from './helpers';
import { Modal, SectionPanel, Fact, headRow } from './ui';
import { num, pointsOf, TrendLine, AutoTable, FactGrid, IssuesList, syncedOf } from './kit360';

// The detail kit moved to kit360.jsx; re-exported so existing imports keep working.
export { num, humanKey, pointsOf, TrendLine, AutoTable, FactGrid, IssuesList, syncedOf } from './kit360';

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

export default function LmFirewall360({ deviceId, sourceId, onClose, apiBase = '/logicmonitor' }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`${apiBase}/firewalls/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Firewall not found. It may have been removed or is not a firewall.' : 'Failed to load the firewall.'));
  }, [deviceId, sourceId, apiBase]);

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
            <button onClick={() => navigate(`${apiBase}/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
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

