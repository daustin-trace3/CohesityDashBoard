// Cohesity plugin — Cluster Management page. Ported from
// frontend/src/pages/ClusterManagement.jsx. Uses the DirectClusterForm
// exported from settings.jsx (host's ClusterManagement imports it from
// components/cohesity/DirectClustersTab.jsx — folded into settings.jsx here
// since both live in this WP-C pack).
import { apiFetch, useToast, PageHeader, SkeletonTable, downloadBlob } from '../ui.jsx';
import { Server, Upload, Settings, Save } from '../icons.jsx';
import { DirectClusterForm } from './settings.jsx';

function HeliosClusterEditForm({ initial, onSaved, onCancel }) {
  const [name, setName] = React.useState(initial.name || '');
  const [pollingInterval, setPollingInterval] = React.useState(initial.polling_interval_minutes || 60);
  const [apiKey, setApiKey] = React.useState('');
  const [tags, setTags] = React.useState(initial.tags ? initial.tags.split(',').map((t) => t.trim()).filter(Boolean) : []);
  const [tagInput, setTagInput] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);

  const addTag = () => { const t = tagInput.trim(); if (t && !tags.includes(t)) setTags((prev) => [...prev, t]); setTagInput(''); };

  const handleSave = async () => {
    setError(null);
    setSubmitting(true);
    const payload = { name: name.trim(), polling_interval_minutes: Number(pollingInterval) || 60, tags: tags.join(', ') };
    if (apiKey) payload.credentials = { apiKey };
    try { await apiFetch(`/cohesity/clusters/${initial.id}`, { method: 'PUT', body: payload }); onSaved(); }
    catch (err) { setError(err.payload?.error || err.payload?.errors?.[0]?.msg || 'Save failed.'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="panel" style={{ padding: 20, marginBottom: 24 }}>
      <h3 style={{ color: 'var(--co-ink)', fontWeight: 600, margin: '0 0 12px' }}>Edit — {initial.name}</h3>
      {error && <div style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.4)', color: '#fca5a5', fontSize: 13, borderRadius: 6, padding: 12, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Cluster Name *</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className="co-input" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>API Key <span>(optional — leave blank to keep the stored key / global Helios key)</span></label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="•••••• (stored — leave blank to keep)" autoComplete="new-password" className="co-input" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Tags</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {tags.map((tag) => (
              <span key={tag} className="chip" style={{ background: 'var(--co-surface-base)', border: '1px solid var(--co-border)', color: 'var(--co-brand)' }}>
                {tag} <button type="button" onClick={() => setTags((prev) => prev.filter((t) => t !== tag))} style={{ background: 'none', border: 'none', color: 'var(--co-ink-faint)', cursor: 'pointer' }}>×</button>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="text" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }} placeholder="Type a tag and press Enter" className="co-input" />
            <button type="button" onClick={addTag} className="co-btn-ghost">Add</button>
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--co-ink-faint)', marginBottom: 4 }}>Poll interval</label>
          <select value={pollingInterval} onChange={(e) => setPollingInterval(Number(e.target.value))} className="co-input" style={{ width: 'auto' }}>
            {[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 12, paddingTop: 8 }}>
          <button onClick={handleSave} disabled={submitting || !name.trim()} className="co-btn-ghost" style={{ background: 'var(--co-brand)', color: '#0B1015', borderColor: 'var(--co-brand)' }}>
            <Save size={13} /> {submitting ? 'Saving...' : 'Save'}
          </button>
          <button type="button" onClick={onCancel} className="co-btn-ghost">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function TagInputWidget({ value, onChange }) {
  const [input, setInput] = React.useState('');
  const add = () => { const t = input.trim(); if (t && !value.includes(t)) onChange([...value, t]); setInput(''); };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, minHeight: 24 }}>
        {value.map((tag) => (
          <span key={tag} className="chip" style={{ background: 'var(--co-surface-base)', border: '1px solid var(--co-border)', color: 'var(--co-brand)' }}>
            {tag} <button type="button" onClick={() => onChange(value.filter((t) => t !== tag))} style={{ background: 'none', border: 'none', color: 'var(--co-ink-faint)', cursor: 'pointer' }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }} placeholder="Type tag + Enter" className="co-input" />
        <button type="button" onClick={add} className="co-btn-ghost">Add</button>
      </div>
    </div>
  );
}

function BulkEditModal({ mode, clusters, selectedIds, onReplaceTags, onAppendTags, onCredentials, onClose }) {
  const [tags, setTags] = React.useState([]);
  const [apiKey, setApiKey] = React.useState('');
  const applicableCount = mode === 'credentials' ? clusters.filter((c) => selectedIds.has(c.id) && c.auth_type === 'apikey').length : selectedIds.size;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="panel shadow-xl" style={{ padding: 20, width: '100%', maxWidth: 380 }}>
        <h3 style={{ color: 'var(--co-ink)', fontWeight: 600, margin: '0 0 12px' }}>
          {mode === 'replaceTags' && `Replace Tags — ${applicableCount} cluster(s)`}
          {mode === 'appendTags' && `Append Tags — ${applicableCount} cluster(s)`}
          {mode === 'credentials' && `Update API Key — ${applicableCount} cluster(s)`}
        </h3>
        {(mode === 'replaceTags' || mode === 'appendTags') && (
          <>
            <TagInputWidget value={tags} onChange={setTags} />
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button onClick={() => (mode === 'replaceTags' ? onReplaceTags(tags) : onAppendTags(tags))} className="co-btn-ghost" style={{ background: 'var(--co-brand)', color: '#0B1015' }}>Save</button>
              <button onClick={onClose} className="co-btn-ghost">Cancel</button>
            </div>
          </>
        )}
        {mode === 'credentials' && (
          <>
            {applicableCount === 0 ? <p style={{ fontSize: 13, color: 'var(--co-ink-muted)' }}>No selected clusters use API key auth.</p> : (
              <>
                <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', marginBottom: 12 }}>Applies to {applicableCount} cluster(s) with API key auth. Clusters using username/password will be skipped.</p>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="New API key" autoComplete="new-password" className="co-input" />
              </>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              {applicableCount > 0 && <button onClick={() => onCredentials(apiKey)} disabled={!apiKey} className="co-btn-ghost" style={{ background: 'var(--co-brand)', color: '#0B1015' }}>Save</button>}
              <button onClick={onClose} className="co-btn-ghost">Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ClusterManagementPage() {
  const [clusters, setClusters] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState(null);
  const [deleteConfirm, setDeleteConfirm] = React.useState(null);
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  const [bulkModal, setBulkModal] = React.useState(null);
  const [bulkConfirmDelete, setBulkConfirmDelete] = React.useState(false);
  const [clusterSearch, setClusterSearch] = React.useState('');
  const [clusterTypeFilter, setClusterTypeFilter] = React.useState('all');
  const [clusterTagFilter, setClusterTagFilter] = React.useState('all');
  const [expandedId, setExpandedId] = React.useState(null);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importFile, setImportFile] = React.useState(null);
  const [importLoading, setImportLoading] = React.useState(false);
  const [importResult, setImportResult] = React.useState(null);
  const [importOverwrite, setImportOverwrite] = React.useState(false);

  const loadClusters = () => {
    apiFetch('/cohesity/clusters').then(setClusters).catch(() => {}).finally(() => setLoading(false));
  };

  React.useEffect(() => { loadClusters(); }, []);

  const handleDelete = async (id) => {
    try { await apiFetch(`/cohesity/clusters/${id}`, { method: 'DELETE' }); toast({ type: 'success', title: 'Cluster deleted' }); setClusters((prev) => prev.filter((c) => c.id !== id)); }
    catch { toast({ type: 'error', title: 'Failed to delete cluster' }); }
    finally { setDeleteConfirm(null); }
  };

  const handleBulkReplaceTags = async (newTags) => {
    const tagStr = newTags.join(', ');
    await Promise.allSettled([...selectedIds].map((id) => apiFetch(`/cohesity/clusters/${id}`, { method: 'PUT', body: { tags: tagStr } })));
    toast({ type: 'success', title: `Tags updated on ${selectedIds.size} cluster(s)` });
    setSelectedIds(new Set()); setBulkModal(null); loadClusters();
  };

  const handleBulkAppendTags = async (newTags) => {
    await Promise.allSettled([...selectedIds].map((id) => {
      const cluster = clusters.find((c) => c.id === id);
      const existing = (cluster?.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...newTags])];
      return apiFetch(`/cohesity/clusters/${id}`, { method: 'PUT', body: { tags: merged.join(', ') } });
    }));
    toast({ type: 'success', title: `Tags appended to ${selectedIds.size} cluster(s)` });
    setSelectedIds(new Set()); setBulkModal(null); loadClusters();
  };

  const handleBulkCredentials = async (apiKey) => {
    const applicable = clusters.filter((c) => selectedIds.has(c.id) && c.auth_type === 'apikey');
    await Promise.allSettled(applicable.map((c) => apiFetch(`/cohesity/clusters/${c.id}`, { method: 'PUT', body: { credentials: { apiKey } } })));
    toast({ type: 'success', title: `Credentials updated on ${applicable.length} cluster(s)` });
    setSelectedIds(new Set()); setBulkModal(null); loadClusters();
  };

  const handleBulkDelete = async () => {
    await Promise.allSettled([...selectedIds].map((id) => apiFetch(`/cohesity/clusters/${id}`, { method: 'DELETE' })));
    toast({ type: 'success', title: `Deleted ${selectedIds.size} cluster(s)` });
    setSelectedIds(new Set()); setBulkConfirmDelete(false); loadClusters();
  };

  const allClusterTags = [...new Set(clusters.flatMap((c) => (c.tags || '').split(',').map((t) => t.trim()).filter(Boolean)))].sort();

  const filteredClusters = clusters.filter((c) => {
    if (clusterSearch && !c.name.toLowerCase().includes(clusterSearch.toLowerCase())) return false;
    if (clusterTypeFilter !== 'all' && c.connection_type !== clusterTypeFilter) return false;
    if (clusterTagFilter !== 'all' && !(c.tags || '').split(',').map((t) => t.trim()).includes(clusterTagFilter)) return false;
    return true;
  });

  return (
    <>
      <div style={{ position: 'relative' }}>
        <PageHeader icon={Server} title="Cluster Management" description="Connect, organize, and maintain Cohesity clusters across your estate">
          <button onClick={() => setImportOpen(true)} className="co-btn-ghost" style={{ background: 'var(--co-surface)', color: 'var(--co-brand)' }}>
            <Upload size={13} /> Import CSV
          </button>
        </PageHeader>

        <p style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginTop: -12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Settings size={12} /> Clusters are added on the <a href="#/cohesity/settings" style={{ color: 'var(--co-brand)' }}>Settings</a> page (Helios / Direct tabs).
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <input type="text" value={clusterSearch} onChange={(e) => setClusterSearch(e.target.value)} placeholder="Search clusters..." className="co-input" style={{ width: 160 }} />
          <select value={clusterTypeFilter} onChange={(e) => setClusterTypeFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
            <option value="all">All Types</option><option value="helios">Helios</option><option value="direct">Direct</option>
          </select>
          <select value={clusterTagFilter} onChange={(e) => setClusterTagFilter(e.target.value)} className="co-input" style={{ width: 'auto' }}>
            <option value="all">All Tags</option>
            {allClusterTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
          <span style={{ fontSize: 11, color: 'var(--co-ink-faint)', marginLeft: 'auto' }}>{filteredClusters.length} of {clusters.length}</span>
        </div>

        {mode?.edit && mode.edit.connection_type === 'direct' && (
          <div style={{ marginBottom: 24 }}>
            <DirectClusterForm initial={mode.edit} onSaved={() => { setMode(null); toast({ type: 'success', title: 'Cluster updated' }); loadClusters(); }} onCancel={() => setMode(null)} />
          </div>
        )}
        {mode?.edit && mode.edit.connection_type === 'helios' && (
          <HeliosClusterEditForm initial={mode.edit} onSaved={() => { setMode(null); toast({ type: 'success', title: 'Cluster updated' }); loadClusters(); }} onCancel={() => setMode(null)} />
        )}

        {loading ? (
          <div className="panel" style={{ padding: 16 }}><SkeletonTable rows={6} cols={5} /></div>
        ) : clusters.length === 0 ? (
          <div style={{ color: 'var(--co-ink-faint)', fontSize: 13 }}>No clusters configured.</div>
        ) : filteredClusters.length === 0 ? (
          <div style={{ color: 'var(--co-ink-faint)', fontSize: 13 }}>No clusters match the current filters.</div>
        ) : (
          <div style={{ border: '1px solid var(--co-border)', borderRadius: 8, overflow: 'hidden', paddingBottom: 80 }}>
            {filteredClusters.map((cluster, idx) => {
              const isSelected = selectedIds.has(cluster.id);
              const isExpanded = expandedId === cluster.id;
              const clusterTags = (cluster.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
              return (
                <div key={cluster.id} style={{ background: isSelected ? 'rgba(108,179,63,0.05)' : 'var(--co-surface)', borderTop: idx === 0 ? 'none' : '1px solid var(--co-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }} onClick={() => setExpandedId(isExpanded ? null : cluster.id)}>
                    <input type="checkbox" checked={isSelected} onClick={(e) => e.stopPropagation()}
                      onChange={() => setSelectedIds((prev) => { const next = new Set(prev); next.has(cluster.id) ? next.delete(cluster.id) : next.add(cluster.id); return next; })}
                      className="accent-cohesity-green" style={{ flexShrink: 0 }} />
                    <span style={{ color: 'var(--co-ink-faint)', fontSize: 11, flexShrink: 0, display: 'inline-block', transition: 'transform 150ms', transform: isExpanded ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)' }}>{cluster.name}</span>
                      {clusterTags.length > 0 && clusterTags.map((tag) => (
                        <span key={tag} style={{ fontSize: 10, background: 'var(--co-black)', border: '1px solid var(--co-border)', color: 'var(--co-brand)', padding: '1px 6px', borderRadius: 4, marginLeft: 6 }}>{tag}</span>
                      ))}
                    </div>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: '1px solid', flexShrink: 0, ...(cluster.connection_type === 'helios' ? { color: '#d8b4fe', background: '#581c87', borderColor: '#7e22ce' } : { color: '#67e8f9', background: '#164e63', borderColor: '#0e7490' }) }}>
                      {cluster.connection_type}
                    </span>
                    <span className="truncate hidden md:block" style={{ fontSize: 11, color: 'var(--co-ink-faint)', flexShrink: 0, width: 160 }}>{cluster.vip || '—'}</span>
                    <span className="hidden lg:block" style={{ fontSize: 11, color: 'var(--co-ink-faint)', flexShrink: 0 }}>{cluster.polling_interval_minutes}m</span>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 8 }} onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setMode({ edit: cluster }); setExpandedId(null); }} className="co-btn-ghost" style={{ padding: '4px 8px' }}>Edit</button>
                      <button onClick={() => setDeleteConfirm(cluster)} className="co-btn-ghost" style={{ padding: '4px 8px', color: 'var(--co-crit)' }}>Delete</button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: '16px 40px', background: 'var(--co-black)', borderTop: '1px solid var(--co-border)' }}>
                      <div className="grid grid-cols-2 md:grid-cols-4" style={{ gap: 16, fontSize: 13, marginBottom: 16 }}>
                        <div><p style={{ fontSize: 10, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: '0 0 2px' }}>VIP / Cluster ID</p><p style={{ color: 'var(--co-ink)', fontFamily: 'monospace', fontSize: 12, margin: 0 }}>{cluster.vip || '—'}</p></div>
                        <div><p style={{ fontSize: 10, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: '0 0 2px' }}>Auth Type</p><p style={{ color: 'var(--co-ink)', margin: 0 }}>{cluster.auth_type}</p></div>
                        <div><p style={{ fontSize: 10, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: '0 0 2px' }}>SSL Verify</p><p style={{ color: cluster.ssl_verify ? 'var(--co-brand)' : 'var(--co-ink-faint)', margin: 0 }}>{cluster.ssl_verify ? 'Enabled' : 'Disabled'}</p></div>
                        <div><p style={{ fontSize: 10, color: 'var(--co-ink-faint)', textTransform: 'uppercase', margin: '0 0 2px' }}>Added</p><p style={{ color: 'var(--co-ink)', margin: 0 }}>{cluster.created_at ? new Date(cluster.created_at).toLocaleDateString() : '—'}</p></div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--co-border)' }}>
                        <button onClick={() => { setMode({ edit: cluster }); setExpandedId(null); }} className="co-btn-ghost">Edit Cluster</button>
                        <button onClick={() => setDeleteConfirm(cluster)} className="co-btn-ghost" style={{ color: 'var(--co-crit)' }}>Delete</button>
                        <button onClick={() => setExpandedId(null)} className="co-btn-ghost">Collapse</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {selectedIds.size > 0 && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40, background: '#111111', borderTop: '1px solid var(--co-border)', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)' }}>{selectedIds.size} selected</span>
            {!bulkConfirmDelete ? (
              <>
                <button onClick={() => setBulkModal('replaceTags')} className="co-btn-ghost">Replace Tags</button>
                <button onClick={() => setBulkModal('appendTags')} className="co-btn-ghost">Append Tags</button>
                <button onClick={() => setBulkModal('credentials')} className="co-btn-ghost">Update Credentials</button>
                <button onClick={() => setBulkConfirmDelete(true)} className="co-btn-ghost" style={{ color: 'var(--co-crit)' }}>Delete Selected</button>
                <button onClick={() => setSelectedIds(new Set())} className="co-btn-ghost">Cancel</button>
              </>
            ) : (
              <>
                <span style={{ fontSize: 13, color: 'var(--co-crit)' }}>Delete {selectedIds.size} cluster(s)? This is irreversible.</span>
                <button onClick={handleBulkDelete} className="co-btn-ghost" style={{ background: '#b91c1c', color: '#fff' }}>Confirm Delete</button>
                <button onClick={() => setBulkConfirmDelete(false)} className="co-btn-ghost">Cancel</button>
              </>
            )}
          </div>
        )}

        {bulkModal && <BulkEditModal mode={bulkModal} clusters={clusters} selectedIds={selectedIds} onReplaceTags={handleBulkReplaceTags} onAppendTags={handleBulkAppendTags} onCredentials={handleBulkCredentials} onClose={() => setBulkModal(null)} />}

        {deleteConfirm && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div className="panel shadow-xl" style={{ padding: 20, width: '100%', maxWidth: 380 }}>
              <h3 style={{ color: 'var(--co-ink)', fontWeight: 600, margin: '0 0 8px' }}>Delete Cluster</h3>
              <p style={{ fontSize: 13, color: 'var(--co-ink-muted)', margin: '0 0 16px' }}>Are you sure you want to delete <strong>{deleteConfirm.name}</strong>? This will also delete all associated metrics and alerts.</p>
              <div style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => handleDelete(deleteConfirm.id)} className="co-btn-ghost" style={{ background: '#b91c1c', color: '#fff' }}>Delete</button>
                <button onClick={() => setDeleteConfirm(null)} className="co-btn-ghost">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {importOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div className="panel" style={{ padding: 20, width: '100%', maxWidth: 420 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--co-ink)', margin: '0 0 16px' }}>Import Historical Capacity CSV</h2>
            <p style={{ fontSize: 11, color: 'var(--co-ink-muted)', marginBottom: 12 }}>
              Expected columns: <code style={{ color: 'var(--co-brand)' }}>Timestamp, Zone, Cluster, LocalUsedTB, PhysicalUsedTB, ClusterUsageTB, ClusterAvailableTB, TotalCapacityTB, PercentUsed, PercentFree, DedupeRatio, NodeCount</code>
            </p>
            <input type="file" accept=".csv,text/csv" onChange={(e) => { setImportFile(e.target.files[0]); setImportResult(null); }} style={{ fontSize: 11, color: 'var(--co-ink-muted)', marginBottom: 12, width: '100%' }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--co-ink-muted)', marginBottom: 16, cursor: 'pointer' }}>
              <input type="checkbox" checked={importOverwrite} onChange={(e) => setImportOverwrite(e.target.checked)} className="accent-cohesity-green" />
              <span>Overwrite existing rows <span style={{ color: 'var(--co-warn)' }}>(fixes previously imported data)</span></span>
            </label>
            {importResult && (
              <div style={{ fontSize: 11, marginBottom: 16, padding: 12, borderRadius: 6, border: '1px solid var(--co-border)', background: 'var(--co-black)' }}>
                {importResult.error ? <p style={{ color: 'var(--co-crit)' }}>✗ Error: {importResult.error}</p> : (
                  <>
                    <p style={{ color: 'var(--co-brand)' }}>✓ Imported: {importResult.imported}</p>
                    {importResult.overwritten > 0 && <p style={{ color: 'var(--co-warn)' }}>↻ Overwritten: {importResult.overwritten}</p>}
                    <p style={{ color: 'var(--co-ink-muted)' }}>Skipped (duplicates): {importResult.skipped}</p>
                    {importResult.unmatched?.length > 0 && <p style={{ color: 'var(--co-warn)', marginTop: 4 }}>Unmatched clusters: {importResult.unmatched.join(', ')}</p>}
                  </>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setImportOpen(false); setImportFile(null); setImportResult(null); setImportOverwrite(false); }} className="co-btn-ghost">{importResult ? 'Close' : 'Cancel'}</button>
              {!importResult && (
                <button disabled={!importFile || importLoading} className="co-btn-ghost" style={{ background: 'var(--co-brand)', color: '#0B1015' }}
                  onClick={async () => {
                    if (!importFile) return;
                    setImportLoading(true);
                    try {
                      const text = await importFile.text();
                      const data = await apiFetch(`/cohesity/import/history${importOverwrite ? '?overwrite=true' : ''}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text });
                      setImportResult(data);
                    } catch (err) { setImportResult({ imported: 0, skipped: 0, unmatched: [], error: err.payload?.error || err.message }); }
                    finally { setImportLoading(false); }
                  }}>
                  {importLoading ? 'Importing...' : 'Import'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
