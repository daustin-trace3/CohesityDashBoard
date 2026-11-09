import { useMemo } from 'react';
import { Cpu, ShieldAlert, Layers, Flame, Repeat } from 'lucide-react';
import { StatCard } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, Chip, stateTone, fmt1 } from './ciscoKit';

const RANK = { failed: 0, degraded: 1, unknown: 2, ok: 3 };

export default function CiscoHardwarePage() {
  const state = useCiscoGet(`${API}/hardware`, 'Cisco hardware health');
  const { data } = state;
  const t = data?.tiles || {};
  const rows = useMemo(() => (data?.components || []).map((c) => ({ ...c, rank: RANK[c.state] ?? 2, flag: c.siteHvacSuspected ? 'Site HVAC suspected' : c.outlier ? 'Thermal outlier' : '' })), [data]);
  const ctl = useTableControls(rows, { searchKeys: ['device', 'site', 'model', 'component', 'instance', 'why'], defaultSortKey: 'rank', defaultSortDir: 'asc', paginate: true, defaultPageSize: 25, deepLink: false });
  const lost = data?.redundancyLost || [];
  const sw = data?.switchovers30d || [];

  return (
    <AnalyticsFrame icon={Cpu} title="Hardware Health" description="Power supplies, fans, temperature, line cards, supervisors and stack members across Cisco switches, worst first"
      state={state} empty={rows.length === 0 && lost.length === 0} emptyText="No hardware components have been collected for Cisco devices yet.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ShieldAlert} label="Components failed" value={fmtNum(t.componentsFailed || 0)} tone={t.componentsFailed ? 'crit' : 'ok'} />
        <StatCard icon={Layers} label="Redundancy lost" value={fmtNum(t.redundancyLost || 0)} tone={t.redundancyLost ? 'warn' : 'ok'} sub="one PSU or supervisor left, open ring" />
        <StatCard icon={Flame} label="Hot sensors" value={fmtNum(t.hotSensors || 0)} tone={t.hotSensors ? 'warn' : 'ok'} sub="above model or site peers" />
        <StatCard icon={Repeat} label="Switchovers (30 d)" value={fmtNum(t.switchovers30d || 0)} sub="stack role or supervisor changes" />
      </div>

      {lost.length > 0 && (
        <SectionPanel title="Redundancy lost" blurb="The device is up, but one more failure takes it down.">
          <ul className="text-[12px] text-ink-muted flex flex-col gap-1">
            {lost.map((l, i) => <li key={i}><span className="text-ink">{l.device}</span>{`: ${l.reason}`}</li>)}
          </ul>
        </SectionPanel>
      )}

      <div className="mt-4">
        <SectionPanel title="Components, worst first">
          <div className="flex items-center gap-2 mb-2">
            <TableSearch ctl={ctl} placeholder="Search device, site or component..." />
            <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} component(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="device" label="Device" ctl={ctl} /><SortTh k="site" label="Site" ctl={ctl} /><SortTh k="component" label="Component" ctl={ctl} />
                <SortTh k="rank" label="State" ctl={ctl} /><SortTh k="why" label="Why" ctl={ctl} /><SortTh k="value" label="Value" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={`${r.device}-${r.component}-${r.instance}-${i}`} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.site || DASH}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{`${String(r.component || '').replace('_', ' ')}${r.instance ? ` ${r.instance}` : ''}`}</td>
                    <td className="py-2 pr-3"><Chip tone={stateTone(r.state)}>{r.state}</Chip></td>
                    <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.why}{r.flag ? <Chip tone="warn">{r.flag}</Chip> : null}{r.redundancyNote ? <span className="text-ink-faint">{` (${r.redundancyNote})`}</span> : null}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{r.value == null ? DASH : `${fmt1(r.value)}${r.unit ? ` ${r.unit}` : ''}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </SectionPanel>
      </div>

      {sw.length > 0 && (
        <div className="mt-4">
          <SectionPanel title="Switchovers, last 90 days" blurb="Days on which a stack role, supervisor or failover state changed (from daily min and max).">
            <ul className="text-[12px] text-ink-muted flex flex-col gap-1">
              {sw.slice(0, 20).map((s, i) => <li key={i}><span className="text-ink">{s.device}</span>{` ${s.subject}: ${fmtNum(s.value ?? (s.detail?.events || []).length)} change(s) in 30 days`}</li>)}
            </ul>
          </SectionPanel>
        </div>
      )}
    </AnalyticsFrame>
  );
}
