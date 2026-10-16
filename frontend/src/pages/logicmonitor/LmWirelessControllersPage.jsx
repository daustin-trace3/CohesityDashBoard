import { useEffect, useState, useCallback, useMemo } from 'react';
import { RadioTower, Download, WifiOff, ShieldAlert, Users } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { BRAND, DASH, arr, fmtNum, fmtPct, stateTone, stateLabel, stateRank, downloadCsv, useVisibleInterval } from './helpers';
import { UtilBar, headRow } from './ui';
import LmWlc360 from './LmWlc360';
import { WL_EMPTY } from './wirelessShared';

const REFRESH_MS = 60000;

export default function LmWirelessControllersPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(() => client.get('/logicmonitor/wireless/controllers')
    .then(({ data }) => { setRows(arr(data)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load wireless controllers' }); }), [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => (rows || []).map((r) => ({ ...r, siteLabel: r.siteName || r.siteKey || '', stateRank: stateRank(r.state) })), [rows]);
  const ctl = useTableControls(all, { searchKeys: ['deviceName', 'siteLabel', 'model', 'platform', 'version'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true });
  const tiles = useMemo(() => ({
    degraded: all.filter((r) => stateTone(r.state) === 'crit' || stateTone(r.state) === 'warn').length,
    apsDown: all.reduce((n, r) => n + (r.apsDown || 0), 0),
    aps: all.reduce((n, r) => n + (r.apsTotal || 0), 0),
    clients: all.some((r) => r.clients != null) ? all.reduce((n, r) => n + (r.clients || 0), 0) : null,
  }), [all]);

  const exportCsv = async () => {
    setExporting(true);
    try { await downloadCsv('/logicmonitor/wireless/controllers.csv', ctl.q.trim() ? { q: ctl.q.trim() } : {}, 'logicmonitor-wireless-controllers'); } catch { toast({ type: 'error', title: 'Export failed' }); } finally { setExporting(false); }
  };
  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={RadioTower} title="Wireless Controllers" description="Cisco AireOS and Catalyst 9800 controllers with HA, AP and radio health, clients and RADIUS">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={RadioTower} label="Controllers" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={ShieldAlert} label="With issues" value={fmtNum(tiles.degraded)} tone={tiles.degraded ? 'warn' : 'ok'} loading={rows == null} />
        <StatCard icon={WifiOff} label="APs down" value={fmtNum(tiles.apsDown)} sub={`of ${fmtNum(tiles.aps)} APs`} tone={tiles.apsDown ? 'crit' : 'ok'} loading={rows == null} />
        <StatCard icon={Users} label="Clients" value={fmtNum(tiles.clients)} loading={rows == null} />
      </div>
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search controller, site, model or version..." />
          <FilterSelect ctl={ctl} k="siteLabel" rows={all} label="sites" />
          <FilterSelect ctl={ctl} k="platform" rows={all} label="platforms" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} controller(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>
        {rows == null ? <LoadingPanel label="Loading controllers..." height={200} /> : all.length === 0 ? <p className="text-sm text-ink-muted py-6 text-center">{WL_EMPTY}</p> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="deviceName" label="Controller" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="platform" label="Platform" ctl={ctl} />
                  <SortTh k="haText" label="HA" ctl={ctl} />
                  <SortTh k="apsDown" label="APs up / total" ctl={ctl} align="right" />
                  <SortTh k="radiosDown" label="Radios up / total" ctl={ctl} align="right" />
                  <SortTh k="clients" label="Clients" ctl={ctl} align="right" />
                  <SortTh k="avgChannelUtilPct" label="Avg channel util" ctl={ctl} />
                  <SortTh k="hotRadios" label="Hot radios" ctl={ctl} align="right" />
                  <SortTh k="cpuPct" label="CPU" ctl={ctl} align="right" />
                  <SortTh k="radiusUnresponsive" label="RADIUS" ctl={ctl} />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.deviceId}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay text-[12px]" onClick={() => setOpen(r)}>
                      <td className="py-2 pr-3 text-ink">{r.deviceName}</td>
                      <td className="py-2 pr-3 text-ink-muted">{r.siteLabel || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted whitespace-nowrap" title={[r.model, r.version].filter(Boolean).join(' ')}>{r.platform || DASH}</td>
                      <td className="py-2 pr-3">{r.haText ? <Badge tone={r.haDegraded ? 'crit' : 'info'}>{r.haText}</Badge> : <span className="text-ink-faint">{DASH}</span>}</td>
                      <td className={`py-2 pr-3 text-right tnum ${r.apsDown ? 'text-status-crit' : 'text-ink-muted'}`}>{r.apsTotal ? `${fmtNum(r.apsUp)} / ${fmtNum(r.apsTotal)}` : DASH}</td>
                      <td className={`py-2 pr-3 text-right tnum ${r.radiosDown ? 'text-status-warn' : 'text-ink-muted'}`}>{r.radiosTotal ? `${fmtNum(r.radiosUp)} / ${fmtNum(r.radiosTotal)}` : DASH}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clients)}</td>
                      <td className="py-2 pr-3 min-w-[120px]"><UtilBar pct={r.avgChannelUtilPct} /></td>
                      <td className={`py-2 pr-3 text-right tnum ${r.hotRadios ? 'text-status-warn' : 'text-ink-muted'}`}>{fmtNum(r.hotRadios)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtPct(r.cpuPct)}</td>
                      <td className="py-2 pr-3">{!r.radiusServers ? <span className="text-ink-faint">{DASH}</span> : <Badge tone={r.radiusUnresponsive ? 'warn' : 'ok'}>{r.radiusUnresponsive ? `${r.radiusUnresponsive} unresponsive` : `${r.radiusServers} ok`}</Badge>}</td>
                      <td className="py-2 pr-3"><Badge tone={stateTone(r.state)}>{stateLabel(r.state)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>
      {open && <LmWlc360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
