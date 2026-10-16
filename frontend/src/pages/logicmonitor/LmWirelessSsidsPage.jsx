import { useEffect, useState, useCallback, useMemo } from 'react';
import { Users, Wifi, RadioTower } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { DASH, PALETTE, arr, fmtNum, useVisibleInterval } from './helpers';
import { SectionPanel, headRow } from './ui';
import { TrendLine } from './LmFirewall360';
import { ShareBars, WL_EMPTY } from './wirelessShared';

const REFRESH_MS = 120000;
const yesNo = (v, on = 'Yes', off = 'No') => (v == null ? <span className="text-ink-faint">{DASH}</span> : <Badge tone={v ? 'ok' : 'neutral'}>{v ? on : off}</Badge>);

export default function LmWirelessSsidsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/wireless/ssids')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || {}); toast({ type: 'error', title: 'Failed to load SSIDs' }); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const summary = arr(data?.summary);
  const rows = useMemo(() => arr(data?.rows).map((r) => ({ ...r, siteLabel: r.siteName || r.siteKey || '' })), [data]);
  const ctl = useTableControls(rows, { searchKeys: ['ssid', 'controller', 'siteLabel', 'wlan'], defaultSortKey: 'clients', defaultSortDir: 'desc', paginate: true });
  const total = summary.some((s) => s.clients != null) ? summary.reduce((n, s) => n + (s.clients || 0), 0) : null;
  const series = useMemo(() => arr(data?.trend?.bySsid).map((s, i) => ({ label: s.ssid, points: s.points, color: PALETTE[i % PALETTE.length] })), [data]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Users} title="SSIDs and Clients" description="Client counts per WLAN across every controller, with 24 hour trends">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      {data == null ? <LoadingPanel label="Loading SSIDs..." height={240} /> : summary.length === 0 ? <div className="panel p-6 text-sm text-ink-muted text-center">{WL_EMPTY}</div> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatCard icon={Wifi} label="SSIDs" value={fmtNum(summary.length)} />
            <StatCard icon={Users} label="Clients" value={fmtNum(total)} />
            <StatCard icon={RadioTower} label="WLAN instances" value={fmtNum(rows.length)} sub="SSID x controller" />
          </div>
          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Clients, 24 hours" blurb="All WLANs summed, 30 minute buckets.">
              <TrendLine series={[{ label: 'Clients', points: data?.trend?.total }]} empty="No client history yet; it builds as the metrics tier runs." />
            </SectionPanel>
            <SectionPanel title="Busiest SSIDs, 24 hours">
              <TrendLine series={series} empty="No client history yet; it builds as the metrics tier runs." />
            </SectionPanel>
          </div>
          <SectionPanel title="Clients by SSID" blurb="Summed across the controllers that serve each SSID.">
            <ShareBars rows={summary.map((s) => ({ label: s.ssid, value: s.clients, sub: `${s.controllers} controller(s)` }))} />
          </SectionPanel>
          <SectionPanel title="WLANs per controller">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <TableSearch ctl={ctl} placeholder="Search SSID, controller or site..." />
              <FilterSelect ctl={ctl} k="ssid" rows={rows} label="SSIDs" />
              <FilterSelect ctl={ctl} k="controller" rows={rows} label="controllers" />
              <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} WLAN(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="ssid" label="SSID" ctl={ctl} />
                  <SortTh k="wlan" label="WLAN" ctl={ctl} />
                  <SortTh k="controller" label="Controller" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="enabled" label="Enabled" ctl={ctl} />
                  <SortTh k="broadcast" label="Broadcast" ctl={ctl} />
                  <SortTh k="clients" label="Clients" ctl={ctl} align="right" />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.controllerId}-${r.wlan}`} className="border-b border-cohesity-border/50 text-[12px]">
                      <td className="py-2 pr-3 text-ink">{r.ssid}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.wlan}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.controller}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.siteLabel || DASH}</td>
                      <td className="py-2 pr-3">{yesNo(r.enabled, 'Enabled', 'Disabled')}</td>
                      <td className="py-2 pr-3">{yesNo(r.broadcast, 'Broadcast', 'Hidden')}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clients)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </SectionPanel>
          <p className="text-[11px] text-ink-faint">SSID names come from the WLAN instance descriptions in LogicMonitor; a WLAN without one shows as "WLAN: n".</p>
        </div>
      )}
    </div>
  );
}
