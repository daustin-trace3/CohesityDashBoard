import { useEffect, useState, useCallback } from 'react';
import { Server, Cable, FolderKanban, Import } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen, statusTone } from './helpers';

const TABS = [
  { key: 'endpoints', label: 'Endpoints', icon: Cable },
  { key: 'projects', label: 'Projects', icon: FolderKanban },
  { key: 'catalog', label: 'Catalog Sources', icon: Import },
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

export default function AriaInfrastructurePage() {
  const { toast } = useToast();
  const [tab, setTab] = useState('endpoints');
  const [endpoints, setEndpoints] = useState(null);
  const [projects, setProjects] = useState(null);
  const [catalogSources, setCatalogSources] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aria/endpoints').then(({ data }) => setEndpoints(data)).catch(() => setEndpoints([])),
    client.get('/aria/projects').then(({ data }) => setProjects(data)).catch(() => setProjects([])),
    client.get('/aria/catalog-sources').then(({ data }) => setCatalogSources(data)).catch(() => setCatalogSources([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => toast({ type: 'error', title: 'Failed to load infrastructure data' })), [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Infrastructure" description="Cloud accounts, integrations, projects and catalog content sources">
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
    </div>
  );
}
