import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldCheck, Download, ShieldAlert, AlertTriangle, Waypoints, FileWarning } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, DASH, arr, fmtNum, stateTone, stateLabel, stateRank, downloadCsv, useVisibleInterval,
} from './helpers';
import { UtilBar, PctValue, pctInRange, headRow, chipBtn } from './ui';
import LmFirewall360, { syncedOf, num } from './LmFirewall360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };

export default function LmFirewallsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/firewalls')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load firewalls' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => (rows || []).map((r) => ({
    ...r,
    siteLabel: r.siteName || r.siteKey || '',
    stateRank: stateRank(r.state),
    tunnelsTotal: (num(r.tunnelsUp) ?? 0) + (num(r.tunnelsDown) ?? 0),
    haSort: r.haEnabled ? (r.haText || 'HA') : 'Standalone',
  })), [rows]);
  const list = useMemo(() => all.filter((r) => !stateFilter || stateTone(r.state) === stateFilter), [all, stateFilter]);

  const ctl = useTableControls(list, {
    searchKeys: ['deviceName', 'siteLabel', 'model', 'vendor', 'version', 'haText'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
  });

  const tiles = useMemo(() => ({
    crit: all.filter((r) => stateTone(r.state) === 'crit').length,
    warn: all.filter((r) => stateTone(r.state) === 'warn').length,
    tunnelsDown: all.reduce((n, r) => n + (num(r.tunnelsDown) ?? 0), 0),
    unsynced: all.filter((r) => syncedOf(r.configSynced) === false).length,
  }), [all]);

  const setState = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('state', v); else next.delete('state');
    setSearchParams(next, { replace: true });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = {};
      if (ctl.q.trim()) params.q = ctl.q.trim();
      const site = ctl.filters.siteLabel ? all.find((r) => r.siteLabel === ctl.filters.siteLabel)?.siteKey : null;
      if (site) params.siteKey = site;
      if (ctl.filters.vendor) params.vendor = ctl.filters.vendor;
      if (stateFilter) params.state = STATE_PARAM[stateFilter];
      await downloadCsv('/logicmonitor/firewalls.csv', params, 'logicmonitor-firewalls');
    } catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setExporting(false); }
  };

  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';
  const cpuCls = (v) => (num(v) >= 85 ? 'text-status-warn' : 'text-ink-muted');

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Firewalls" description="Palo Alto, Cisco and Meraki firewalls with HA, sessions, tunnels and load, from the DataSource metrics tier">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ShieldCheck} label="Firewalls" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={ShieldAlert} label="Critical" value={fmtNum(tiles.crit)} tone={tiles.crit ? 'crit' : 'ok'} sub={`${fmtNum(tiles.warn)} warning`} loading={rows == null} />
        <StatCard icon={Waypoints} label="Tunnels down" value={fmtNum(tiles.tunnelsDown)} tone={tiles.tunnelsDown ? 'warn' : 'ok'} loading={rows == null} />
        <StatCard icon={FileWarning} label="Config unsynced" value={fmtNum(tiles.unsynced)} tone={tiles.unsynced ? 'warn' : 'ok'} loading={rows == null} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search device, site, model or version..." />
          <FilterSelect ctl={ctl} k="siteLabel" rows={list} label="sites" />
          <FilterSelect ctl={ctl} k="vendor" rows={list} label="vendors" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} firewall(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>

        {rows == null ? <LoadingPanel label="Loading firewalls..." height={200} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">
            {rows.length === 0 ? 'No firewalls collected yet. The metrics tier runs every 30 minutes by default; check Settings > Scope > Metric families.' : 'No firewalls match.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="deviceName" label="Device" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="model" label="Model" ctl={ctl} />
                  <SortTh k="haSort" label="HA" ctl={ctl} />
                  <SortTh k="sessionsUtilPct" label="Sessions" ctl={ctl} />
                  <SortTh k="dataplaneCpuPct" label="Dataplane CPU" ctl={ctl} align="right" />
                  <SortTh k="mgmtCpuPct" label="Mgmt CPU" ctl={ctl} align="right" />
                  <SortTh k="memPct" label="Memory" ctl={ctl} align="right" />
                  <SortTh k="tunnelsDown" label="Tunnels" ctl={ctl} align="right" />
                  <SortTh k="gpUsers" label="GP users" ctl={ctl} align="right" />
                  <SortTh k="configSynced" label="Config" ctl={ctl} />
                  <SortTh k="threatsPerHour" label="Threats/h" ctl={ctl} align="right" />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => {
                    const synced = syncedOf(r.configSynced);
                    const haBad = r.haEnabled && stateTone(r.state) === 'crit';
                    return (
                      <tr key={`${r.sourceId}-${r.deviceId}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                        <td className="py-2 pr-3 text-ink text-[12px]">{r.deviceName}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.siteLabel || DASH}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px] whitespace-nowrap" title={r.version ? `${r.vendor || ''} ${r.version}` : undefined}>{r.model || DASH}</td>
                        <td className="py-2 pr-3 text-[12px]">
                          {r.haEnabled ? <Badge tone={haBad ? 'crit' : 'info'}>{r.haText || 'HA'}</Badge> : <span className="text-ink-faint">Standalone</span>}
                        </td>
                        <td className="py-2 pr-3 min-w-[130px]">
                          <UtilBar pct={pctInRange(r.sessionsUtilPct) ? r.sessionsUtilPct : null} />
                          <p className="text-[10px] text-ink-faint tnum">{fmtNum(r.sessionsActive)} / {fmtNum(r.sessionsMax)}</p>
                        </td>
                        <td className={`py-2 pr-3 text-right tnum ${cpuCls(pctInRange(r.dataplaneCpuPct) ? r.dataplaneCpuPct : null)}`}><PctValue v={r.dataplaneCpuPct} /></td>
                        <td className={`py-2 pr-3 text-right tnum ${cpuCls(pctInRange(r.mgmtCpuPct) ? r.mgmtCpuPct : null)}`}><PctValue v={r.mgmtCpuPct} /></td>
                        <td className={`py-2 pr-3 text-right tnum ${(pctInRange(r.memPct) && num(r.memPct) >= 90) ? 'text-status-warn' : 'text-ink-muted'}`}><PctValue v={r.memPct} /></td>
                        <td className="py-2 pr-3 text-right tnum whitespace-nowrap">
                          {r.tunnelsUp == null && r.tunnelsDown == null ? <span className="text-ink-faint">{DASH}</span> : (
                            <><span className="text-ink-muted">{fmtNum(r.tunnelsUp)}</span><span className="text-ink-faint"> / </span><span className={num(r.tunnelsDown) > 0 ? 'text-status-warn' : 'text-ink-faint'}>{fmtNum(r.tunnelsDown)}</span></>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.gpUsers)}</td>
                        <td className="py-2 pr-3">{synced == null ? <span className="text-ink-faint">{DASH}</span> : <Badge tone={synced ? 'ok' : 'warn'}>{synced ? 'Synced' : 'Unsynced'}</Badge>}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.threatsPerHour == null ? DASH : fmtNum(Math.round(Number(r.threatsPerHour)))}</td>
                        <td className="py-2 pr-3"><Badge tone={stateTone(r.state)}>{stateLabel(r.state)}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>
      <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><AlertTriangle size={11} /> HA enum text and datapoint names are unverified until the first live poll; unknown values show as numbers.</p>

      {open && <LmFirewall360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
