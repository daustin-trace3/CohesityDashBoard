import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppWindow, Download, ShieldAlert, AlertTriangle, ServerOff, Layers } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import {
  BRAND, DASH, arr, fmtNum, stateTone, stateLabel, stateRank, downloadCsv, useVisibleInterval,
} from './helpers';
import { headRow, chipBtn } from './ui';
import LmApplication360 from './LmApplication360';

const REFRESH_MS = 60000;
const STATE_PARAM = { crit: 'critical', warn: 'warning', ok: 'ok' };
const KIND_CHIPS = [['', 'All'], ['sql', 'SQL Server'], ['splunk', 'Splunk'], ['hyperv', 'Hyper-V'], ['xen', 'XenServer'], ['ironport', 'IronPort / ESA'], ['emc', 'EMC']];

export default function LmApplicationsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);
  const stateFilter = searchParams.get('state') || '';
  const kindFilter = searchParams.get('kind') || '';

  const load = useCallback(() => client.get('/logicmonitor/applications')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : arr(data?.items)); setLastRefreshed(new Date()); })
    .catch(() => { setRows((cur) => cur || []); toast({ type: 'error', title: 'Failed to load applications' }); }), [toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);

  const all = useMemo(() => (rows || []).map((r) => ({
    ...r,
    siteLabel: r.siteName || r.siteKey || '',
    kindText: arr(r.kindLabels).join(', '),
    stateRank: stateRank(r.state),
  })), [rows]);
  const list = useMemo(() => all.filter((r) => (!stateFilter || stateTone(r.state) === stateFilter) && (!kindFilter || arr(r.kinds).includes(kindFilter))), [all, stateFilter, kindFilter]);

  const ctl = useTableControls(list, {
    searchKeys: ['deviceName', 'siteLabel', 'model', 'vendor', 'kindText', 'headline'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
  });

  const tiles = useMemo(() => ({
    crit: all.filter((r) => stateTone(r.state) === 'crit').length,
    warn: all.filter((r) => stateTone(r.state) === 'warn').length,
    down: all.reduce((n, r) => n + (r.downCount || 0), 0),
    kinds: new Set(all.flatMap((r) => arr(r.kinds))).size,
  }), [all]);

  const setParam = (key, v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set(key, v); else next.delete(key);
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
      if (kindFilter) params.kind = kindFilter;
      if (stateFilter) params.state = STATE_PARAM[stateFilter];
      await downloadCsv('/logicmonitor/applications.csv', params, 'logicmonitor-applications');
    } catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setExporting(false); }
  };

  const btn = 'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AppWindow} title="Applications" description="SQL Server, Splunk, Hyper-V, XenServer, IronPort and EMC devices read through LogicMonitor DataSources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={AppWindow} label="Application devices" value={fmtNum(all.length)} loading={rows == null} />
        <StatCard icon={ShieldAlert} label="Critical" value={fmtNum(tiles.crit)} tone={tiles.crit ? 'crit' : 'ok'} sub={`${fmtNum(tiles.warn)} warning`} loading={rows == null} />
        <StatCard icon={ServerOff} label="Services down" value={fmtNum(tiles.down)} tone={tiles.down ? 'crit' : 'ok'} loading={rows == null} />
        <StatCard icon={Layers} label="Application kinds" value={fmtNum(tiles.kinds)} loading={rows == null} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {KIND_CHIPS.map(([v, l]) => (
            <button key={v || 'all'} onClick={() => setParam('kind', v)} className={chipBtn(kindFilter === v)}>{l}</button>
          ))}
          <span className="w-px h-4 bg-cohesity-border mx-1" />
          {[['', 'Any state'], ['crit', 'Critical'], ['warn', 'Warning'], ['ok', 'OK']].map(([v, l]) => (
            <button key={v || 'any'} onClick={() => setParam('state', v)} className={chipBtn(stateFilter === v)}>{l}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search device, site, model or figures..." />
          <FilterSelect ctl={ctl} k="siteLabel" rows={list} label="sites" />
          <FilterSelect ctl={ctl} k="vendor" rows={list} label="vendors" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} device(s)</span>
          <button onClick={exportCsv} disabled={exporting} className={`${btn} ml-auto`}><Download size={12} /> {exporting ? 'Exporting...' : 'Export'}</button>
        </div>

        {rows == null ? <LoadingPanel label="Loading applications..." height={200} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center max-w-2xl mx-auto leading-relaxed">
            {rows.length === 0
              ? 'No application data yet. This page fills when the portal has Microsoft SQL Server, Splunk, Hyper-V, XenServer, Cisco IronPort / ESA or EMC (Unity, VNX, Isilon, PowerStore, Data Domain) DataSources on a device, and the metrics tier has read them. The catalog matches those DataSources by name, so a portal without them stays empty here. Any other DataSource is still stored under Device 360 > DataSources.'
              : 'No application devices match.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="deviceName" label="Device" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="kindText" label="Kind" ctl={ctl} />
                  <SortTh k="headline" label="Key figures" ctl={ctl} />
                  <SortTh k="instances" label="Instances" ctl={ctl} align="right" />
                  <SortTh k="downCount" label="Down" ctl={ctl} align="right" />
                  <SortTh k="openIssues" label="Issues" ctl={ctl} align="right" />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.deviceId}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                      <td className="py-2 pr-3 text-ink text-[12px]">{r.deviceName}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.siteLabel || DASH}</td>
                      <td className="py-2 pr-3 text-[12px]">{arr(r.kindLabels).map((k) => <Badge key={k} tone="info">{k}</Badge>)}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] max-w-[420px] truncate" title={r.headline}>{r.headline || DASH}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.instances)}</td>
                      <td className={`py-2 pr-3 text-right tnum ${r.downCount ? 'text-status-crit' : 'text-ink-faint'}`}>{fmtNum(r.downCount)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.openIssues)}</td>
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
      <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1"><AlertTriangle size={11} /> These families are matched blind from LogicMonitor's standard DataSource names. Datapoint names and state values are unverified until a portal has them; unknown values show as numbers.</p>

      {open && <LmApplication360 deviceId={open.deviceId} sourceId={open.sourceId} onClose={() => setOpen(null)} />}
    </div>
  );
}
