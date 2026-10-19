import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Scale, Download, ShieldAlert, Layers, ServerOff, CalendarClock } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, DASH, arr, fmtNum, stateTone, stateLabel, stateRank, downloadCsv, useVisibleInterval,
} from './helpers';
import { PctValue, pctInRange, headRow, chipBtn } from './ui';
import LmLoadBalancer360 from './LmLoadBalancer360';
import { num } from './LmFirewall360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };

const failoverTone = (t) => {
  const v = String(t || '').toLowerCase();
  if (v.includes('active') && !v.includes('standby')) return 'ok';
  if (v.includes('standby')) return 'info';
  if (v.includes('offline')) return 'warn';
  return 'neutral';
};

// "0 of 3" styled as a problem only when the first number is above zero.
function Frac({ bad, total }) {
  if (bad == null && total == null) return <span className="text-ink-faint">{DASH}</span>;
  return (
    <span className="tnum">
      <span className={num(bad) > 0 ? 'text-status-warn' : 'text-ink-muted'}>{fmtNum(bad)}</span>
      <span className="text-ink-faint"> / {fmtNum(total)}</span>
    </span>
  );
}

export default function LmLoadBalancersPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';

  const load = useCallback(() => client.get('/logicmonitor/load-balancers')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load load balancers' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => (rows || []).map((r) => ({
    ...r,
    siteLabel: r.siteName || r.siteKey || '',
    stateRank: stateRank(r.state),
  })), [rows]);
  const list = useMemo(() => all.filter((r) => !stateFilter || stateTone(r.state) === stateFilter), [all, stateFilter]);

  const ctl = useTableControls(list, {
    searchKeys: ['deviceName', 'siteLabel', 'model', 'failoverText', 'syncState'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
  });

  const tiles = useMemo(() => ({
    crit: all.filter((r) => stateTone(r.state) === 'crit').length,
    warn: all.filter((r) => stateTone(r.state) === 'warn').length,
    membersDown: all.reduce((n, r) => n + (num(r.membersDown) ?? 0), 0),
    certs: all.reduce((n, r) => n + (num(r.certsExpiring) ?? 0), 0),
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
      if (stateFilter) params.state = STATE_PARAM[stateFilter];
      await downloadCsv('/logicmonitor/load-balancers.csv', params, 'logicmonitor-load-balancers');
    } catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setExporting(false); }
  };

  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';
  const cpuCls = (v) => (num(v) >= 85 ? 'text-status-warn' : 'text-ink-muted');

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Scale} title="Load Balancers" description="F5 BIG-IP failover, pools, GTM wide IPs, daemons and certificates, from the DataSource metrics tier">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Layers} label="Load balancers" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={ShieldAlert} label="Critical" value={fmtNum(tiles.crit)} tone={tiles.crit ? 'crit' : 'ok'} sub={`${fmtNum(tiles.warn)} warning`} loading={rows == null} />
        <StatCard icon={ServerOff} label="Pool members down" value={fmtNum(tiles.membersDown)} tone={tiles.membersDown ? 'warn' : 'ok'} loading={rows == null} />
        <StatCard icon={CalendarClock} label="Certs expiring" value={fmtNum(tiles.certs)} tone={tiles.certs ? 'warn' : 'ok'} loading={rows == null} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {[['', 'All'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setState(v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search device, site or failover state..." />
          <FilterSelect ctl={ctl} k="siteLabel" rows={list} label="sites" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} load balancer(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>

        {rows == null ? <LoadingPanel label="Loading load balancers..." height={200} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">
            {rows.length === 0 ? 'No load balancers collected yet. The metrics tier runs every 30 minutes by default; check Settings > Scope > Metric families.' : 'No load balancers match.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="deviceName" label="Device" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="failoverText" label="Failover" ctl={ctl} />
                  <SortTh k="syncState" label="Sync" ctl={ctl} />
                  <SortTh k="cpuPct" label="CPU" ctl={ctl} align="right" />
                  <SortTh k="memPct" label="Memory" ctl={ctl} align="right" />
                  <SortTh k="clientConnections" label="Client conns" ctl={ctl} align="right" />
                  <SortTh k="poolsDegraded" label="Pools" ctl={ctl} align="right" />
                  <SortTh k="membersDown" label="Members down" ctl={ctl} align="right" />
                  <SortTh k="wideIpsDown" label="Wide IPs down" ctl={ctl} align="right" />
                  <SortTh k="vipsDown" label="VIPs down" ctl={ctl} align="right" />
                  <SortTh k="daemonsDown" label="Daemons" ctl={ctl} align="right" />
                  <SortTh k="certsExpiring" label="Certs expiring" ctl={ctl} align="right" />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.deviceId}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                      <td className="py-2 pr-3 text-ink text-[12px]">{r.deviceName}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.siteLabel || DASH}</td>
                      <td className="py-2 pr-3"><Badge tone={failoverTone(r.failoverText)}>{r.failoverText || 'Unknown'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.syncState ?? DASH}</td>
                      <td className={`py-2 pr-3 text-right tnum ${cpuCls(pctInRange(r.cpuPct) ? r.cpuPct : null)}`}><PctValue v={r.cpuPct} /></td>
                      <td className={`py-2 pr-3 text-right tnum ${(pctInRange(r.memPct) && num(r.memPct) >= 90) ? 'text-status-warn' : 'text-ink-muted'}`}><PctValue v={r.memPct} /></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clientConnections)}</td>
                      <td className="py-2 pr-3 text-right text-[12px]"><Frac bad={r.poolsDegraded} total={r.pools} /></td>
                      <td className="py-2 pr-3 text-right text-[12px]"><Frac bad={r.membersDown} total={r.membersTotal} /></td>
                      <td className="py-2 pr-3 text-right text-[12px]"><Frac bad={r.wideIpsDown} total={r.wideIps} /></td>
                      <td className="py-2 pr-3 text-right text-[12px]"><Frac bad={r.vipsDown} total={r.vips} /></td>
                      <td className={`py-2 pr-3 text-right tnum ${num(r.daemonsDown) > 0 ? 'text-status-crit' : 'text-ink-faint'}`}>{r.daemonsDown == null ? DASH : r.daemonsDown > 0 ? `${fmtNum(r.daemonsDown)} down` : 'All up'}</td>
                      <td className={`py-2 pr-3 text-right tnum ${num(r.certsExpiring) > 0 ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(r.certsExpiring)}</td>
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

      {open && <LmLoadBalancer360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
