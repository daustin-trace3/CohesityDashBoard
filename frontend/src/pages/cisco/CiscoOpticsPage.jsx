import { useEffect, useMemo, useState } from 'react';
import { Zap, AlertTriangle } from 'lucide-react';
import { StatCard } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, Modal, headRow, chipBtn } from '../logicmonitor/ui';
import { TrendLine } from '../logicmonitor/kit360';
import client from '../../api/client';
import { API, useCiscoGet } from './ciscoShared';
import { AnalyticsFrame, Chip, ForecastCell, fmt1, sevTone } from './ciscoKit';

const KINDS = ['all', 'rx_power', 'tx_power', 'temperature', 'bias', 'voltage'];

function OpticDetail({ row, onClose }) {
  const [pts, setPts] = useState(null);
  useEffect(() => {
    client.get(`${API}/trend-series`, { params: { sourceId: row.sourceId, deviceId: row.deviceId, metric: 'optic_value', instanceKey: row.instanceKey || row.ifName, days: 90, agg: 'min' } })
      .then(({ data }) => setPts((data?.points || []).map((p) => ({ epoch: Date.parse(p.day) / 1000, value: p.value }))))
      .catch(() => setPts([]));
  }, [row]);
  return (
    <Modal title={`${row.device} ${row.ifName}`} subtitle={`${row.sensorKind} sensor, daily minimum over 90 days`} onClose={onClose} width="max-w-2xl">
      <TrendLine series={[{ label: 'Daily minimum', points: pts || [] }]} empty={pts == null ? 'Loading...' : 'No daily history for this sensor yet.'} />
      <p className="text-[11px] text-ink-faint mt-2">{row.forecast?.text}</p>
    </Modal>
  );
}

export default function CiscoOpticsPage() {
  const state = useCiscoGet(`${API}/optics`, 'Cisco optics');
  const [kind, setKind] = useState('rx_power');
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => (state.data?.rows || []).filter((r) => kind === 'all' || r.sensorKind === kind).map((r) => ({ ...r, daysKey: r.forecast?.days ?? 9999, riskRank: r.atRisk ? 0 : 1 })), [state.data, kind]);
  const ctl = useTableControls(rows, { searchKeys: ['device', 'ifName', 'sensorKind', 'state'], defaultSortKey: 'riskRank', defaultSortDir: 'asc', paginate: true, defaultPageSize: 25, deepLink: false });
  const t = state.data?.tiles || {};
  return (
    <AnalyticsFrame icon={Zap} title="Optics" description="Transceiver power, temperature and margin to the low warning, with days until the margin runs out"
      state={state} empty={(state.data?.rows || []).length === 0} emptyText="No transceiver sensors have been collected for Cisco devices yet.">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={AlertTriangle} label="Optics at risk" value={fmtNum(t.atRisk || 0)} tone={t.atRisk ? 'warn' : 'ok'} sub="margin under 2 dB or falling" />
        <StatCard icon={Zap} label="Sensors" value={fmtNum(t.total || 0)} />
      </div>
      <SectionPanel title="Transceiver sensors" blurb="Margin is the sensor value minus its low warning threshold (Rx power, dB). The forecast is an estimate and shows its basis.">
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {KINDS.map((k) => <button key={k} onClick={() => setKind(k)} className={chipBtn(kind === k)}>{k === 'all' ? 'All' : k.replace('_', ' ')}</button>)}
          <TableSearch ctl={ctl} placeholder="Search device or interface..." />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <SortTh k="device" label="Device" ctl={ctl} /><SortTh k="ifName" label="Interface" ctl={ctl} /><SortTh k="sensorKind" label="Kind" ctl={ctl} />
              <SortTh k="value" label="Value" ctl={ctl} align="right" /><SortTh k="lowWarn" label="Low warn" ctl={ctl} align="right" /><SortTh k="marginDb" label="Margin dB" ctl={ctl} align="right" />
              <SortTh k="daysKey" label="Days to low warning" ctl={ctl} /><SortTh k="state" label="State" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r, i) => (
                <tr key={`${r.device}-${r.ifName}-${r.sensorKind}-${i}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                  <td className="py-2 pr-3 text-ink text-[12px]">{r.device}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.ifName || DASH}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[12px]">{String(r.sensorKind || '').replace('_', ' ')}</td>
                  <td className="py-2 pr-3 text-right tnum text-[12px]">{fmt1(r.value)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmt1(r.lowWarn)}</td>
                  <td className={`py-2 pr-3 text-right tnum text-[12px] ${r.atRisk ? 'text-status-warn' : 'text-ink-muted'}`}>{fmt1(r.marginDb)}</td>
                  <td className="py-2 pr-3"><ForecastCell f={r.forecast} /></td>
                  <td className="py-2 pr-3"><Chip tone={r.atRisk ? sevTone(r.trend?.severity || 'warning') : 'ok'}>{r.atRisk ? 'at risk' : (r.state || 'ok')}</Chip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <TablePager ctl={ctl} />
      </SectionPanel>
      {open && <OpticDetail row={open} onClose={() => setOpen(null)} />}
    </AnalyticsFrame>
  );
}
