import { useMemo, useState } from 'react';
import { Cable } from 'lucide-react';
import { PageHeader, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, Tabs, headRow } from '../logicmonitor/ui';
import LmInterfacesPage from '../logicmonitor/LmInterfacesPage';
import { API, useCiscoGet } from './ciscoShared';
import { Chip, ForecastCell, fmt1 } from './ciscoKit';

const TABS = [{ key: 'all', label: 'All interfaces' }, { key: 'hot', label: 'Hot' }, { key: 'flapping', label: 'Flapping' }, { key: 'errors', label: 'Errors' }];

const COLS = {
  hot: [['device', 'Device'], ['ifName', 'Interface'], ['p95InUtil', 'p95 in %', 'r'], ['maxInUtil', 'Max in %', 'r'], ['p95OutUtil', 'p95 out %', 'r'], ['maxOutUtil', 'Max out %', 'r'], ['daysIn', 'Days to 80% in'], ['daysOut', 'Days to 80% out']],
  flapping: [['device', 'Device'], ['ifName', 'Interface'], ['flaps', 'Flaps', 'r'], ['downSamples', 'Down samples', 'r'], ['samples', 'Samples', 'r']],
  errors: [['device', 'Device'], ['ifName', 'Interface'], ['errorsSum', 'Errors', 'r'], ['discardsSum', 'Discards', 'r'], ['baselineMedian', 'Baseline median', 'r'], ['baselineMad', 'Baseline MAD', 'r'], ['deviates', 'Vs baseline']],
};

function AnalyticsTab({ tab, days }) {
  const { data, error, loading } = useCiscoGet(`${API}/interfaces-analytics`, `${tab} interfaces`, { params: { tab, days, limit: 100 } });
  const rows = useMemo(() => (data?.rows || []).map((r) => ({ ...r, daysIn: r.forecastIn?.days ?? 9999, daysOut: r.forecastOut?.days ?? 9999 })), [data]);
  const sortKey = tab === 'hot' ? 'p95InUtil' : tab === 'flapping' ? 'flaps' : 'errorsSum';
  const ctl = useTableControls(rows, { searchKeys: ['device', 'ifName'], defaultSortKey: sortKey, defaultSortDir: 'desc', paginate: true, defaultPageSize: 25, deepLink: false });
  const cols = COLS[tab];
  const blurb = tab === 'hot' ? `Top interfaces by p95 and peak utilization over ${days} days. Days to 80 percent are estimates from the daily peak trend and show their basis.`
    : tab === 'flapping' ? `Interfaces ordered by flaps and down samples over ${days} days.`
      : `Errors and discards over ${days} days against each interface's own hour-of-day baseline (median plus 3 MAD).`;
  if (loading) return <LoadingPanel label="Loading interfaces..." height={160} />;
  if (error) return <p className="text-sm text-status-crit">{error}</p>;
  if (data?.available === false) return <div className="panel p-6 text-sm text-ink-muted text-center">The LogicMonitor connector does not provide interface analytics yet.</div>;
  return (
    <SectionPanel title={TABS.find((t) => t.key === tab).label} blurb={blurb}>
      {rows.length === 0 ? <p className="text-[12px] text-ink-muted py-4 text-center">No interfaces match this view.</p> : (
        <>
          <div className="flex items-center gap-2 mb-2"><TableSearch ctl={ctl} placeholder="Search device or interface..." /><span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} interface(s)</span></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>{cols.map(([k, l, a]) => <SortTh key={k} k={k} label={l} ctl={ctl} align={a === 'r' ? 'right' : 'left'} />)}</tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={`${r.device}-${r.ifName}-${i}`} className="border-b border-cohesity-border/50">
                    {cols.map(([k, , a]) => {
                      let cell;
                      if (k === 'daysIn') cell = <ForecastCell f={r.forecastIn} />;
                      else if (k === 'daysOut') cell = <ForecastCell f={r.forecastOut} />;
                      else if (k === 'deviates') cell = <Chip tone={r.deviates ? 'warn' : 'ok'}>{r.deviates ? 'above baseline' : 'normal'}</Chip>;
                      else if (/Util$/.test(k)) cell = fmt1(r[k], '%');
                      else if (typeof r[k] === 'number') cell = fmtNum(Math.round(r[k] * 100) / 100);
                      else cell = r[k] ?? DASH;
                      return <td key={k} className={`py-2 pr-3 text-[12px] ${a === 'r' ? 'text-right tnum text-ink-muted' : k === 'device' ? 'text-ink' : 'text-ink-muted'}`}>{cell}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </SectionPanel>
  );
}

export default function CiscoInterfacesPage() {
  const [tab, setTab] = useState('all');
  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cable} title="Interfaces" description="Status and utilization for every Cisco and Meraki interface, plus hot, flapping and error views from the daily rollups" />
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      {tab === 'all' ? <LmInterfacesPage apiBase={API} bare /> : <AnalyticsTab key={tab} tab={tab} days={7} />}
    </div>
  );
}
