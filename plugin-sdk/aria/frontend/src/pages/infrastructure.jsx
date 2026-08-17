// Ported from the built-in AriaInfrastructurePage.jsx. The built-in usage
// modal used react-dom's createPortal directly; window.ReactDOM here is
// react-dom/client (no createPortal), so this uses the ui.jsx Modal
// primitive (portalOrInline-guarded) instead.
import { Server, Cable, FolderKanban, Import, DiscAlbum, Cpu, AlertTriangle } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Modal,
  useTableControls, SortTh, TableControls, TablePager, useVisibleColumns, ColumnPicker, CsvExportButton,
  BRAND, fmtNum, fmtWhen, statusTone,
} from '../ui.jsx';

const TABS = [
  { key: 'endpoints', label: 'Endpoints', icon: Cable },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'catalog', label: 'Catalog Sources', icon: Import },
  { key: 'images', label: 'Images', icon: DiscAlbum },
  { key: 'flavors', label: 'Flavors', icon: Cpu },
];

function EndpointsTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'type'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name or type…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'kind', label: 'Kinds' }, { k: 'health_state', label: 'Health' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading endpoints…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No cloud accounts or integrations found — register an Aria instance under Settings.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No endpoints match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="name" label="Name" ctl={ctl} />
              <SortTh k="kind" label="Kind" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="health_state" label="Health" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((e, i) => (
                <tr key={`${e.instance_name}|${e.endpoint_id}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{e.instance_name}</td>
                  <td className="py-2 pr-3 text-ink">{e.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{e.kind === 'cloud-account' ? 'Cloud Account' : 'Integration'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.type || '—'}</td>
                  <td className="py-2 pr-3"><Badge tone={statusTone(e.health_state)}>{e.health_state || 'unknown'}</Badge></td>
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

function ProjectsTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'description'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name…"
        filters={[{ k: 'instance_name', label: 'Instances' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading projects…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No projects found — register an Aria instance under Settings.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No projects match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="name" label="Name" ctl={ctl} />
              <th className="py-2 pr-3">Description</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((p, i) => (
                <tr key={`${p.instance_name}|${p.project_id}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{p.instance_name}</td>
                  <td className="py-2 pr-3 text-ink">{p.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[420px] truncate" title={p.description || ''}>{p.description || '—'}</td>
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

function CatalogTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'type'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name or type…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'type', label: 'Types' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading catalog sources…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No catalog sources found — register an Aria instance under Settings.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No catalog sources match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="name" label="Name" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="items_imported" label="Imported" ctl={ctl} align="right" />
              <SortTh k="items_found" label="Found" ctl={ctl} align="right" />
              <SortTh k="last_import_at" label="Last Import" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((c, i) => {
                const hasErrors = !!c.last_import_errors;
                return (
                  <tr key={`${c.instance_name}|${c.source_id}|${i}`} className={`border-b border-cohesity-border/50 ${hasErrors ? 'bg-status-warn/5' : ''}`}>
                    <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{c.instance_name}</td>
                    <td className="py-2 pr-3 text-ink">{c.name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{c.type || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.items_imported)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.items_found)}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{fmtWhen(c.last_import_at)}</td>
                    {hasErrors && (
                      <td className="py-2 pr-3 text-[11px] text-status-warn max-w-[240px] truncate" title={c.last_import_errors}>{c.last_import_errors}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

// Usage keyed per instance: blueprints reference mapping names; mappings
// reference fabric image names. Modal shows the chain for a clicked item.
function UsageModal({ item, onClose }) {
  if (!item) return null;
  return (
    <Modal title={item.title} onClose={onClose} maxWidth="min(560px,92vw)">
      <div className="flex flex-col gap-4">
        {item.facts && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {item.facts.filter((f) => f.value != null && f.value !== '').map((f) => (
              <div key={f.label} className="min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-ink-faint">{f.label}</div>
                <div className="text-xs text-ink break-words">{f.value}</div>
              </div>
            ))}
          </div>
        )}
        {item.description && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Description</div>
            <div className="text-xs text-ink-muted whitespace-pre-wrap break-words bg-surface-overlay border border-cohesity-border rounded px-2 py-1.5">{item.description}</div>
          </div>
        )}
        {item.json && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Custom Properties</div>
            <pre className="text-[11px] text-ink-muted bg-surface-overlay border border-cohesity-border rounded px-2 py-1.5 overflow-x-auto" style={{ maxHeight: 192, overflowY: 'auto' }}>{item.json}</pre>
          </div>
        )}
        {item.sections.map((s) => (
          <div key={s.label}>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">{s.label}</div>
            {s.items.length === 0 ? (
              <div className="text-xs text-status-warn flex items-center gap-1.5"><AlertTriangle size={12} /> {s.emptyText}</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {s.items.map((name) => (
                  <li key={name} className="text-xs text-ink bg-surface-overlay border border-cohesity-border rounded px-2 py-1">{name}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div className="text-[11px] text-ink-faint">
          Usage is derived from image references extracted from Cloud Assembly template YAML — catalog
          items backed by other content types (Terraform, vRO) are not traced.
        </div>
      </div>
    </Modal>
  );
}

function ImageMappingsTable({ rows, onShowUsage }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['mapping_name', 'image_name', 'instance_name', 'region', 'profile_name'],
    defaultSortKey: 'mapping_name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Image Mappings <span className="text-ink-faint font-normal">— logical names deployments request, per region</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by mapping or image…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'region', label: 'Regions' }, { k: 'os_family', label: 'OS' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading image mappings…" height={120} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No image mappings found — configure image profiles in Aria Assembler.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No mappings match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="mapping_name" label="Mapping" ctl={ctl} />
              <SortTh k="region" label="Region" ctl={ctl} />
              <SortTh k="image_name" label="Image" ctl={ctl} />
              <SortTh k="os_family" label="OS" ctl={ctl} />
              <SortTh k="usage_count" label="Blueprints" ctl={ctl} align="right" />
              <th className="py-2 pr-3">External ID</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((m, i) => (
                <tr key={`${m.instance_name}|${m.region}|${m.mapping_name}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{m.instance_name}</td>
                  <td className="py-2 pr-3">
                    <button onClick={() => onShowUsage(m)} className="text-ink font-medium hover:text-brand cursor-pointer text-left" title="Show blueprint usage">{m.mapping_name || '—'}</button>
                  </td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{m.region || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[280px] truncate" title={m.image_name || ''}>{m.image_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{m.os_family || '—'}</td>
                  <td className="py-2 pr-3 text-right">
                    {m.usage_count == null ? <span className="text-ink-faint">—</span>
                      : m.usage_count === 0 ? <Badge tone="warn">unused</Badge>
                      : <span className="tnum text-ink-muted">{m.usage_count}</span>}
                  </td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] max-w-[220px] truncate" title={m.image_external_id || ''}>{m.image_external_id || '—'}</td>
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

function FabricImagesTable({ rows, onShowUsage }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'region', 'external_id', 'os_family', 'description'],
    defaultSortKey: 'created_at_src', defaultSortDir: 'desc',
    paginate: true,
  });
  const COLUMNS = [
    { k: 'instance_name', label: 'Instance',
      render: (img) => <td key="instance_name" className="py-2 pr-3 text-ink-muted whitespace-nowrap">{img.instance_name}</td>,
      csv: (img) => img.instance_name },
    { k: 'name', label: 'Name', always: true,
      render: (img) => (
        <td key="name" className="py-2 pr-3 max-w-[280px] truncate">
          <button onClick={() => onShowUsage(img)} className="text-ink hover:text-brand cursor-pointer text-left truncate" title="Show full image details">{img.name || '—'}</button>
        </td>
      ),
      csv: (img) => img.name },
    { k: 'region', label: 'Region',
      render: (img) => <td key="region" className="py-2 pr-3 text-ink-muted text-[11px]">{img.region || '—'}</td>,
      csv: (img) => img.region },
    { k: 'os_family', label: 'OS',
      render: (img) => <td key="os_family" className="py-2 pr-3 text-ink-muted text-[11px]">{img.os_family || '—'}</td>,
      csv: (img) => img.os_family },
    { k: 'created_at_src', label: 'Discovered',
      render: (img) => <td key="created_at_src" className="py-2 pr-3 text-ink-muted text-[11px] tnum whitespace-nowrap">{fmtWhen(img.created_at_src)}</td>,
      csv: (img) => img.created_at_src },
    { k: 'is_private', label: 'Private',
      render: (img) => <td key="is_private" className="py-2 pr-3">{img.is_private == null ? <span className="text-ink-faint">—</span> : <Badge tone={img.is_private ? 'warn' : 'ok'}>{img.is_private ? 'private' : 'public'}</Badge>}</td>,
      csv: (img) => img.is_private == null ? '' : (img.is_private ? 'private' : 'public') },
    { k: 'usage_count', label: 'Blueprints', align: 'right',
      render: (img) => (
        <td key="usage_count" className="py-2 pr-3 text-right">
          {img.usage_count == null ? <span className="text-ink-faint">—</span>
            : img.usage_count === 0 ? <Badge tone="warn">unused</Badge>
            : <span className="tnum text-ink-muted">{img.usage_count}</span>}
        </td>
      ),
      csv: (img) => img.usage_count },
    { k: 'external_id', label: 'External ID',
      render: (img) => <td key="external_id" className="py-2 pr-3 text-ink-faint text-[11px] max-w-[200px] truncate" title={img.external_id || ''}>{img.external_id || '—'}</td>,
      csv: (img) => img.external_id },
    { k: 'description', label: 'Description',
      render: (img) => <td key="description" className="py-2 pr-3 text-ink-muted text-[11px] max-w-[260px] truncate" title={img.description || ''}>{img.description || '—'}</td>,
      csv: (img) => img.description },
  ];
  const cols = useVisibleColumns('aria-fabric-images-cols', ['is_private', 'usage_count']);
  const shown = COLUMNS.filter((c) => c.always || cols.show(c.k));
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-ink">Fabric Images <span className="text-ink-faint font-normal">— raw templates/AMIs discovered from cloud accounts</span></div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <ColumnPicker columns={COLUMNS} prefs={cols} />
          <CsvExportButton filename="aria-fabric-images" rows={ctl.rows}
            columns={COLUMNS.map((c) => ({ label: c.label, get: c.csv }))} />
        </div>
      </div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, description or external id…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'region', label: 'Regions' }, { k: 'os_family', label: 'OS' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading images…" height={120} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No fabric images found — check that cloud-account data collection has run.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No images match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              {shown.map((c) => <SortTh key={c.k} k={c.k} label={c.label} ctl={ctl} align={c.align} />)}
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((img, i) => (
                <tr key={`${img.instance_name}|${img.image_id}|${i}`} className="border-b border-cohesity-border/50">
                  {shown.map((c) => c.render(img))}
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

function FlavorsTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['mapping_name', 'instance_name', 'region', 'profile_name'],
    defaultSortKey: 'mapping_name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by flavor name…"
        filters={[{ k: 'instance_name', label: 'Instances' }, { k: 'region', label: 'Regions' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading flavors…" height={120} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No flavor mappings found — configure flavor profiles in Aria Assembler.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No flavors match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="mapping_name" label="Flavor" ctl={ctl} />
              <SortTh k="region" label="Region" ctl={ctl} />
              <SortTh k="cpu_count" label="vCPUs" ctl={ctl} align="right" />
              <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((f, i) => (
                <tr key={`${f.instance_name}|${f.region}|${f.mapping_name}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{f.instance_name}</td>
                  <td className="py-2 pr-3 text-ink font-medium">{f.mapping_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{f.region || '—'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(f.cpu_count)}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{f.memory_mb != null ? `${fmtNum(f.memory_mb)} MB` : '—'}</td>
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

export default function AriaInfrastructurePage() {
  const [tab, setTab] = React.useState('endpoints');
  const [endpoints, setEndpoints] = React.useState(null);
  const [projects, setProjects] = React.useState(null);
  const [catalogSources, setCatalogSources] = React.useState(null);
  const [images, setImages] = React.useState(null);
  const [imageMappings, setImageMappings] = React.useState(null);
  const [flavors, setFlavors] = React.useState(null);
  const [usage, setUsage] = React.useState(null);
  const [usageModal, setUsageModal] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => Promise.all([
    apiFetch('/aria/endpoints').then((json) => setEndpoints(json)).catch(() => setEndpoints([])),
    apiFetch('/aria/projects').then((json) => setProjects(json)).catch(() => setProjects([])),
    apiFetch('/aria/catalog-sources').then((json) => setCatalogSources(json)).catch(() => setCatalogSources([])),
    apiFetch('/aria/images').then((json) => setImages(json)).catch(() => setImages([])),
    apiFetch('/aria/image-mappings').then((json) => setImageMappings(json)).catch(() => setImageMappings([])),
    apiFetch('/aria/flavor-mappings').then((json) => setFlavors(json)).catch(() => setFlavors([])),
    apiFetch('/aria/image-usage').then((json) => setUsage(json)).catch(() => setUsage(null)),
  ]).then(() => setLastRefreshed(new Date())), []);

  React.useEffect(() => { load(); }, [load]);

  // Enrich mapping/image rows with blueprint usage counts (null until the
  // usage endpoint has data, so the column shows — instead of false zeros).
  const usageMappings = React.useMemo(() => {
    if (imageMappings == null) return null;
    if (!usage || usage.blueprintCount === 0) return imageMappings.map((m) => ({ ...m, usage_count: null }));
    const key = (r) => `${r.instance_id}|${r.region}|${r.mapping_name}`;
    const byKey = new Map(usage.mappings.map((m) => [key(m), m.blueprints]));
    return imageMappings.map((m) => ({ ...m, usage_count: (byKey.get(key(m)) || []).length, _blueprints: byKey.get(key(m)) || [] }));
  }, [imageMappings, usage]);
  const usageImages = React.useMemo(() => {
    if (images == null) return null;
    if (!usage || usage.blueprintCount === 0) return images.map((img) => ({ ...img, usage_count: null }));
    const key = (r) => `${r.instance_id}|${r.region}|${r.name}`;
    const byKey = new Map(usage.fabricImages.map((f) => [key(f), f]));
    return images.map((img) => {
      const u = byKey.get(key(img));
      return { ...img, usage_count: u ? u.blueprints.length : 0, _mappings: u?.mappings || [], _blueprints: u?.blueprints || [] };
    });
  }, [images, usage]);

  const showMappingUsage = (m) => setUsageModal({
    title: `Mapping "${m.mapping_name}" — ${m.instance_name} / ${m.region || 'no region'}`,
    sections: [
      { label: 'Resolves to image', items: m.image_name ? [m.image_name] : [], emptyText: 'No target image recorded.' },
      { label: `Blueprints referencing it${m.usage_count != null ? ` (${m.usage_count})` : ''}`, items: m._blueprints || [], emptyText: 'Not referenced by any collected blueprint — retirement candidate.' },
    ],
  });
  const showImageUsage = (img) => setUsageModal({
    title: `Image "${img.name}" — ${img.instance_name} / ${img.region || 'no region'}`,
    facts: [
      { label: 'Instance', value: img.instance_name },
      { label: 'Region', value: img.region },
      { label: 'OS Family', value: img.os_family },
      { label: 'Visibility', value: img.is_private == null ? null : (img.is_private ? 'private' : 'public') },
      { label: 'External ID', value: img.external_id },
      { label: 'Image ID', value: img.image_id },
      { label: 'Discovered', value: img.created_at_src ? fmtWhen(img.created_at_src) : null },
      { label: 'Updated', value: img.updated_at_src ? fmtWhen(img.updated_at_src) : null },
    ],
    description: img.description || null,
    json: (() => {
      if (!img.custom_properties) return null;
      try { return JSON.stringify(JSON.parse(img.custom_properties), null, 2); }
      catch { return String(img.custom_properties); }
    })(),
    sections: [
      { label: 'Mapped by', items: img._mappings || [], emptyText: 'No image mapping points at this image.' },
      { label: `Blueprints using it${img.usage_count != null ? ` (${img.usage_count})` : ''}`, items: img._blueprints || [], emptyText: 'Not reachable from any collected blueprint — retirement candidate.' },
    ],
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Infrastructure" description="Cloud accounts, integrations, projects, catalog sources, images and flavors">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1 w-fit mb-4">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
              }`}>
              <Icon size={13} className={active ? 'text-brand' : ''} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'endpoints' && <EndpointsTable rows={endpoints} />}
      {tab === 'projects' && <ProjectsTable rows={projects} />}
      {tab === 'catalog' && <CatalogTable rows={catalogSources} />}
      {tab === 'images' && (<>
        <ImageMappingsTable rows={usageMappings} onShowUsage={showMappingUsage} />
        <FabricImagesTable rows={usageImages} onShowUsage={showImageUsage} />
      </>)}
      {tab === 'flavors' && <FlavorsTable rows={flavors} />}
      <UsageModal item={usageModal} onClose={() => setUsageModal(null)} />
    </div>
  );
}
