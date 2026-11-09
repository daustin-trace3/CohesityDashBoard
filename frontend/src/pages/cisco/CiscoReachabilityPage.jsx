import { Radar, Clock, TimerOff } from 'lucide-react';
import { StatCard } from '../../components/ui/primitives';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { AutoTable } from '../logicmonitor/kit360';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, Chip, fmt1 } from './ciscoKit';

const Table = ({ head, children }) => (
  <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr className={headRow}>{head.map((h, i) => <th key={h} className={`py-2 pr-3 ${i > 1 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>
);

export default function CiscoReachabilityPage() {
  const state = useCiscoGet(`${API}/reachability`, 'Cisco reachability', { params: { days: 30, limit: 20 } });
  const { data } = state;
  const ping = data?.ping || [];
  const siteRtt = data?.siteRtt || [];
  const ntp = data?.ntp || [];
  const ipsla = data?.ipsla || [];
  const nt = data?.ntpTiles || {};
  const strata = Object.entries(nt.strata || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return (
    <AnalyticsFrame icon={Radar} title="Reachability and Time" description="Ping loss and latency, IP SLA probes and NTP hygiene across Cisco devices"
      state={state} empty={ping.length === 0 && ntp.length === 0 && ipsla.length === 0} emptyText="No Ping, IP SLA or NTP data has been collected for Cisco devices yet.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Radar} label="Devices with ping loss" value={fmtNum(ping.filter((p) => Number(p.lossPct) > 0).length)} tone={ping.some((p) => Number(p.lossPct) > 0) ? 'warn' : 'ok'} sub={`worst ${data?.pingTotal ? Math.min(20, data.pingTotal) : 0} shown`} />
        <StatCard icon={TimerOff} label="NTP unsynced" value={fmtNum(nt.unsynced || 0)} tone={nt.unsynced ? 'crit' : 'ok'} />
        <StatCard icon={Clock} label="NTP offset over 100 ms" value={fmtNum(nt.outliers || 0)} tone={nt.outliers ? 'warn' : 'ok'} />
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <SectionPanel title="Ping, worst first" blurb="Loss then latency over the last 30 days.">
          {ping.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No Ping data collected.</p> : (
            <Table head={['Device', 'Site', 'Loss %', 'RTT ms']}>
              {ping.map((r, i) => (
                <tr key={`${r.device}-${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.site || DASH}</td>
                  <td className={`py-2 pr-3 text-right tnum text-[12px] ${Number(r.lossPct) > 0 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmt1(r.lossPct)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.rttMs)}</td>
                </tr>
              ))}
            </Table>
          )}
        </SectionPanel>
        <SectionPanel title="Latency by site" blurb="Distribution of device ping RTT per site.">
          {siteRtt.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No RTT samples to group by site.</p> : (
            <Table head={['Site', 'Devices', 'p50 ms', 'p95 ms', 'Max ms']}>
              {siteRtt.map((r) => (
                <tr key={r.site} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.site}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.devices)}</td>
                  <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.p50Ms)}</td>
                  <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.p95Ms)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.maxMs)}</td>
                </tr>
              ))}
            </Table>
          )}
        </SectionPanel>
      </div>

      <div className="mt-4">
        <SectionPanel title="IP SLA probes" blurb="The same watch and baseline rows the LogicMonitor Site Reachability page uses, filtered to Cisco probes.">
          <AutoTable rows={ipsla} empty="No IP SLA probes are collected for Cisco devices." preferred={['device', 'probe', 'name', 'state', 'rttMs', 'lossPct', 'mos']} />
        </SectionPanel>
      </div>

      <div className="mt-4">
        <SectionPanel title="NTP hygiene" blurb="Unsynced clocks first, then the largest offsets. Offsets over 100 ms are flagged.">
          {strata.length > 0 && <p className="text-[11px] text-ink-faint mb-2">{`Stratum distribution: ${strata.map(([k, v]) => `${k}: ${v}`).join(', ')}`}</p>}
          {ntp.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No NTP data collected.</p> : (
            <Table head={['Device', 'Synced', 'Stratum', 'Offset ms']}>
              {ntp.map((r, i) => (
                <tr key={`${r.device}-${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                  <td className="py-2 pr-3 text-[12px]"><Chip tone={r.synced === false ? 'crit' : 'ok'}>{r.synced === false ? 'unsynced' : 'synced'}</Chip></td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{r.stratum ?? DASH}</td>
                  <td className={`py-2 pr-3 text-right tnum text-[12px] ${r.outlier ? 'text-status-warn' : 'text-ink-muted'}`}>{fmt1(r.offsetMs)}{r.outlier ? ' (outlier)' : ''}</td>
                </tr>
              ))}
            </Table>
          )}
        </SectionPanel>
      </div>
    </AnalyticsFrame>
  );
}
