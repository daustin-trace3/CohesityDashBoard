// vCenter Tags: ported from frontend/src/pages/vcenter/VcTagsPage.jsx.
// vSphere tags arrive on each VM as "Category: Name" strings (vcenter_vms.tags,
// JSON). Pick one or more tags, get the matching VM list, export it as CSV.
import { Tag, Download } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager,
  BRAND, fmtNum,
} from '../ui.jsx';
import { VmDetailModal } from '../vmModals.jsx';

const UNTAGGED = '(untagged)';

function parseTags(t) {
  if (Array.isArray(t)) return t.map(String);
  try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}
function splitTag(tag) {
  const i = tag.indexOf(':');
  return i === -1 ? { category: 'Uncategorized', name: tag.trim() } : { category: tag.slice(0, i).trim(), name: tag.slice(i + 1).trim() };
}
function filterByTags(vms, selected, match) {
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

// The plugin stylesheet has no CSV button; same Blob download as the host's.
function exportCsv(filename, columns, rows) {
  const esc = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows || []) lines.push(columns.map((c) => esc(r[c.get])).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readInitialSelection() {
  try {
    const sp = new URLSearchParams(window.location.search);
    return { selected: new Set(sp.getAll('tag')), match: sp.get('match') === 'all' ? 'all' : 'any' };
  } catch { return { selected: new Set(), match: 'any' }; }
}

const pillStyle = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
  border: `1px solid ${on ? 'rgba(0,145,218,.4)' : 'var(--vc-border)'}`, background: on ? 'rgba(0,145,218,.1)' : 'transparent',
  color: on ? 'var(--vc-brand)' : 'var(--vc-ink-muted, inherit)', cursor: 'pointer',
});
const tagRowStyle = (on) => ({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '4px 8px',
  borderRadius: 6, fontSize: 12, textAlign: 'left', cursor: 'pointer', border: 'none',
  background: on ? 'rgba(0,145,218,.1)' : 'transparent', color: on ? 'var(--vc-brand)' : 'inherit',
});

export default function VcTagsPage() {
  const initial = React.useMemo(readInitialSelection, []);
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailVmId, setDetailVmId] = React.useState(null);
  const [tagSearch, setTagSearch] = React.useState('');
  const [selected, setSelected] = React.useState(initial.selected);
  const [match, setMatch] = React.useState(initial.match);

  const toggleTag = (tag) => setSelected((prev) => { const next = new Set(prev); if (next.has(tag)) next.delete(tag); else next.add(tag); return next; });

  const load = React.useCallback(() => apiFetch('/vcenter/vms')
    .then((json) => {
      setRows((Array.isArray(json) ? json : []).map((v) => ({ ...v, tagList: parseTags(v.tags) })));
      setLastRefreshed(new Date());
    })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const catalog = React.useMemo(() => {
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
      .map(([category, tags]) => ({ category, tags: tags.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.category.localeCompare(b.category));
    return { categories, untagged, distinct: counts.size };
  }, [rows]);

  const q = tagSearch.trim().toLowerCase();
  const visibleCategories = catalog.categories
    .map((c) => ({ ...c, tags: q ? c.tags.filter((t) => t.tag.toLowerCase().includes(q)) : c.tags }))
    .filter((c) => c.tags.length);

  const filtered = React.useMemo(() => filterByTags(rows || [], selected, match), [rows, selected, match]);
  const list = React.useMemo(() => filtered.map((v) => ({ ...v, power: powerLabel(v.power_state), tags_text: v.tagList.join('; ') })), [filtered]);

  const ctl = useTableControls(list, {
    searchKeys: ['name', 'guest_os', 'host_name', 'cluster_name', 'vcenter_name', 'ip_address', 'tags_text'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  const filename = selected.size ? `vcenter-tags-${[...selected].map(slug).join('+').slice(0, 80)}` : 'vcenter-tags-all-vms';

  return (
    <div>
      <PageHeader icon={Tag} title="Tags" description="Filter VMs by vSphere tag and export the list">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {rows == null ? (
        <LoadingPanel label="Loading VM inventory" height={160} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 18rem) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <aside className="panel p-3" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink">{fmtNum(catalog.distinct)} tags in {fmtNum(catalog.categories.length)} categories</p>
              {selected.size > 0 && (
                <button onClick={() => setSelected(new Set())} className="text-brand" style={{ fontSize: 11, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
              )}
            </div>
            <input
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder="Find a tag"
              className="bg-surface-overlay border border-cohesity-border text-ink"
              style={{ width: '100%', marginBottom: 12, borderRadius: 8, padding: '6px 10px', fontSize: 12, outline: 'none' }}
            />
            <div style={{ maxHeight: '70vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4 }}>
              {visibleCategories.map((c) => (
                <div key={c.category}>
                  <p className="text-ink-faint" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{c.category}</p>
                  <div className="flex flex-col">
                    {c.tags.map((t) => (
                      <button key={t.tag} onClick={() => toggleTag(t.tag)} style={tagRowStyle(selected.has(t.tag))} className={selected.has(t.tag) ? '' : 'text-ink-muted'}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                        <span className="tnum text-ink-faint" style={{ fontSize: 11, flexShrink: 0 }}>{fmtNum(t.count)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!q && (
                <div>
                  <p className="text-ink-faint" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Other</p>
                  <button onClick={() => toggleTag(UNTAGGED)} style={tagRowStyle(selected.has(UNTAGGED))} className={selected.has(UNTAGGED) ? '' : 'text-ink-muted'}>
                    <span>No tags</span>
                    <span className="tnum text-ink-faint" style={{ fontSize: 11 }}>{fmtNum(catalog.untagged)}</span>
                  </button>
                </div>
              )}
              {visibleCategories.length === 0 && q && <p className="text-xs text-ink-muted">No tag matches "{tagSearch}".</p>}
              {catalog.distinct === 0 && !q && <p className="text-xs text-ink-muted">No tags collected yet. Tags appear after the next poll of a vCenter that has them.</p>}
            </div>
          </aside>

          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}`, minWidth: 0 }}>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              {selected.size === 0 ? (
                <span className="text-xs text-ink-muted">All VMs. Pick a tag on the left to narrow the list.</span>
              ) : (
                <>
                  {[...selected].map((t) => (
                    <button key={t} onClick={() => toggleTag(t)} title="Remove" style={pillStyle(true)}>{t} <span aria-hidden="true">x</span></button>
                  ))}
                  {selected.size > 1 && (
                    <div className="border border-cohesity-border" style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 8, padding: 2, marginLeft: 4 }}>
                      {['any', 'all'].map((m) => (
                        <button key={m} onClick={() => setMatch(m)} className={match === m ? 'bg-brand/10 text-brand' : 'text-ink-muted'}
                          style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: 'none', background: match === m ? undefined : 'transparent', cursor: 'pointer' }}>
                          {m === 'any' ? 'Any tag' : 'All tags'}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <span className="ml-auto text-xs text-ink-muted tnum">{fmtNum(ctl.rows.length)} of {fmtNum(list.length)} VMs</span>
              <button onClick={() => exportCsv(filename, CSV_COLUMNS, ctl.rows)} disabled={!ctl.rows.length}
                className="border border-cohesity-border text-ink-muted"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'transparent', cursor: ctl.rows.length ? 'pointer' : 'default', opacity: ctl.rows.length ? 1 : 0.5 }}>
                <Download size={12} /> Export
              </button>
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
                          <button onClick={() => setDetailVmId(v.id)} className="text-brand" style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>{v.name || '-'}</button>
                        </td>
                        <td className="py-2 pr-3"><Badge tone={powerTone(v.power_state)}>{v.power}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.vcenter_name}</td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.cluster_name || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.host_name || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[11px]" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.guest_os || ''}>{v.guest_os || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted tnum text-[11px]">{v.ip_address || '-'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.cpu_count)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {v.tagList.length === 0 && <span className="text-ink-faint text-[11px]">-</span>}
                            {v.tagList.map((t) => (
                              <button key={t} onClick={() => toggleTag(t)} title={selected.has(t) ? 'Remove from filter' : 'Add to filter'} style={{ ...pillStyle(selected.has(t)), fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 4 }}>
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
