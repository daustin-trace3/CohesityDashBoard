import { DiscAlbum, AlertTriangle } from '../icons.jsx';
import {
  apiFetch, PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum, fmtWhen,
} from '../ui.jsx';

function UnusedMappingsTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['mapping_name', 'image_name', 'instance_name', 'region'],
    defaultSortKey: 'mapping_name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Unused Image Mappings <span className="text-ink-faint font-normal">— logical names no collected blueprint references</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by mapping or image…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'region', label: 'Regions' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading…" height={120} />
      ) : list.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">Every image mapping is referenced by at least one blueprint.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No mappings match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="mapping_name" label="Mapping" ctl={ctl} />
              <SortTh k="region" label="Region" ctl={ctl} />
              <SortTh k="image_name" label="Resolves To" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((m, i) => (
                <tr key={`${m.instance_name}|${m.region}|${m.mapping_name}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{m.instance_name}</td>
                  <td className="py-2 pr-3 text-ink font-medium">{m.mapping_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{m.region || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[280px] truncate" title={m.image_name || ''}>{m.image_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

function UnusedImagesTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'region'],
    defaultSortKey: 'created_at_src', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Unused Fabric Images <span className="text-ink-faint font-normal">— not reachable from any blueprint via mapping or direct reference</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by image name…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'region', label: 'Regions' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading…" height={120} />
      ) : list.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">Every fabric image is reachable from a blueprint.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No images match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="name" label="Image" ctl={ctl} />
              <SortTh k="region" label="Region" ctl={ctl} />
              <SortTh k="created_at_src" label="Discovered" ctl={ctl} />
              <SortTh k="mappingCount" label="Mappings" ctl={ctl} align="right" />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((img, i) => (
                <tr key={`${img.instance_name}|${img.region}|${img.name}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{img.instance_name}</td>
                  <td className="py-2 pr-3 text-ink font-medium max-w-[300px] truncate" title={img.name || ''}>{img.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{img.region || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] tnum whitespace-nowrap">{fmtWhen(img.created_at_src)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(img.mappingCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

export default function AriaImagesAuditPage() {
  const [usage, setUsage] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/aria/image-usage')
    .then((json) => { setUsage(json); setLastRefreshed(new Date()); })
    .catch(() => setUsage({ mappings: [], fabricImages: [], blueprintCount: 0 })), []);

  React.useEffect(() => { load(); }, [load]);

  const unusedMappings = usage ? usage.mappings.filter((m) => m.blueprints.length === 0) : null;
  const unusedImages = usage ? usage.fabricImages
    .filter((img) => img.blueprints.length === 0)
    .map((img) => ({ ...img, mappingCount: img.mappings.length })) : null;
  const noBlueprints = usage != null && usage.blueprintCount === 0;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={DiscAlbum} title="Images" description="Image usage audit — mappings and fabric images no blueprint uses, i.e. retirement candidates">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {usage == null ? (
        <LoadingPanel label="Loading image usage…" />
      ) : noBlueprints ? (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="text-sm text-ink-muted flex items-center gap-2">
            <AlertTriangle size={14} className="text-status-warn" />
            No blueprints collected yet — usage auditing appears after the first poll finds Cloud Assembly
            templates. Catalog items backed by other content types (Terraform, vRO) are not traced.
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <StatCard label="Blueprints Collected" value={fmtNum(usage.blueprintCount)} />
            <StatCard label="Image Mappings" value={fmtNum(usage.mappings.length)} />
            <StatCard label="Unused Mappings" value={fmtNum(unusedMappings.length)} tone={unusedMappings.length ? 'warn' : 'ok'} />
            <StatCard label="Unused Fabric Images" value={fmtNum(unusedImages.length)} tone={unusedImages.length ? 'warn' : 'ok'} />
          </div>
          <UnusedMappingsTable rows={unusedMappings} />
          <UnusedImagesTable rows={unusedImages} />
          <div className="text-[11px] text-ink-faint mt-3">
            Usage is derived from image references in Cloud Assembly template YAML. Catalog items backed by
            Terraform or vRO content are not traced, so verify before deleting a template at the source.
          </div>
        </>
      )}
    </div>
  );
}
