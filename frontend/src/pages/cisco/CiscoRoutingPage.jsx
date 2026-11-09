import { useMemo, useState } from 'react';
import { Route as RouteIcon, Network, Repeat, EyeOff } from 'lucide-react';
import { StatCard } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, headRow, chipBtn } from '../logicmonitor/ui';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, Chip } from './ciscoKit';

const PROTOCOLS = [['all', 'All'], ['bgp', 'BGP'], ['ospf', 'OSPF'], ['eigrp', 'EIGRP']];
const since = (s) => {
  const v = Number(s);
  if (!Number.isFinite(v) || v <= 0) return DASH;
  if (v >= 86400) return `${Math.floor(v / 86400)} d`;
  if (v >= 3600) return `${Math.floor(v / 3600)} h`;
  return `${Math.floor(v / 60)} min`;
};

export default function CiscoRoutingPage() {
  const state = useCiscoGet(`${API}/routing`, 'Cisco routing peers');
  const [proto, setProto] = useState('all');
  const { data } = state;
  const t = data?.tiles || {};
  const rows = useMemo(() => (data?.rows || []).filter((r) => proto === 'all' || r.protocol === proto), [data, proto]);
  const ctl = useTableControls(rows, { searchKeys: ['device', 'peer', 'protocol', 'state'], defaultSortKey: 'flaps7d', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink: false });
  return (
    <AnalyticsFrame icon={RouteIcon} title="Routing" description="BGP, OSPF and EIGRP peers with state, uptime and flap counts. Peers on a dead device are shadowed by the device issue and not counted."
      state={state} empty={(data?.rows || []).length === 0} emptyText="No routing peers have been collected for Cisco devices yet.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Network} label="Peers" value={fmtNum(t.peers || 0)} />
        <StatCard icon={Network} label="Not established" value={fmtNum(t.notEstablished || 0)} tone={t.notEstablished ? 'crit' : 'ok'} />
        <StatCard icon={Repeat} label="Flapping (3+ in 7 d)" value={fmtNum(t.flapping || 0)} tone={t.flapping ? 'warn' : 'ok'} />
        <StatCard icon={EyeOff} label="Shadowed" value={fmtNum(t.shadowed || 0)} sub="device is dead" />
      </div>
      <SectionPanel title="Peers" blurb={data?.note}>
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {PROTOCOLS.map(([k, l]) => <button key={k} onClick={() => setProto(k)} className={chipBtn(proto === k)}>{l}</button>)}
          <TableSearch ctl={ctl} placeholder="Search device or peer..." />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <SortTh k="device" label="Device" ctl={ctl} /><SortTh k="protocol" label="Protocol" ctl={ctl} /><SortTh k="peer" label="Peer" ctl={ctl} />
              <SortTh k="state" label="State" ctl={ctl} /><SortTh k="establishedS" label="Up for" ctl={ctl} align="right" />
              <SortTh k="flaps7d" label="Flaps 7 d" ctl={ctl} align="right" /><SortTh k="flaps30d" label="Flaps 30 d" ctl={ctl} align="right" />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r, i) => (
                <tr key={`${r.device}-${r.peer}-${i}`} className={`border-b border-cohesity-border/50 ${r.shadowed ? 'opacity-55' : ''}`}>
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px] uppercase">{r.protocol}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px] font-mono">{r.peer}</td>
                  <td className="py-2 pr-3 text-[12px]">{r.shadowed ? <Chip>device dead</Chip> : <Chip tone={r.notEstablished ? 'crit' : 'ok'}>{r.state || 'unknown'}</Chip>}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{since(r.establishedS)}</td>
                  <td className={`py-2 pr-3 text-right tnum text-[12px] ${(r.flaps7d || 0) >= 3 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(r.flaps7d || 0)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.flaps30d || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePager ctl={ctl} />
      </SectionPanel>
    </AnalyticsFrame>
  );
}
