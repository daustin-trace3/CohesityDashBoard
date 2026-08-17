// Zerto Alerts — ported from frontend/src/pages/zerto/ZertoAlertsPage.jsx.
// This is the read-only "current alerts" list; the per-alert-type SMTP
// notification toggle matrix (2026-08 addition, bb3c1c9) lives on the
// Settings page's "Alert Notifications" tab — see pages/settings.jsx.
import { Bell } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND,
  useTableControls, SortTh, TableControls, TablePager, severityTone, fmtWhen,
} from '../ui.jsx';

export default function ZertoAlertsPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/zerto/alerts')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['description', 'alert_type', 'site_name', 'entity_type'],
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Zerto Alerts" description="Active alerts across all Zerto sites">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by description, code, site or entity…"
          filters={[{ k: 'severity', label: 'Severities' }, { k: 'site_name', label: 'Sites' }, { k: 'entity_type', label: 'Entities' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading alerts…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No active alerts.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="severity" label="Severity" ctl={ctl} />
                <SortTh k="alert_type" label="Code" ctl={ctl} />
                <SortTh k="description" label="Description" ctl={ctl} />
                <SortTh k="site_name" label="Site" ctl={ctl} />
                <SortTh k="entity_type" label="Entity" ctl={ctl} />
                <SortTh k="collection_time" label="Raised" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((a) => (
                  <tr key={a.alert_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><Badge tone={severityTone(a.severity)}>{a.severity || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{a.alert_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink max-w-[420px]">{a.description || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.site_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{a.entity_type || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtWhen(a.collection_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>
    </div>
  );
}
