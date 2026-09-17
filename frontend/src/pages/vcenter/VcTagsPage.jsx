import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tag } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';
import { VmDetailModal } from './VmModals';

// vSphere tags arrive on each VM as "Category: Name" strings (vcenter_vms.tags,
// JSON). This page turns that into a browsable catalog: pick one or more tags,
// get the matching VM list, export it as CSV.
export const UNTAGGED = '(untagged)';

export function parseTags(t) {
  if (Array.isArray(t)) return t.map(String);
  try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
export function splitTag(tag) {
  const i = tag.indexOf(':');
  return i === -1 ? { category: 'Uncategorized', name: tag.trim() } : { category: tag.slice(0, i).trim(), name: tag.slice(i + 1).trim() };
}
export function filterByTags(vms, selected, match) {
  if (!selected.size) return vms;
  const wantUntagged = selected.has(UNTAGGED);
  const wanted = [...selected].filter((t) => t !== UNTAGGED);
  return vms.filter((v) => {
    const tags = v.tagList || [];
    if (wantUntagged && tags.length === 0) return match === 'any' || wanted.length === 0;
    if (!wanted.length) return false;
    return match === 'all' ? wanted.every((t) => tags.includes(t)) : wanted.some((t) => tags.includes(t));
  });
}

const powerLabel = (p) => String(p || '-').replace(/^POWERED_|^powered/i, '').replace(/^_/, '').toUpperCase() || '-';
const powerTone = (p) => p === 'POWERED_ON' || p === 'poweredOn' ? 'ok' : p === 'POWERED_OFF' || p === 'poweredOff' ? 'neutral' : 'warn';
const fmtMem = (mb) => mb == null ? '-' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CSV_COLUMNS = [
  { label: 'VM', get: 'name' },
  { label: 'vCenter', get: 'vcenter_name' },
  { label: 'Cluster', get: 'cluster_name' },
  { label: 'Host', get: 'host_name' },
  { label: 'Power', get: 'power' },
  { label: 'Guest OS', get: 'guest_os' },
  { label: 'IP', get: 'ip_address' },
  { label: 'vCPU', get: 'cpu_count' },
  { label: 'Memory MB', get: 'memory_mb' },
  { label: 'Tags', get: 'tags_text' },
];

export default function VcTagsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailVmId, setDetailVmId] = useState(null);
  const [tagSearch, setTagSearch] = useState('');
  const [params, setParams] = useSearchParams();

  const selected = useMemo(() => new Set(params.getAll('tag')), [params]);
  const match = params.get('match') === 'all' ? 'all' : 'any';

  const writeParams = useCallback((set, mode) => {
    const next = new URLSearchParams();
    for (const t of set) next.append('tag', t);
    if (mode === 'all') next.set('match', 'all');
    setParams(next, { replace: true });
  }, [setParams]);

  const toggleTag = (tag) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    writeParams(next, match);
  };

  const load = useCallback(() => client.get('/vcenter/vms')
    .then(({ data }) => {
      setRows((Array.isArray(data) ? data : []).map((v) => ({ ...v, tagList: parseTags(v.tags) })));
      setLastRefreshed(new Date());
    })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load VM inventory' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  // Catalog: category -> tags with VM counts, plus the untagged count.
  const catalog = useMemo(() => {
    const counts = new Map();
    let untagged = 0;
    for (const v of rows || []) {
      if (!v.tagList.length) untagged += 1;
      for (const t of v.tagList) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const byCategory = new Map();
    for (const [tag, count] of counts) {
      const { category, name } = splitTag(tag);
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push({ tag, name, count });
    }
    const categories = [...byCategory.entries()]
      .map(([category, tags]) => ({ category, tags: tags.sort((a, b) => a.name.localeCompare(b.name)), total: tags.reduce((s, t) => s + t.count, 0) }))
      .sort((a, b) => a.category.localeCompare(b.category));
    return { categories, untagged, distinct: counts.size };
  }, [rows]);

  const q = tagSearch.trim().toLowerCase();
  const visibleCategories = catalog.categories
    .map((c) => ({ ...c, tags: q ? c.tags.filter((t) => t.tag.toLowerCase().includes(q)) : c.tags }))
    .filter((c) => c.tags.length);

  const filtered = useMemo(() => filterByTags(rows || [], selected, match), [rows, selected, match]);
  const list = useMemo(() => filtered.map((v) => ({
    ...v,
    power: powerLabel(v.power_state),
    tags_text: v.tagList.join('; '),
  })), [filtered]);

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'guest_os', 'host_name', 'cluster_name', 'vcenter_name', 'ip_address', 'tags_text'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  const filename = selected.size
    ? `vcenter-tags-${[...selected].map(slug).join('+').slice(0, 80)}`
    : 'vcenter-tags-all-vms';

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Tag} title="Tags" description="Filter VMs by vSphere tag and export the list">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {rows == null ? (
        <LoadingPanel label="Loading VM inventory" height={160} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] gap-4 items-start">
          <aside className="panel p-3" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink">
                {fmtNum(catalog.distinct)} tags in {fmtNum(catalog.categories.length)} categories
              </p>
              {selected.size > 0 && (
                <button onClick={() => writeParams(new Set(), match)} className="text-[11px] font-semibold text-brand hover:text-brand-bright cursor-pointer">Clear</button>
              )}
            </div>
            <input
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder="Find a tag"
              className="w-full mb-3 bg-surface-overlay border border-cohesity-border rounded-lg px-2.5 py-1.5 text-xs text-ink focus:border-brand/60 outline-none"
            />
            <div className="max-h-[70vh] overflow-y-auto pr-1 flex flex-col gap-3">
              {visibleCategories.map((c) => (
                <div key={c.category}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">{c.category}</p>
                  <div className="flex flex-col">
                    {c.tags.map((t) => {
                      const on = selected.has(t.tag);
                      return (
                        <button
                          key={t.tag}
                          onClick={() => toggleTag(t.tag)}
                          className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-xs text-left cursor-pointer transition-colors ${on ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay'}`}
                        >
                          <span className="truncate">{t.name}</span>
                          <span className="tnum text-[11px] text-ink-faint flex-shrink-0">{fmtNum(t.count)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {!q && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1">Other</p>
                  <button
                    onClick={() => toggleTag(UNTAGGED)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs text-left cursor-pointer transition-colors ${selected.has(UNTAGGED) ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay'}`}
                  >
                    <span>No tags</span>
                    <span className="tnum text-[11px] text-ink-faint">{fmtNum(catalog.untagged)}</span>
                  </button>
                </div>
              )}
              {visibleCategories.length === 0 && q && <p className="text-xs text-ink-muted">No tag matches "{tagSearch}".</p>}
              {catalog.distinct === 0 && !q && <p className="text-xs text-ink-muted">No tags collected yet. Tags appear after the next poll of a vCenter that has them.</p>}
            </div>
          </aside>

          <div className="panel p-4 min-w-0" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              {selected.size === 0 ? (
                <span className="text-xs text-ink-muted">All VMs. Pick a tag on the left to narrow the list.</span>
              ) : (
                <>
                  {[...selected].map((t) => (
                    <button key={t} onClick={() => toggleTag(t)} title="Remove"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-brand/10 border border-brand/30 text-brand cursor-pointer">
                      {t} <span aria-hidden="true">x</span>
                    </button>
                  ))}
                  {selected.size > 1 && (
                    <div className="inline-flex items-center rounded-lg border border-cohesity-border p-0.5 ml-1">
                      {['any', 'all'].map((m) => (
                        <button key={m} onClick={() => writeParams(selected, m)}
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${match === m ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink'}`}>
                          {m === 'any' ? 'Any tag' : 'All tags'}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <span className="ml-auto text-xs text-ink-muted tnum">{fmtNum(ctl.rows.length)} of {fmtNum(list.length)} VMs</span>
              <CsvExportButton filename={filename} columns={CSV_COLUMNS} rows={ctl.rows} />
            </div>

            <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VM, OS, host, cluster, vCenter, IP or tag"
              filters={[
                { k: 'vcenter_name', label: 'vCenters' },
                { k: 'cluster_name', label: 'Clusters' },
                { k: 'power', label: 'Power states' },
              ]} />

            {list.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No VMs carry the selected tag{selected.size > 1 ? 's' : ''}.</div>
            ) : ctl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No VMs match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="name" label="VM" ctl={ctl} />
                    <SortTh k="power" label="Power" ctl={ctl} />
                    <SortTh k="vcenter_name" label="vCenter" ctl={ctl} />
                    <SortTh k="cluster_name" label="Cluster" ctl={ctl} />
                    <SortTh k="host_name" label="Host" ctl={ctl} />
                    <SortTh k="guest_os" label="Guest OS" ctl={ctl} />
                    <SortTh k="ip_address" label="IP" ctl={ctl} />
                    <SortTh k="cpu_count" label="vCPU" ctl={ctl} align="right" />
                    <SortTh k="memory_mb" label="Memory" ctl={ctl} align="right" />
                    <SortTh k="tags_text" label="Tags" ctl={ctl} />
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((v) => (
                      <tr key={`${v.vcenter_id}|${v.vm_id || v.id}`} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <button onClick={() => setDetailVmId(v.id)} className="text-brand hover:underline cursor-pointer text-left">{v.name || '-'}</button>
                        </td>
                        <td className="py-2 pr-3"><Badge tone={powerTone(v.power_state)}>{v.power}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.vcenter_name}</td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.cluster_name || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.host_name || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[200px] truncate" title={v.guest_os || ''}>{v.guest_os || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.ip_address || '-'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.cpu_count)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {v.tagList.length === 0 && <span className="text-ink-faint text-[11px]">-</span>}
                            {v.tagList.map((t) => (
                              <button key={t} onClick={() => toggleTag(t)} title={selected.has(t) ? 'Remove from filter' : 'Add to filter'}
                                className={`px-1.5 py-px rounded text-[10px] border cursor-pointer ${selected.has(t) ? 'border-brand/40 bg-brand/10 text-brand' : 'border-cohesity-border text-ink-muted hover:text-ink'}`}>
                                {t}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <TablePager ctl={ctl} />
              </div>
            )}
          </div>
        </div>
      )}

      {detailVmId != null && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
