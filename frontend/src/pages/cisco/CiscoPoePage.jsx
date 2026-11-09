import { useMemo } from 'react';
import { PlugZap } from 'lucide-react';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, ForecastCell, fmt1 } from './ciscoKit';

export default function CiscoPoePage() {
  const state = useCiscoGet(`${API}/poe`, 'Cisco PoE budget');
  const rows = useMemo(() => (state.data?.rows || []).map((r) => ({ ...r, daysKey: r.forecast?.days ?? 9999 })), [state.data]);
  const sites = state.data?.sites || [];
  const ctl = useTableControls(rows, { searchKeys: ['device', 'member', 'site'], defaultSortKey: 'usedPct', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink: false });
  return (
    <AnalyticsFrame icon={PlugZap} title="PoE Budget" description="Power over Ethernet draw against budget per switch or stack member, with days until 90 percent of budget"
      state={state} empty={rows.length === 0} emptyText="No PoE data has been collected for Cisco switches yet.">
      {sites.length > 0 && (
        <SectionPanel title="Headroom by site" blurb="Spare watts before an access point or phone refresh.">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border"><th className="py-2 pr-3">Site</th><th className="py-2 pr-3 text-right">Switches</th><th className="py-2 pr-3 text-right">Headroom W</th></tr></thead>
              <tbody>
                {sites.map((s, i) => (
                  <tr key={`${s.site}-${i}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink text-[12px]">{s.site || DASH}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(s.devices)}</td>
                    <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(s.headroomWatts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionPanel>
      )}
      <div className={sites.length ? 'mt-4' : ''}>
        <SectionPanel title="Switches and stack members">
          <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} placeholder="Search switch or member..." /></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="device" label="Switch" ctl={ctl} /><SortTh k="member" label="Member" ctl={ctl} /><SortTh k="usedWatts" label="Used W" ctl={ctl} align="right" />
                <SortTh k="budgetWatts" label="Budget W" ctl={ctl} align="right" /><SortTh k="usedPct" label="Used %" ctl={ctl} align="right" />
                <SortTh k="headroomWatts" label="Headroom W" ctl={ctl} align="right" /><SortTh k="daysKey" label="Days to 90%" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={`${r.device}-${r.member}-${i}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.member ?? DASH}</td>
                    <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.usedWatts)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.budgetWatts)}</td>
                    <td className={`py-2 pr-3 text-right tnum text-[12px] ${Number(r.usedPct) >= 85 ? 'text-status-warn' : 'text-ink-muted'}`}>{fmt1(r.usedPct, '%')}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.headroomWatts)}</td>
                    <td className="py-2 pr-3"><ForecastCell f={r.forecast} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </SectionPanel>
      </div>
    </AnalyticsFrame>
  );
}
