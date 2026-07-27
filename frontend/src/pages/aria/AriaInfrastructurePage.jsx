import { useEffect, useState, useCallback } from 'react';
import { Server, Cable, FolderKanban, Import, DiscAlbum, Cpu } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen, statusTone } from './helpers';

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

function ImageMappingsTable({ rows }) {
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
              <th className="py-2 pr-3">External ID</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((m, i) => (
                <tr key={`${m.instance_name}|${m.region}|${m.mapping_name}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{m.instance_name}</td>
                  <td className="py-2 pr-3 text-ink font-medium">{m.mapping_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{m.region || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[280px] truncate" title={m.image_name || ''}>{m.image_name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{m.os_family || '—'}</td>
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

function FabricImagesTable({ rows }) {
  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'instance_name', 'region', 'external_id', 'os_family'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Fabric Images <span className="text-ink-faint font-normal">— raw templates/AMIs discovered from cloud accounts</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name or external id…"
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
              <SortTh k="instance_name" label="Instance" ctl={ctl} />
              <SortTh k="name" label="Name" ctl={ctl} />
              <SortTh k="region" label="Region" ctl={ctl} />
              <SortTh k="os_family" label="OS" ctl={ctl} />
              <SortTh k="is_private" label="Private" ctl={ctl} />
              <th className="py-2 pr-3">External ID</th>
              <th className="py-2 pr-3">Description</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((img, i) => (
                <tr key={`${img.instance_name}|${img.image_id}|${i}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{img.instance_name}</td>
                  <td className="py-2 pr-3 text-ink max-w-[280px] truncate" title={img.name || ''}>{img.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{img.region || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{img.os_family || '—'}</td>
                  <td className="py-2 pr-3">{img.is_private == null ? <span className="text-ink-faint">—</span> : <Badge tone={img.is_private ? 'warn' : 'ok'}>{img.is_private ? 'private' : 'public'}</Badge>}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] max-w-[200px] truncate" title={img.external_id || ''}>{img.external_id || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[260px] truncate" title={img.description || ''}>{img.description || '—'}</td>
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
  const { toast } = useToast();
  const [tab, setTab] = useState('endpoints');
  const [endpoints, setEndpoints] = useState(null);
  const [projects, setProjects] = useState(null);
  const [catalogSources, setCatalogSources] = useState(null);
  const [images, setImages] = useState(null);
  const [imageMappings, setImageMappings] = useState(null);
  const [flavors, setFlavors] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aria/endpoints').then(({ data }) => setEndpoints(data)).catch(() => setEndpoints([])),
    client.get('/aria/projects').then(({ data }) => setProjects(data)).catch(() => setProjects([])),
    client.get('/aria/catalog-sources').then(({ data }) => setCatalogSources(data)).catch(() => setCatalogSources([])),
    client.get('/aria/images').then(({ data }) => setImages(data)).catch(() => setImages([])),
    client.get('/aria/image-mappings').then(({ data }) => setImageMappings(data)).catch(() => setImageMappings([])),
    client.get('/aria/flavor-mappings').then(({ data }) => setFlavors(data)).catch(() => setFlavors([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => toast({ type: 'error', title: 'Failed to load infrastructure data' })), [toast]);

  useEffect(() => { load(); }, [load]);

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
      {tab === 'images' && (<><ImageMappingsTable rows={imageMappings} /><FabricImagesTable rows={images} /></>)}
      {tab === 'flavors' && <FlavorsTable rows={flavors} />}
    </div>
  );
}
