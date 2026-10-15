import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, GitCompare, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen, fmtSpeed, fmtMbps, statusTextTone, downloadCsv } from './helpers';
import { inp, sel, headRow, chipBtn, ServerSortTh, ServerPager, UtilBar } from './ui';
import LmInterfaceCompareModal from './LmInterfaceCompareModal';
import LmInterfaceHistoryModal from './LmInterfaceHistoryModal';

const FILTER_KEYS = ['deviceId', 'status', 'speedClass', 'groupId', 'vendor', 'preset', 'siteKey', 'wan'];
const PRESETS = [
  ['', 'All'], ['down', 'Down'], ['hot', 'Over threshold'], ['errors', 'Errors 24h'], ['flapping', 'Flapping 24h'], ['unused', 'Unused 30d'],
];
const SPEEDS = ['<=100M', '1G', '10G', '25G+', 'unknown'];
const MAX_COMPARE = 8;

export default function LmInterfacesPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('deviceName');
  const [dir, setDir] = useState('asc');
  const [pageSize, setPageSize] = useState(25);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [sites, setSites] = useState([]);
  const [selected, setSelected] = useState([]); // instanceIds
  const [comparing, setComparing] = useState(null);
  const [history, setHistory] = useState(null);
  const [exporting, setExporting] = useState(false);
  const limit = pageSize === 'all' ? 500 : pageSize;

  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, searchParams.get(k) || '']));

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const queryParams = useCallback(() => {
    const params = {};
    if (q.trim()) params.q = q.trim();
    for (const k of FILTER_KEYS) { const v = searchParams.get(k); if (v) params[k] = v; }
    return params;
  }, [q, searchParams]);

  const load = useCallback(() => client.get('/logicmonitor/interfaces', { params: { ...queryParams(), page, limit, sort, dir } })
    .then(({ data }) => {
      setRows(Array.isArray(data?.items) ? data.items : []);
      setTotal(data?.total ?? 0);
      setLastRefreshed(new Date());
    })
    .catch(() => { setRows([]); setTotal(0); toast({ type: 'error', title: 'Failed to load interfaces' }); }), [queryParams, page, limit, sort, dir, toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    client.get('/logicmonitor/summary').then(({ data }) => setVendors((data?.byVendor || []).map((v) => v.vendor).filter(Boolean))).catch(() => setVendors([]));
    client.get('/logicmonitor/sites').then(({ data }) => setSites((Array.isArray(data) ? data : []).filter((x) => x.siteKey).map((x) => ({ k: x.siteKey, l: x.siteName || x.siteKey })).sort((a, b) => String(a.l).localeCompare(String(b.l))))).catch(() => setSites([]));
  }, []);

  const onSort = (k) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(['deviceName', 'displayName', 'statusText'].includes(k) ? 'asc' : 'desc'); }
    setPage(1);
  };

  const toggleSel = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_COMPARE ? s : [...s, id]));

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('/logicmonitor/interfaces.csv', queryParams(), 'logicmonitor-interfaces');
    } catch {
      toast({ type: 'error', title: 'Export failed' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cable} title="Interfaces" description="Estate-wide interface status, utilization, errors and discards from the interface poll">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {PRESETS.map(([v, l]) => <button key={v || 'all'} onClick={() => setParam('preset', v)} className={chipBtn(filters.preset === v)}>{l}</button>)}
          <button onClick={() => setParam('wan', filters.wan === '1' ? '' : '1')} className={chipBtn(filters.wan === '1')} title="WAN circuits only">WAN</button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search device, interface or description..." className={`${inp} flex-1 min-w-[200px]`} spellCheck={false} />
          <select value={filters.status} onChange={(e) => setParam('status', e.target.value)} className={sel}>
            <option value="">All statuses</option>
            <option value="up">Up</option><option value="down">Down</option><option value="other">Other</option>
          </select>
          <select value={filters.speedClass} onChange={(e) => setParam('speedClass', e.target.value)} className={sel}>
            <option value="">All speeds</option>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filters.vendor} onChange={(e) => setParam('vendor', e.target.value)} className={sel}>
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={filters.siteKey} onChange={(e) => setParam('siteKey', e.target.value)} className={sel}>
            <option value="">All sites</option>
            {filters.siteKey && !sites.some((x) => x.k === filters.siteKey) && <option value={filters.siteKey}>{filters.siteKey}</option>}
            {sites.map((x) => <option key={x.k} value={x.k}>{x.l}</option>)}
          </select>
          {filters.deviceId && <button onClick={() => setParam('deviceId', '')} className={chipBtn(true)}>Device {filters.deviceId} x</button>}
          {filters.groupId && <button onClick={() => setParam('groupId', '')} className={chipBtn(true)}>Group {filters.groupId} x</button>}
          <button onClick={() => setComparing(selected)} disabled={selected.length < 2}
            title="Tick 2 to 8 interfaces to compare"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
            <GitCompare size={12} /> Compare ({selected.length})
          </button>
          {selected.length > 0 && <button onClick={() => setSelected([])} className="text-[11px] text-ink-faint hover:text-ink cursor-pointer">Clear</button>}
          <button onClick={exportCsv} disabled={exporting}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
            <Download size={12} /> {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>

        {rows == null ? <LoadingPanel label="Loading interfaces..." height={200} /> : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">{filters.preset === 'unused' ? 'No unused interfaces yet. This view needs 30 days of daily rollups.' : 'No interfaces match.'}</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-2 pr-2 w-6" />
                  <ServerSortTh k="deviceName" label="Device" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Site</th>
                  <ServerSortTh k="displayName" label="Interface" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="statusText" label="Status" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="speedBps" label="Speed" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="inUtilPct" label="In" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="outUtilPct" label="Out" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="inErrors" label="In Err" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="outErrors" label="Out Err" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="inDiscards" label="Discards" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="sampledAt" label="Sampled" sort={sort} dir={dir} onSort={onSort} />
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const checked = selected.includes(r.instanceId);
                    return (
                      <tr key={r.instanceId} className={`border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay ${r.stopMonitoring ? 'opacity-55' : ''}`} onClick={() => setHistory(r)}>
                        <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={checked} disabled={!checked && selected.length >= MAX_COMPARE} onChange={() => toggleSel(r.instanceId)} aria-label={`Select ${r.displayName} to compare`} />
                        </td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{r.deviceName}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[120px]">{r.siteKey || '-'}</td>
                        <td className="py-2 pr-3"><p className="text-ink truncate max-w-[200px]">{r.displayName}{r.isWan ? <Badge tone="info" className="ml-1">WAN</Badge> : null}</p><p className="text-[10px] text-ink-faint truncate max-w-[200px]">{r.description || '-'}</p>{r.circuitId ? <p className="text-[10px] text-ink-muted font-mono truncate max-w-[200px]" title={r.carrier || undefined}>CID {r.circuitId}{r.carrier ? ` (${r.carrier})` : ''}</p> : null}</td>
                        <td className="py-2 pr-3"><Badge tone={statusTextTone(r.statusText)}>{r.statusText || 'unknown'}</Badge>{r.stopMonitoring ? <span className="text-[10px] text-ink-faint ml-1">not monitored</span> : null}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtSpeed(r.speedBps)}</td>
                        <td className="py-2 pr-3"><UtilBar pct={r.inUtilPct} /><p className="text-[10px] text-ink-faint tnum">{fmtMbps(r.inMbps)}</p></td>
                        <td className="py-2 pr-3"><UtilBar pct={r.outUtilPct} /><p className="text-[10px] text-ink-faint tnum">{fmtMbps(r.outMbps)}</p></td>
                        <td className={`py-2 pr-3 text-right tnum ${r.inErrors ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(r.inErrors)}</td>
                        <td className={`py-2 pr-3 text-right tnum ${r.outErrors ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(r.outErrors)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum((r.inDiscards || 0) + (r.outDiscards || 0))}</td>
                        <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(r.sampledAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ServerPager shown={rows.length} total={total} page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} noun="interface(s)" />
          </>
        )}
      </div>

      {comparing && <LmInterfaceCompareModal ids={comparing} onClose={() => setComparing(null)} />}
      {history && <LmInterfaceHistoryModal deviceId={history.deviceId} iface={history} deviceName={history.deviceName} onClose={() => setHistory(null)} />}
    </div>
  );
}
