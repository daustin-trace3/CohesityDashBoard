import { useEffect, useMemo, useState } from 'react';
import { Gauge, MemoryStick, HardDrive } from 'lucide-react';
import { StatCard } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, Modal, headRow } from '../logicmonitor/ui';
import { TrendLine } from '../logicmonitor/kit360';
import client from '../../api/client';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, Chip, ForecastCell, fmt1 } from './ciscoKit';

const pointsFrom = (list) => (list || []).map((p) => ({ epoch: Date.parse(p.day) / 1000, value: p.value }));

function ResourceDetail({ row, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    client.get(`${API}/resources`, { params: { deviceId: row.deviceId, sourceId: row.sourceId, days: 90 } })
      .then(({ data: d }) => setData(d || {})).catch(() => setData({}));
  }, [row]);
  const dev = data?.device || row;
  return (
    <Modal title={row.device} subtitle="CPU and memory, daily maximum over 90 days" onClose={onClose} width="max-w-3xl">
      <div className="grid md:grid-cols-2 gap-4">
        <SectionPanel title="CPU %"><TrendLine pct series={[{ label: 'Daily max CPU', points: pointsFrom(data?.series?.cpu) }]} empty={data ? 'No daily CPU history yet.' : 'Loading...'} /></SectionPanel>
        <SectionPanel title="Memory %"><TrendLine pct series={[{ label: 'Daily max memory', points: pointsFrom(data?.series?.mem) }]} empty={data ? 'No daily memory history yet.' : 'Loading...'} /></SectionPanel>
      </div>
      <div className="mt-3 text-[12px] text-ink-muted flex flex-col gap-1">
        <span>{`CPU forecast: ${dev.cpu?.forecast?.days != null ? `about ${Math.round(dev.cpu.forecast.days)} days to 80 percent` : 'no forecast'} (${dev.cpu?.forecast?.text || 'insufficient data'})`}</span>
        {dev.mem?.creepFlag && <span className="text-status-warn">{`Memory creep: ${dev.mem.creepText}`}</span>}
        {(dev.flash || []).map((f, i) => <span key={i}>{`Filesystem ${f.fs}: ${fmt1(f.usedPct, '%')} used, ${f.forecast?.days != null ? `about ${Math.round(f.forecast.days)} days to 95 percent` : 'no forecast'} (${f.forecast?.text})`}</span>)}
      </div>
    </Modal>
  );
}

export default function CiscoResourcesPage() {
  const state = useCiscoGet(`${API}/resources`, 'Cisco device resources', { params: { days: 90 } });
  const [open, setOpen] = useState(null);
  const { data } = state;
  const rows = useMemo(() => (data?.rows || []).map((r) => ({
    ...r, device: r.device || r.deviceName, cpuNow: r.cpu?.now, cpuP95: r.cpu?.p95, cpuSlope: r.cpu?.slope, cpuDays: r.cpu?.forecast?.days ?? 9999,
    memP95: r.mem?.p95, memSlope: r.mem?.slope, creep: r.mem?.creepFlag ? 1 : 0, flashDays: r.flashMinDays ?? 9999,
  })), [data]);
  const ctl = useTableControls(rows, { searchKeys: ['device', 'site'], defaultSortKey: 'cpuP95', defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink: false });
  const t = data?.tiles || {};
  return (
    <AnalyticsFrame icon={Gauge} title="Device Resources" description="CPU and memory over 90 days, memory creep and flash headroom per device. Forecasts are estimates and show their basis."
      state={state} empty={rows.length === 0} emptyText="No CPU or memory history has been collected for Cisco devices yet.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Gauge} label="Devices" value={fmtNum(rows.length)} />
        <StatCard icon={MemoryStick} label="Memory creep" value={fmtNum(t.creeping || 0)} tone={t.creeping ? 'warn' : 'ok'} sub="rising 14+ days, no reboot" />
        <StatCard icon={HardDrive} label="Flash within 90 d of full" value={fmtNum(t.flashRisk || 0)} tone={t.flashRisk ? 'warn' : 'ok'} />
      </div>
      <SectionPanel title="Fleet resources" blurb="A row opens the 90 day CPU and memory trend.">
        <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} placeholder="Search device or site..." /></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <SortTh k="device" label="Device" ctl={ctl} /><SortTh k="cpuP95" label="CPU p95" ctl={ctl} align="right" /><SortTh k="cpuSlope" label="CPU slope /d" ctl={ctl} align="right" />
              <SortTh k="cpuDays" label="Days to 80% CPU" ctl={ctl} /><SortTh k="memP95" label="Mem p95" ctl={ctl} align="right" /><SortTh k="memSlope" label="Mem slope /d" ctl={ctl} align="right" />
              <SortTh k="creep" label="Creep" ctl={ctl} /><SortTh k="flashDays" label="Flash to 95%" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r, i) => (
                <tr key={`${r.deviceId}-${i}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                  <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.cpuP95, '%')}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.cpuSlope)}</td>
                  <td className="py-2 pr-3"><ForecastCell f={r.cpu?.forecast} /></td>
                  <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.memP95, '%')}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.memSlope)}</td>
                  <td className="py-2 pr-3 text-[12px]">{r.mem?.creepFlag ? <Chip tone="warn">possible leak</Chip> : DASH}</td>
                  <td className="py-2 pr-3 text-[12px] text-ink-muted tnum">{r.flashMinDays == null ? DASH : `${Math.round(r.flashMinDays)} d`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePager ctl={ctl} />
      </SectionPanel>
      {open && <ResourceDetail row={open} onClose={() => setOpen(null)} />}
    </AnalyticsFrame>
  );
}
