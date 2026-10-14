import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Server, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen, hostStatusTone, hostStatusLabel, severityTone, titleCase, postCsv } from './helpers';
import { inp, sel, headRow, ServerSortTh, ServerPager } from './ui';
import LmDevice360 from './LmDevice360';

const FILTER_KEYS = ['vendor', 'role', 'groupId', 'collectorId', 'hostStatus', 'network', 'siteKey'];

export default function LmDevicesPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({ vendors: [], roles: [], hostStatuses: [], collectors: [], groups: [], sites: [] });
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('displayName');
  const [dir, setDir] = useState('asc');
  const [pageSize, setPageSize] = useState(25);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [exporting, setExporting] = useState(false);
  const limit = pageSize === 'all' ? 500 : pageSize;

  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, searchParams.get(k) || '']));
  const openDevice = searchParams.get('device');
  const openSource = searchParams.get('sourceId');

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'device' && key !== 'sourceId') setPage(1);
    setSearchParams(next, { replace: true });
  };

  const showDevice = (id, sourceId) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('device', String(id)); else next.delete('device');
    if (id && sourceId) next.set('sourceId', String(sourceId)); else next.delete('sourceId');
    setSearchParams(next, { replace: true });
  };

  const load = useCallback(() => {
    const params = { page, limit, sort, dir };
    if (q.trim()) params.q = q.trim();
    for (const k of FILTER_KEYS) { const v = searchParams.get(k); if (v) params[k] = v; }
    return client.get('/logicmonitor/devices', { params })
      .then(({ data }) => {
        setRows(Array.isArray(data?.items) ? data.items : []);
        setTotal(data?.total ?? 0);
        setLastRefreshed(new Date());
      })
      .catch(() => { setRows([]); setTotal(0); toast({ type: 'error', title: 'Failed to load devices' }); });
    // Only the filter keys matter, not the device deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, limit, sort, dir, ...FILTER_KEYS.map((k) => searchParams.get(k)), toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let live = true;
    Promise.allSettled([client.get('/logicmonitor/summary'), client.get('/logicmonitor/collectors'), client.get('/logicmonitor/sites')]).then(async ([s, c, st]) => {
      const sum = s.status === 'fulfilled' ? s.value.data || {} : {};
      const cols = c.status === 'fulfilled' && Array.isArray(c.value.data) ? c.value.data : [];
      const siteRows = st.status === 'fulfilled' && Array.isArray(st.value.data) ? st.value.data : [];
      const groupLists = await Promise.all((sum.sources || []).map((src) => client.get(`/logicmonitor/sources/${src.id}/groups`)
        .then(({ data }) => (Array.isArray(data) ? data : [])).catch(() => [])));
      if (!live) return;
      setFacets({
        vendors: (sum.byVendor || []).map((v) => v.vendor).filter(Boolean),
        roles: (sum.byRole || []).map((r) => r.role).filter(Boolean),
        hostStatuses: (sum.byHostStatus || []).map((h) => h.hostStatus).filter(Boolean),
        collectors: cols.map((x) => ({ id: x.id, label: x.hostname || x.description || `Collector ${x.id}` })),
        sites: siteRows.filter((x) => x.siteKey).map((x) => ({ id: x.siteKey, label: x.siteName || x.siteKey })).sort((a, b) => String(a.label).localeCompare(String(b.label))),
        groups: groupLists.flat().map((g) => ({ id: g.id, label: g.fullPath || g.name })).sort((a, b) => String(a.label).localeCompare(String(b.label))),
      });
    });
    return () => { live = false; };
  }, []);

  const onSort = (k) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(['openAlerts', 'ifCount', 'firstSeen'].includes(k) ? 'desc' : 'asc'); }
    setPage(1);
  };

  // Dell export rule: post the ids of the rows the table shows, never re-run
  // the filter server side.
  const exportVisible = async () => {
    if (!rows?.length) return;
    setExporting(true);
    try {
      await postCsv('/logicmonitor/devices/export', { ids: rows.map((r) => r.id) }, 'logicmonitor-devices');
    } catch {
      toast({ type: 'error', title: 'Export failed' });
    } finally {
      setExporting(false);
    }
  };

  const filterSelect = (key, label, options) => (
    <select value={filters[key]} onChange={(e) => setParam(key, e.target.value)} className={sel}>
      <option value="">All {label}</option>
      {filters[key] && !options.some((o) => String(o.v) === filters[key]) && <option value={filters[key]}>{filters[key]}</option>}
      {options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Devices" description="Every resource LogicMonitor monitors, with ICC's vendor and role classification">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, display name or IP..." className={`${inp} flex-1 min-w-[200px]`} spellCheck={false} />
          {filterSelect('vendor', 'vendors', facets.vendors.map((v) => ({ v, l: v })))}
          {filterSelect('role', 'roles', facets.roles.map((v) => ({ v, l: titleCase(v) })))}
          {filterSelect('hostStatus', 'statuses', facets.hostStatuses.map((v) => ({ v, l: hostStatusLabel(v) })))}
          {filterSelect('collectorId', 'collectors', facets.collectors.map((c) => ({ v: String(c.id), l: c.label })))}
          {filterSelect('groupId', 'groups', facets.groups.map((g) => ({ v: String(g.id), l: g.label })))}
          {filterSelect('siteKey', 'sites', facets.sites.map((x) => ({ v: x.id, l: x.label })))}
          <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer">
            <input type="checkbox" checked={filters.network === '1'} onChange={(e) => setParam('network', e.target.checked ? '1' : '')} /> Network only
          </label>
          <button onClick={exportVisible} disabled={exporting || !rows?.length} title="Export the rows shown below"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer disabled:opacity-50">
            <Download size={12} /> {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>

        {rows == null ? <LoadingPanel label="Loading devices..." height={200} /> : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices match.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <ServerSortTh k="displayName" label="Device" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="vendor" label="Vendor" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="model" label="Model" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Version</th>
                  <ServerSortTh k="hostStatus" label="Status" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Alert</th>
                  <ServerSortTh k="collectorName" label="Collector" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="siteName" label="Site" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Group</th>
                  <ServerSortTh k="ifCount" label="Interfaces" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="openAlerts" label="Alerts" sort={sort} dir={dir} onSort={onSort} align="right" />
                  <ServerSortTh k="firstSeen" label="First Seen" sort={sort} dir={dir} onSort={onSort} />
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.sourceId}-${r.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => showDevice(r.id, r.sourceId)}>
                      <td className="py-2 pr-3">
                        <p className="text-ink truncate max-w-[240px]" title={r.name}>{r.displayName || r.name}</p>
                        <p className="text-[10px] text-ink-faint truncate max-w-[240px]">{r.role ? titleCase(r.role) : '-'}{r.sourceName ? ` - ${r.sourceName}` : ''}</p>
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.vendor || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[160px]">{r.model || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] tnum">{r.version || '-'}</td>
                      <td className="py-2 pr-3"><Badge tone={hostStatusTone(r.hostStatus)}>{hostStatusLabel(r.hostStatus)}</Badge>{r.inSdt ? <Badge tone="warn" className="ml-1">SDT</Badge> : null}</td>
                      <td className="py-2 pr-3">{r.alertSeverity ? <Badge tone={severityTone(r.alertSeverity === 'warn' ? 'warning' : r.alertSeverity)}>{r.alertSeverity}{r.acked ? ' (acked)' : ''}</Badge> : <span className="text-[11px] text-ink-faint">-</span>}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[160px]">{r.collectorName || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[140px]">{r.siteName ? (r.siteKey ? <Link to={`/logicmonitor/sites?site=${encodeURIComponent(r.siteKey)}`} onClick={(e) => e.stopPropagation()} className="text-brand hover:underline">{r.siteName}</Link> : r.siteName) : '-'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] truncate max-w-[180px]" title={(r.groups || []).join('\n')}>{(r.groups || [])[0] || '-'}{(r.groups || []).length > 1 ? ` +${r.groups.length - 1}` : ''}</td>
                      <td className="py-2 pr-3 text-right tnum">
                        {r.ifCount ? <span className={r.ifUp < r.ifCount ? 'text-ink' : 'text-ink-muted'}>{fmtNum(r.ifUp)} / {fmtNum(r.ifCount)}</span> : <span className="text-ink-faint">-</span>}
                      </td>
                      <td className={`py-2 pr-3 text-right tnum ${r.openAlerts ? 'text-status-warn' : 'text-ink-faint'}`}>{fmtNum(r.openAlerts)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(r.firstSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ServerPager shown={rows.length} total={total} page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} noun="device(s)" />
          </>
        )}
      </div>

      {openDevice && (
        <LmDevice360 deviceId={openDevice} sourceId={openSource} onClose={() => showDevice(null)}
          onSwitchDevice={(id) => showDevice(id, openSource)} />
      )}
    </div>
  );
}
