import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Server, Upload, Settings, Save } from 'lucide-react';
import client from '../api/client';
import { PageHeader } from '../components/ui/primitives';
import SkeletonTable from '../components/SkeletonTable';
import { useToast } from '../components/ui/Toaster';
import { DirectClusterForm } from '../components/cohesity/DirectClustersTab';

function HeliosClusterEditForm({ initial, onSaved, onCancel }) {
  const [name, setName] = useState(initial.name || '');
  const [pollingInterval, setPollingInterval] = useState(initial.polling_interval_minutes || 60);
  const [apiKey, setApiKey] = useState('');
  const [tags, setTags] = useState(
    initial.tags ? initial.tags.split(',').map(t => t.trim()).filter(Boolean) : []
  );
  const [tagInput, setTagInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags(prev => [...prev, t]);
    setTagInput('');
  };

  const handleSave = async () => {
    setError(null);
    setSubmitting(true);
    const payload = {
      name: name.trim(),
      polling_interval_minutes: Number(pollingInterval) || 60,
      tags: tags.join(', '),
    };
    if (apiKey) payload.credentials = { apiKey };
    try {
      await client.put(`/clusters/${initial.id}`, payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 mb-6">
      <h3 className="text-cohesity-text font-semibold mb-4">Edit — {initial.name}</h3>
      {error && <div className="bg-red-900 border border-red-700 text-red-300 text-sm rounded p-3 mb-4">{error}</div>}
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Cluster Name *</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-cohesity-black border border-cohesity-border rounded px-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">
            API Key <span className="text-gray-500">(optional — leave blank to keep the stored key / global Helios key)</span>
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="•••••• (stored — leave blank to keep)"
            autoComplete="new-password"
            className="w-full bg-cohesity-black border border-cohesity-border rounded px-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Tags</label>
          <div className="flex gap-2 flex-wrap mb-2">
            {tags.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 bg-cohesity-black border border-cohesity-border text-xs text-cohesity-green px-2 py-0.5 rounded">
                {tag}
                <button type="button" onClick={() => setTags((prev) => prev.filter((t) => t !== tag))} className="text-gray-500 hover:text-red-400 leading-none">×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); } }}
              placeholder="Type a tag and press Enter"
              className="flex-1 bg-cohesity-black border border-cohesity-border rounded px-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
            />
            <button type="button" onClick={addTag} className="px-3 py-2 bg-cohesity-gray border border-cohesity-border rounded text-xs text-cohesity-green hover:border-cohesity-green">Add</button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Poll interval</label>
          <select
            value={pollingInterval}
            onChange={(e) => setPollingInterval(Number(e.target.value))}
            className="bg-cohesity-black border border-cohesity-border text-sm text-cohesity-text rounded px-3 py-2 focus:outline-none focus:border-cohesity-green"
          >
            {[15, 30, 60, 120].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={submitting || !name.trim()}
            className="flex items-center gap-1.5 px-4 py-2 bg-cohesity-green text-cohesity-black rounded text-sm font-semibold hover:bg-cohesity-green-dark transition-colors disabled:opacity-50"
          >
            <Save size={13} /> {submitting ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 bg-cohesity-black border border-cohesity-border rounded text-sm hover:border-cohesity-green hover:text-cohesity-green transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function TagInputWidget({ value, onChange }) {
  const [input, setInput] = useState('');
  const add = () => {
    const t = input.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setInput('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2 min-h-[24px]">
        {value.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 bg-cohesity-black border border-cohesity-border text-xs text-cohesity-green px-2 py-0.5 rounded">
            {tag}
            <button type="button" onClick={() => onChange(value.filter(t => t !== tag))} className="text-gray-500 hover:text-red-400">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          placeholder="Type tag + Enter"
          className="flex-1 bg-cohesity-black border border-cohesity-border rounded px-3 py-1.5 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green"
        />
        <button type="button" onClick={add} className="px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded text-xs text-cohesity-green hover:border-cohesity-green">Add</button>
      </div>
    </div>
  );
}

function BulkEditModal({ mode, clusters, selectedIds, onReplaceTags, onAppendTags, onCredentials, onClose }) {
  const [tags, setTags] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const applicableCount = mode === 'credentials'
    ? clusters.filter(c => selectedIds.has(c.id) && c.auth_type === 'apikey').length
    : selectedIds.size;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4">
      <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 w-full max-w-sm shadow-xl">
        <h3 className="text-cohesity-text font-semibold mb-4">
          {mode === 'replaceTags' && `Replace Tags — ${applicableCount} cluster(s)`}
          {mode === 'appendTags' && `Append Tags — ${applicableCount} cluster(s)`}
          {mode === 'credentials' && `Update API Key — ${applicableCount} cluster(s)`}
        </h3>
        {(mode === 'replaceTags' || mode === 'appendTags') && (
          <>
            <TagInputWidget value={tags} onChange={setTags} />
            <div className="flex gap-3 mt-4">
              <button onClick={() => mode === 'replaceTags' ? onReplaceTags(tags) : onAppendTags(tags)} className="px-4 py-2 bg-cohesity-green text-cohesity-black rounded text-sm font-semibold hover:bg-cohesity-green-dark">Save</button>
              <button onClick={onClose} className="px-4 py-2 bg-cohesity-black border border-cohesity-border rounded text-sm hover:border-cohesity-green">Cancel</button>
            </div>
          </>
        )}
        {mode === 'credentials' && (
          <>
            {applicableCount === 0 ? (
              <p className="text-sm text-gray-400">No selected clusters use API key auth.</p>
            ) : (
              <>
                <p className="text-xs text-gray-400 mb-3">Applies to {applicableCount} cluster(s) with API key auth. Clusters using username/password will be skipped.</p>
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="New API key" autoComplete="new-password" className="w-full bg-cohesity-black border border-cohesity-border rounded px-3 py-2 text-sm text-cohesity-text focus:outline-none focus:border-cohesity-green" />
              </>
            )}
            <div className="flex gap-3 mt-4">
              {applicableCount > 0 && <button onClick={() => onCredentials(apiKey)} disabled={!apiKey} className="px-4 py-2 bg-cohesity-green text-cohesity-black rounded text-sm font-semibold hover:bg-cohesity-green-dark disabled:opacity-50">Save</button>}
              <button onClick={onClose} className="px-4 py-2 bg-cohesity-black border border-cohesity-border rounded text-sm hover:border-cohesity-green">Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ClusterManagement() {
  const [clusters, setClusters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState(null); // null | 'add' | { edit: cluster }
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkModal, setBulkModal] = useState(null); // null | 'replaceTags' | 'appendTags' | 'credentials'
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const [clusterSearch, setClusterSearch] = useState('');
  const [clusterTypeFilter, setClusterTypeFilter] = useState('all');
  const [clusterTagFilter, setClusterTagFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importOverwrite, setImportOverwrite] = useState(false);

  const showToast = (msg, type = 'success') => {
    toast({ type, title: msg });
  };

  const loadClusters = () => {
    client
      .get('/clusters')
      .then(({ data }) => setClusters(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadClusters(); }, []);

  const handleDelete = async (id) => {
    try {
      await client.delete(`/clusters/${id}`);
      showToast('Cluster deleted');
      setClusters((prev) => prev.filter((c) => c.id !== id));
    } catch {
      showToast('Failed to delete cluster', 'error');
    } finally {
      setDeleteConfirm(null);
    }
  };

  const handleBulkReplaceTags = async (newTags) => {
    const tagStr = newTags.join(', ');
    await Promise.allSettled([...selectedIds].map(id => client.put(`/clusters/${id}`, { tags: tagStr })));
    showToast(`Tags updated on ${selectedIds.size} cluster(s)`);
    setSelectedIds(new Set());
    setBulkModal(null);
    loadClusters();
  };

  const handleBulkAppendTags = async (newTags) => {
    await Promise.allSettled([...selectedIds].map(id => {
      const cluster = clusters.find(c => c.id === id);
      const existing = (cluster?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...newTags])];
      return client.put(`/clusters/${id}`, { tags: merged.join(', ') });
    }));
    showToast(`Tags appended to ${selectedIds.size} cluster(s)`);
    setSelectedIds(new Set());
    setBulkModal(null);
    loadClusters();
  };

  const handleBulkCredentials = async (apiKey) => {
    const applicable = clusters.filter(c => selectedIds.has(c.id) && c.auth_type === 'apikey');
    await Promise.allSettled(applicable.map(c => client.put(`/clusters/${c.id}`, { credentials: { apiKey } })));
    showToast(`Credentials updated on ${applicable.length} cluster(s)`);
    setSelectedIds(new Set());
    setBulkModal(null);
    loadClusters();
  };

  const handleBulkDelete = async () => {
    await Promise.allSettled([...selectedIds].map(id => client.delete(`/clusters/${id}`)));
    showToast(`Deleted ${selectedIds.size} cluster(s)`);
    setSelectedIds(new Set());
    setBulkConfirmDelete(false);
    loadClusters();
  };

  const allClusterTags = [...new Set(clusters.flatMap(c => (c.tags || '').split(',').map(t => t.trim()).filter(Boolean)))].sort();

  const filteredClusters = clusters.filter(c => {
    if (clusterSearch && !c.name.toLowerCase().includes(clusterSearch.toLowerCase())) return false;
    if (clusterTypeFilter !== 'all' && c.connection_type !== clusterTypeFilter) return false;
    if (clusterTagFilter !== 'all' && !(c.tags || '').split(',').map(t => t.trim()).includes(clusterTagFilter)) return false;
    return true;
  });

  return (
    <>
    <div className="relative">
      <PageHeader
        icon={Server}
        title="Cluster Management"
        description="Connect, organize, and maintain Cohesity clusters across your estate"
      >
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface border border-cohesity-border text-brand rounded-lg text-xs font-semibold hover:border-brand/50 transition-colors cursor-pointer"
        >
          <Upload size={13} /> Import CSV
        </button>
      </PageHeader>

      <p className="text-xs text-ink-faint -mt-3 mb-4 flex items-center gap-1.5">
        <Settings size={12} />
        Clusters are added in{' '}
        <Link to="/settings" className="text-brand hover:underline">Settings → Helios (SaaS)</Link> or{' '}
        <Link to="/settings" className="text-brand hover:underline">Settings → Direct Clusters</Link>.
      </p>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <input
          type="text"
          value={clusterSearch}
          onChange={e => setClusterSearch(e.target.value)}
          placeholder="Search clusters..."
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-3 py-1.5 w-40 focus:outline-none focus:border-cohesity-green placeholder-gray-500"
        />
        <select
          value={clusterTypeFilter}
          onChange={e => setClusterTypeFilter(e.target.value)}
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-2 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All Types</option>
          <option value="helios">Helios</option>
          <option value="direct">Direct</option>
        </select>
        <select
          value={clusterTagFilter}
          onChange={e => setClusterTagFilter(e.target.value)}
          className="bg-cohesity-gray border border-cohesity-border text-xs text-cohesity-text rounded px-2 py-1.5 focus:outline-none focus:border-cohesity-green"
        >
          <option value="all">All Tags</option>
          {allClusterTags.map(tag => <option key={tag} value={tag}>{tag}</option>)}
        </select>
        {selectedIds.size === 0 && clusters.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer ml-1">
            <input
              type="checkbox"
              checked={selectedIds.size === filteredClusters.length && filteredClusters.length > 0}
              onChange={e => setSelectedIds(e.target.checked ? new Set(filteredClusters.map(c => c.id)) : new Set())}
              className="accent-cohesity-green"
            />
            Select all
          </label>
        )}
        <span className="text-xs text-gray-500 ml-auto">{filteredClusters.length} of {clusters.length}</span>
      </div>

      {mode?.edit && mode.edit.connection_type === 'direct' && (
        <div className="mb-6">
          <DirectClusterForm
            initial={mode.edit}
            onSaved={() => { setMode(null); showToast('Cluster updated'); loadClusters(); }}
            onCancel={() => setMode(null)}
          />
        </div>
      )}

      {mode?.edit && mode.edit.connection_type === 'helios' && (
        <HeliosClusterEditForm
          initial={mode.edit}
          onSaved={() => { setMode(null); showToast('Cluster updated'); loadClusters(); }}
          onCancel={() => setMode(null)}
        />
      )}

      {loading ? (
        <div className="panel p-4"><SkeletonTable rows={6} colWidths={['w-40', 'w-20', 'w-24', 'w-32', 'w-16']} /></div>
      ) : clusters.length === 0 ? (
        <div className="text-gray-500 text-sm">No clusters configured.</div>
      ) : filteredClusters.length === 0 ? (
        <div className="text-gray-500 text-sm">No clusters match the current filters.</div>
      ) : (
        <div className="border border-cohesity-border rounded-lg overflow-hidden divide-y divide-cohesity-border pb-20">
          {filteredClusters.map(cluster => {
            const isSelected = selectedIds.has(cluster.id);
            const isExpanded = expandedId === cluster.id;
            const clusterTags = (cluster.tags || '').split(',').map(t => t.trim()).filter(Boolean);

            return (
              <div key={cluster.id} className={`transition-colors ${isSelected ? 'bg-cohesity-green bg-opacity-5' : 'bg-cohesity-gray'}`}>
                {/* Row */}
                <div
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white hover:bg-opacity-[0.03] transition-colors`}
                  onClick={() => setExpandedId(isExpanded ? null : cluster.id)}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onClick={e => e.stopPropagation()}
                    onChange={() => setSelectedIds(prev => {
                      const next = new Set(prev);
                      next.has(cluster.id) ? next.delete(cluster.id) : next.add(cluster.id);
                      return next;
                    })}
                    className="accent-cohesity-green w-3.5 h-3.5 flex-shrink-0"
                  />

                  {/* Expand indicator */}
                  <span className={`text-gray-500 text-xs flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} style={{ display: 'inline-block' }}>▶</span>

                  {/* Name */}
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-cohesity-text">{cluster.name}</span>
                    {clusterTags.length > 0 && (
                      <span className="ml-2">
                        {clusterTags.map(tag => (
                          <span key={tag} className="text-[10px] bg-cohesity-black border border-cohesity-border text-cohesity-green px-1.5 py-0.5 rounded mr-1">{tag}</span>
                        ))}
                      </span>
                    )}
                  </div>

                  {/* Type badge */}
                  <span className={`text-[10px] px-2 py-0.5 rounded border flex-shrink-0 ${cluster.connection_type === 'helios' ? 'text-purple-300 bg-purple-900 border-purple-700' : 'text-cyan-300 bg-cyan-900 border-cyan-700'}`}>
                    {cluster.connection_type}
                  </span>

                  {/* VIP */}
                  <span className="text-xs text-gray-500 flex-shrink-0 w-40 truncate hidden md:block">{cluster.vip || '—'}</span>

                  {/* Poll interval */}
                  <span className="text-xs text-gray-500 flex-shrink-0 hidden lg:block">{cluster.polling_interval_minutes}m</span>

                  {/* Auth */}
                  <span className="text-xs text-gray-500 flex-shrink-0 hidden lg:block w-16">{cluster.auth_type}</span>

                  {/* SSL badge */}
                  {cluster.ssl_verify && (
                    <span className="text-[10px] text-cohesity-green border border-cohesity-green rounded px-1.5 py-0.5 flex-shrink-0 hidden xl:block">SSL</span>
                  )}

                  {/* Action buttons — stop propagation so row click doesn't toggle expand */}
                  <div className="flex gap-1.5 flex-shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => { setMode({ edit: cluster }); setExpandedId(null); }}
                      className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(cluster)}
                      className="text-xs px-2 py-1 border border-cohesity-border rounded hover:border-red-600 hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Expanded details panel */}
                {isExpanded && (
                  <div className="px-10 py-4 bg-cohesity-black border-t border-cohesity-border">
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 text-sm mb-4">
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Name</p>
                        <p className="text-cohesity-text">{cluster.name}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">VIP / Cluster ID</p>
                        <p className="text-cohesity-text font-mono text-xs">{cluster.vip || '—'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Connection Type</p>
                        <p className="text-cohesity-text">{cluster.connection_type}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Auth Type</p>
                        <p className="text-cohesity-text">{cluster.auth_type}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Poll Interval</p>
                        <p className="text-cohesity-text">{cluster.polling_interval_minutes} minutes</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">SSL Verify</p>
                        <p className={cluster.ssl_verify ? 'text-cohesity-green' : 'text-gray-500'}>{cluster.ssl_verify ? 'Enabled' : 'Disabled'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Added</p>
                        <p className="text-cohesity-text">{cluster.created_at ? new Date(cluster.created_at).toLocaleDateString() : '—'}</p>
                      </div>
                      {clusterTags.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-0.5">Tags</p>
                          <div className="flex flex-wrap gap-1">
                            {clusterTags.map(tag => (
                              <span key={tag} className="text-xs bg-cohesity-gray border border-cohesity-border text-cohesity-green px-1.5 py-0.5 rounded">{tag}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 pt-2 border-t border-cohesity-border">
                      <button
                        onClick={() => { setMode({ edit: cluster }); setExpandedId(null); }}
                        className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors"
                      >
                        ✎ Edit Cluster
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(cluster)}
                        className="text-xs px-3 py-1.5 bg-cohesity-gray border border-red-800 rounded hover:border-red-500 hover:text-red-400 text-red-500 transition-colors"
                      >
                        ✕ Delete
                      </button>
                      <button
                        onClick={() => setExpandedId(null)}
                        className="text-xs px-3 py-1.5 text-gray-500 hover:text-cohesity-text transition-colors"
                      >
                        Collapse
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#111111] border-t border-cohesity-border px-6 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-cohesity-text">{selectedIds.size} selected</span>
          {!bulkConfirmDelete ? (
            <>
              <button onClick={() => setBulkModal('replaceTags')} className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors">Replace Tags</button>
              <button onClick={() => setBulkModal('appendTags')} className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors">Append Tags</button>
              <button onClick={() => setBulkModal('credentials')} className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green hover:text-cohesity-green transition-colors">Update Credentials</button>
              <button onClick={() => setBulkConfirmDelete(true)} className="text-xs px-3 py-1.5 bg-cohesity-gray border border-red-800 rounded hover:border-red-500 hover:text-red-400 text-red-500 transition-colors">Delete Selected</button>
              <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-500 hover:text-cohesity-text ml-2">✕ Cancel</button>
            </>
          ) : (
            <>
              <span className="text-sm text-red-400">Delete {selectedIds.size} cluster(s)? This is irreversible.</span>
              <button onClick={handleBulkDelete} className="text-xs px-3 py-1.5 bg-red-700 text-white rounded hover:bg-red-800 transition-colors">Confirm Delete</button>
              <button onClick={() => setBulkConfirmDelete(false)} className="text-xs px-3 py-1.5 bg-cohesity-gray border border-cohesity-border rounded hover:border-cohesity-green transition-colors">Cancel</button>
            </>
          )}
        </div>
      )}

      {/* Bulk edit modal */}
      {bulkModal && (
        <BulkEditModal
          mode={bulkModal}
          clusters={clusters}
          selectedIds={selectedIds}
          onReplaceTags={handleBulkReplaceTags}
          onAppendTags={handleBulkAppendTags}
          onCredentials={handleBulkCredentials}
          onClose={() => setBulkModal(null)}
        />
      )}

      {/* Delete Confirm Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center p-4">
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-cohesity-text font-semibold mb-2">Delete Cluster</h3>
            <p className="text-sm text-gray-300 mb-4">
              Are you sure you want to delete <strong>{deleteConfirm.name}</strong>? This will also delete all associated metrics and alerts.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => handleDelete(deleteConfirm.id)}
                className="px-4 py-2 bg-red-700 text-white rounded text-sm font-semibold hover:bg-red-800 transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 bg-cohesity-black border border-cohesity-border rounded text-sm hover:border-cohesity-green transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

      {importOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="bg-cohesity-gray border border-cohesity-border rounded-lg p-6 w-full max-w-md">
            <h2 className="text-sm font-semibold text-cohesity-text mb-4">Import Historical Capacity CSV</h2>

            <p className="text-[11px] text-gray-400 mb-3">
              Expected columns: <code className="text-cohesity-green">Timestamp, Zone, Cluster, LocalUsedTB, PhysicalUsedTB, ClusterUsageTB, ClusterAvailableTB, TotalCapacityTB, PercentUsed, PercentFree, DedupeRatio, NodeCount</code>
            </p>

            <input type="file" accept=".csv,text/csv" onChange={e => { setImportFile(e.target.files[0]); setImportResult(null); }}
              className="text-xs text-gray-400 mb-3 w-full" />

            <label className="flex items-center gap-2 text-xs text-gray-400 mb-4 cursor-pointer select-none">
              <input type="checkbox" checked={importOverwrite} onChange={e => setImportOverwrite(e.target.checked)} className="accent-cohesity-green" />
              <span>Overwrite existing rows <span className="text-amber-400">(fixes previously imported data)</span></span>
            </label>

            {importResult && (
              <div className="text-xs mb-4 p-3 rounded border border-cohesity-border bg-cohesity-black">
                {importResult.error ? (
                  <p className="text-red-400">✗ Error: {importResult.error}</p>
                ) : (
                  <>  
                    <p className="text-cohesity-green">✓ Imported: {importResult.imported}</p>
                    {importResult.overwritten > 0 && <p className="text-amber-400">↻ Overwritten: {importResult.overwritten}</p>}
                    <p className="text-gray-400">Skipped (duplicates): {importResult.skipped}</p>
                    {importResult.unmatched?.length > 0 && (
                      <p className="text-amber-400 mt-1">Unmatched clusters: {importResult.unmatched.join(', ')}</p>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button onClick={() => { setImportOpen(false); setImportFile(null); setImportResult(null); setImportOverwrite(false); }}
                className="text-xs px-3 py-1.5 border border-cohesity-border text-gray-400 rounded hover:border-cohesity-green transition-colors">
                {importResult ? 'Close' : 'Cancel'}
              </button>
              {!importResult && (
                <button disabled={!importFile || importLoading}
                  onClick={async () => {
                    if (!importFile) return;
                    setImportLoading(true);
                    try {
                      const text = await importFile.text();
                      const { data } = await client.post(`/import/history${importOverwrite ? '?overwrite=true' : ''}`, text, {
                        headers: { 'Content-Type': 'text/csv' }
                      });
                      setImportResult(data);
                    } catch (err) {
                      setImportResult({ imported: 0, skipped: 0, unmatched: [], error: err.response?.data?.error || err.message });
                    } finally {
                      setImportLoading(false);
                    }
                  }}
                  className="text-xs px-3 py-1.5 bg-cohesity-green text-cohesity-black rounded hover:bg-cohesity-green-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
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
