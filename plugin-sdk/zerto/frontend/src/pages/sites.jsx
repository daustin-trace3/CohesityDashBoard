// Zerto Sites & Appliances — ported from frontend/src/pages/zerto/ZertoSitesPage.jsx.
import { Globe2, Boxes } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND,
  useTableControls, SortTh, TableControls, connTone, fmtWhen, parseJsonList,
} from '../ui.jsx';

function vraTone(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'installed') return 'ok';
  if (s.includes('fail') || s.includes('error')) return 'crit';
  return 'warn';
}

export default function ZertoSitesPage() {
  const [rows, setRows] = React.useState(null);
  const [vras, setVras] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/zerto/sites').then((json) => setRows(json)),
    apiFetch('/zerto/vras').then((json) => setVras(json)).catch(() => setVras([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const vraList = vras || [];
  const vraCtl = useTableControls(vraList, {
    searchKeys: ['site_name', 'name', 'version', 'status'],
    defaultSortKey: 'site_name', defaultSortDir: 'asc',
  });
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'site_type', 'zvm_ip', 'version'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Globe2} title="Zerto Sites & Appliances" description="ZVM sites reporting to Zerto Analytics, and the VRA appliances at each site">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">ZVM Sites</p>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by site, type or ZVM IP…"
          filters={[{ k: 'site_type', label: 'Types' }, { k: 'connection_status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading sites…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sites found — check the Zerto credentials under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sites match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Site" ctl={ctl} />
                <SortTh k="site_type" label="Type" ctl={ctl} />
                <SortTh k="version" label="ZVM Version" ctl={ctl} />
                <SortTh k="zvm_ip" label="ZVM IP" ctl={ctl} />
                <SortTh k="connection_status" label="Analytics Link" ctl={ctl} />
                <SortTh k="last_connection_time" label="Last Seen" ctl={ctl} />
                <th className="py-2 pr-3 text-left text-[11px] uppercase tracking-wide">ZORGs</th>
              </tr></thead>
              <tbody>
                {ctl.rows.map((s) => (
                  <tr key={s.site_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{s.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.site_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{s.version || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{s.zvm_ip || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={connTone(s.connection_status)}>{s.connection_status || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtWhen(s.last_connection_time)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[200px] truncate">{parseJsonList(s.zorgs).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Boxes size={15} className="text-brand" /> VRA Appliances</p>
        <p className="text-[11px] text-ink-faint mb-3">Virtual Replication Appliances reported by each site's ZVM.</p>
        <TableControls ctl={vraCtl} rows={vraList} searchPlaceholder="Filter by site, VRA, version or status…"
          filters={[{ k: 'site_name', label: 'Sites' }, { k: 'status', label: 'Statuses' }, { k: 'version', label: 'Versions' }]} />
        {vras == null ? (
          <LoadingPanel label="Loading VRAs…" height={100} />
        ) : vraList.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VRA data yet — it appears after the next poll cycle.</div>
        ) : vraCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VRAs match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="site_name" label="Site" ctl={vraCtl} />
                <SortTh k="name" label="VRA" ctl={vraCtl} />
                <SortTh k="version" label="Version" ctl={vraCtl} />
                <SortTh k="status" label="Status" ctl={vraCtl} />
              </tr></thead>
              <tbody>
                {vraCtl.rows.map((v) => (
                  <tr key={v.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink-muted">{v.site_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink">{v.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{v.version || '—'}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={vraTone(v.status)}>{v.status || '—'}</Badge>
                      {v.progress != null && v.progress > 0 && v.progress < 100 && (
                        <span className="text-[11px] text-ink-faint tnum ml-2">{v.progress}%</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
