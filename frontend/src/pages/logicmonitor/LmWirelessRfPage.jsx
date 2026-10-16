import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Radio, Download, Flame, RadioTower, Users } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { BRAND, DASH, arr, fmtNum, fmtPct, downloadCsv, useVisibleInterval } from './helpers';
import { SectionPanel, UtilBar, headRow, chipBtn } from './ui';
import { BAND_COLOR, BarChart, RadioStateBadge, ProfileBadge, WL_EMPTY } from './wirelessShared';
import LmAp360 from './LmAp360';

const REFRESH_MS = 120000;
const PROFILES = [['load', 'Load'], ['noise', 'Noise'], ['interference', 'Interference'], ['coverage', 'Coverage']];

export default function LmWirelessRfPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const view = searchParams.get('view') || '';

  const load = useCallback(() => client.get('/logicmonitor/wireless/rf')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || {}); toast({ type: 'error', title: 'Failed to load RF analytics' }); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const bands = arr(data?.bands);
  const radios = useMemo(() => arr(data?.radios).map((r) => ({
    ...r,
    profileFails: PROFILES.filter(([k]) => r[`${k}Profile`] === 'fail').length,
  })), [data]);
  const list = useMemo(() => radios.filter((r) => {
    if (view === 'hot') return r.hot;
    if (view === 'down') return r.state === 'down';
    if (view === 'rrm') return r.profileFails > 0;
    return true;
  }), [radios, view]);
  const ctl = useTableControls(list, { searchKeys: ['radio', 'ap', 'controller', 'band'], defaultSortKey: 'channelUtilPct', defaultSortDir: 'desc', paginate: true });

  const histLabels = useMemo(() => arr(bands[0]?.utilHistogram).map((h) => h.bucket), [bands]);
  const histSeries = useMemo(() => bands.map((b) => ({ label: b.band, data: arr(b.utilHistogram).map((h) => h.count), color: BAND_COLOR[b.band] })), [bands]);
  const powerLevels = useMemo(() => [...new Set(bands.flatMap((b) => arr(b.txPower).map((p) => p.level)))].sort((a, b) => a - b), [bands]);
  const powerSeries = useMemo(() => bands.map((b) => ({
    label: b.band, color: BAND_COLOR[b.band], data: powerLevels.map((l) => arr(b.txPower).find((p) => p.level === l)?.count || 0),
  })), [bands, powerLevels]);
  const totals = useMemo(() => ({
    radios: bands.reduce((n, b) => n + b.radios, 0),
    hot: bands.reduce((n, b) => n + b.hot, 0),
    down: bands.reduce((n, b) => n + b.down, 0),
    clients: bands.some((b) => b.clients != null) ? bands.reduce((n, b) => n + (b.clients || 0), 0) : null,
  }), [bands]);

  const setView = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('view', v); else next.delete('view');
    setSearchParams(next, { replace: true });
  };
  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/wireless/rf.csv', {}, 'logicmonitor-wireless-radios'); } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };
  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50 ml-auto';
  const thr = data?.thresholdPct;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Radio} title="RF Analytics" description="Channel utilization, client load, transmit power and RRM verdicts per band, across every AP radio">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      {data == null ? <LoadingPanel label="Loading RF analytics..." height={240} /> : bands.length === 0 ? <div className="panel p-6 text-sm text-ink-muted text-center">{WL_EMPTY}</div> : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={RadioTower} label="Radios" value={fmtNum(totals.radios)} />
            <StatCard icon={Flame} label={`At or above ${thr}% util`} value={fmtNum(totals.hot)} tone={totals.hot ? 'warn' : 'ok'} onClick={() => setView('hot')} />
            <StatCard icon={Radio} label="Enabled but down" value={fmtNum(totals.down)} tone={totals.down ? 'crit' : 'ok'} onClick={() => setView('down')} />
            <StatCard icon={Users} label="Clients on radios" value={fmtNum(totals.clients)} />
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            {bands.map((b) => (
              <div key={b.band} className="panel p-4" style={{ borderTop: `3px solid ${BAND_COLOR[b.band] || BRAND}` }}>
                <p className="text-sm font-semibold text-ink mb-2">{b.band}</p>
                <div className="grid grid-cols-3 gap-2 text-[12px] mb-3">
                  <div><p className="text-[10px] uppercase text-ink-faint">Radios up</p><p className="tnum text-ink">{`${fmtNum(b.up)} / ${fmtNum(b.radios)}`}</p></div>
                  <div><p className="text-[10px] uppercase text-ink-faint">Clients</p><p className="tnum text-ink">{fmtNum(b.clients)}</p></div>
                  <div><p className="text-[10px] uppercase text-ink-faint">Hot</p><p className={`tnum ${b.hot ? 'text-status-warn' : 'text-ink'}`}>{fmtNum(b.hot)}</p></div>
                </div>
                <p className="text-[10px] uppercase text-ink-faint mb-1">Avg channel / rx / tx utilization</p>
                <UtilBar pct={b.avgChannelUtilPct} />
                <p className="text-[11px] text-ink-muted tnum mt-1">{`Rx ${fmtPct(b.avgRxUtilPct)}, Tx ${fmtPct(b.avgTxUtilPct)}`}</p>
                <p className="text-[10px] uppercase text-ink-faint mt-3 mb-1">RRM profile failures</p>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {PROFILES.map(([k, l]) => <span key={k} className={b.profileFailures?.[k] ? 'text-status-warn' : 'text-ink-muted'}>{`${l} ${fmtNum(b.profileFailures?.[k] ?? 0)}`}</span>)}
                </div>
              </div>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Channel utilization distribution" blurb="Radios that are up, by channel utilization bucket. A right-heavy band is congested; consider more APs, narrower channels or band steering.">
              <BarChart labels={histLabels} series={histSeries} height={200} />
            </SectionPanel>
            <SectionPanel title="Transmit power levels" blurb="Cisco power level 1 is the maximum; higher numbers are lower power. Many radios at level 1 suggests coverage holes; many at the lowest levels suggests dense AP placement.">
              <BarChart labels={powerLevels.map((l) => `Level ${l}`)} series={powerSeries} height={200} />
            </SectionPanel>
          </div>

          <SectionPanel title="Radios">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {[['', 'All'], ['hot', 'Hot'], ['down', 'Down'], ['rrm', 'RRM failing']].map(([v, l]) => <button key={v || 'all'} onClick={() => setView(v)} className={chipBtn(view === v)}>{l}</button>)}
              <TableSearch ctl={ctl} placeholder="Search radio, AP or controller..." />
              <FilterSelect ctl={ctl} k="band" rows={list} label="bands" />
              <FilterSelect ctl={ctl} k="controller" rows={list} label="controllers" />
              <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} radio(s)</span>
              <button onClick={exportCsv} disabled={exporting} className={btn}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="radio" label="Radio" ctl={ctl} />
                  <SortTh k="band" label="Band" ctl={ctl} />
                  <SortTh k="controller" label="Controller" ctl={ctl} />
                  <SortTh k="state" label="State" ctl={ctl} />
                  <SortTh k="channelUtilPct" label="Channel util" ctl={ctl} />
                  <SortTh k="rxUtilPct" label="Rx / Tx" ctl={ctl} align="right" />
                  <SortTh k="clients" label="Clients" ctl={ctl} align="right" />
                  <SortTh k="txPowerLevel" label="Tx power" ctl={ctl} align="right" />
                  <SortTh k="noiseProfile" label="Noise" ctl={ctl} />
                  <SortTh k="interferenceProfile" label="Interference" ctl={ctl} />
                  <SortTh k="coverageProfile" label="Coverage" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.controllerId}-${r.radio}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay text-[12px]"
                      onClick={() => setOpen({ controllerId: r.controllerId, sourceId: r.sourceId, apKey: r.ap })}>
                      <td className="py-2 pr-3 text-ink">{r.radio}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.band}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.controller}</td>
                      <td className="py-2 pr-3"><RadioStateBadge state={r.state} /></td>
                      <td className="py-2 pr-3 min-w-[120px]"><UtilBar pct={r.channelUtilPct} /></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted whitespace-nowrap">{`${fmtPct(r.rxUtilPct)} / ${fmtPct(r.txUtilPct)}`}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clients)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.txPowerLevel ?? DASH}</td>
                      <td className="py-2 pr-3"><ProfileBadge v={r.noiseProfile} /></td>
                      <td className="py-2 pr-3"><ProfileBadge v={r.interferenceProfile} /></td>
                      <td className="py-2 pr-3"><ProfileBadge v={r.coverageProfile} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </SectionPanel>
        </div>
      )}
      {open && <LmAp360 controllerId={open.controllerId} sourceId={open.sourceId} apKey={open.apKey} onClose={() => setOpen(null)} />}
    </div>
  );
}
