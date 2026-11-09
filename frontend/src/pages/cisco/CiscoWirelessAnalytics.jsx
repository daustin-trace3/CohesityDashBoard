import { useMemo } from 'react';
import { SectionPanel } from '../logicmonitor/ui';
import { AutoTable, TrendLine } from '../logicmonitor/kit360';
import { API, useCiscoGet } from './ciscoShared';

// Added under the wireless overview for Cisco only. Renders nothing until the analytics route answers
// with data, so a connector without the feed leaves the LogicMonitor wireless page exactly as it was.
const pts = (list) => (Array.isArray(list) ? list : []).map((p) => ({ epoch: Date.parse(p.day) / 1000, value: p.value }));

export default function CiscoWirelessAnalytics() {
  const { data, error } = useCiscoGet(`${API}/wireless-analytics`, 'wireless analytics', { params: { days: 30 }, interval: 300000 });
  const imbalance = useMemo(() => (data?.apLoadImbalance || []).map((r) => ({
    controller: r.controller, site: r.site, apCount: r.apCount, cv: r.cv == null ? null : Math.round(Number(r.cv) * 100) / 100,
    zeroClientAps: Array.isArray(r.zeroClientAps7d) ? r.zeroClientAps7d.length : (r.zeroClientAps7d ?? null),
  })), [data]);
  const bands = data?.channelUtilTrend || [];
  const radius = data?.radiusFailureRatio || [];
  const any = imbalance.length || bands.length || radius.length;
  if (error || !data || data.available === false || !any) return null;
  return (
    <div className="mt-4 flex flex-col gap-4">
      {imbalance.length > 0 && (
        <SectionPanel title="AP load imbalance" blurb="Coefficient of variation of client counts across the APs of each controller and site. APs with no clients for 7 days are counted as possible dead zones or misplaced APs.">
          <AutoTable rows={imbalance} preferred={['controller', 'site', 'apCount', 'cv', 'zeroClientAps']} />
        </SectionPanel>
      )}
      {bands.length > 0 && (
        <SectionPanel title="Channel utilization, 30 days" blurb="Daily peak channel utilization per band.">
          <TrendLine pct series={bands.map((b) => ({ label: `${b.band} GHz`, points: pts(b.points) }))} />
        </SectionPanel>
      )}
      {radius.length > 0 && (
        <SectionPanel title="RADIUS failure ratio, 30 days" blurb="Authentication failures divided by requests per server, daily.">
          <TrendLine series={radius.map((r) => ({ label: r.server, points: pts(r.points) }))} />
        </SectionPanel>
      )}
    </div>
  );
}
