import { useEffect, useState, useCallback, useMemo } from 'react';
import { Building2, Layers, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';
import { SiteDot } from './capacityShared';

const PALETTE = ['#0091DA', '#6CB33F', '#D4A24E', '#9B6CD4', '#4ED4B8', '#D46CB3'];

function useSites() {
  const [sites, setSites] = useState(null);
  const [clusters, setClusters] = useState([]);
  const load = useCallback(() => client.get('/vcenter/capacity/sites')
    .then(({ data: j }) => { setSites(j.sites || []); setClusters(j.clusters || []); })
    .catch(() => { setSites([]); setClusters([]); }), []);
  useEffect(() => { load(); }, [load]);
  return { sites, clusters, load };
}

export function SitesSection({ flash }) {
  const { sites, clusters, load } = useSites();
  const [form, setForm] = useState({ name: '', color: PALETTE[0] });
  const [saving, setSaving] = useState(false);

  const addSite = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await client.post('/vcenter/capacity/sites', { name: form.name.trim(), color: form.color });
      setForm({ name: '', color: PALETTE[((sites || []).length + 1) % PALETTE.length] });
      await load();
      flash?.('success', 'Site created');
    } catch (err) {
      flash?.('error', 'Failed to create site', err?.response?.data?.error);
    } finally { setSaving(false); }
  };

  const deleteSite = async (site) => {
    if (!window.confirm(`Delete site "${site.name}"? Its cluster assignments will be cleared.`)) return;
    try {
      await client.delete(`/vcenter/capacity/sites/${site.id}`);
      await load();
      flash?.('success', 'Site deleted');
    } catch (err) { flash?.('error', 'Failed to delete site', err?.response?.data?.error); }
  };

  return (
    <div className="panel p-4" id="sites" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-1 flex items-center gap-2"><Building2 size={15} className="text-brand" /> Sites</p>
      <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
        A site is a named group of clusters — a datacenter, a room, or (as on this demo) a single cluster. The Capacity pages roll up per site and judge failover fit against each site's N+1 usable.
      </p>
      {sites == null ? <LoadingPanel label="Loading sites…" height={100} /> : (
        <>
          <div className="flex flex-wrap items-end gap-2 mb-4">
            <div style={{ flex: '1 1 220px' }}>
              <label className="block text-xs font-semibold text-ink mb-1">New site</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') addSite(); }}
                placeholder="e.g. DC-East" className="w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none" spellCheck={false} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-ink mb-1">Colour</label>
              <div className="flex items-center gap-1" style={{ height: 36 }}>
                {PALETTE.map((c) => (
                  <button key={c} onClick={() => setForm((f) => ({ ...f, color: c }))} title={c} aria-label={`Colour ${c}`}
                    style={{ width: 22, height: 22, borderRadius: '50%', background: c, border: form.color === c ? '2px solid var(--ink)' : '2px solid transparent', cursor: 'pointer' }} />
                ))}
              </div>
            </div>
            <button onClick={addSite} disabled={saving || !form.name.trim()}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
              {saving ? 'Creating…' : 'Add site'}
            </button>
          </div>

          {sites.length === 0 ? (
            <p className="text-sm text-ink-muted py-4 text-center">No sites yet — add one above, then assign clusters under Cluster assignments.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Site</th>
                  <th className="py-2 pr-3 text-right">Clusters</th>
                  <th className="py-2 pr-3 text-right">Hosts</th>
                  <th className="py-2 pr-3 text-right">VMs</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {sites.map((s) => {
                    const mine = clusters.filter((c) => c.siteId === s.id);
                    return (
                      <tr key={s.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink"><span className="flex items-center gap-2"><SiteDot site={s} /> {s.name}</span></td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(mine.length)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(mine.reduce((n, c) => n + (c.hostCount || 0), 0))}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(mine.reduce((n, c) => n + (c.vmCount || 0), 0))}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center justify-end">
                            <button onClick={() => deleteSite(s)} title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`}
                              className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-status-crit hover:border-status-crit/50 transition-colors cursor-pointer">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function ClusterAssignmentsSection({ flash }) {
  const { sites, clusters, load } = useSites();
  const [busyKey, setBusyKey] = useState(null);

  const rows = useMemo(() => clusters.map((c) => ({ ...c, key: `${c.vcenterId}|${c.name}`, siteName: (sites || []).find((s) => s.id === c.siteId)?.name || '' })), [clusters, sites]);
  const ctl = useTableControls(rows, { searchKeys: ['name', 'vcenterName', 'siteName'], defaultSortKey: 'vcenterName', defaultSortDir: 'asc' });
  const unmapped = rows.filter((r) => r.siteId == null).length;

  const assign = async (c, siteId) => {
    setBusyKey(c.key);
    try {
      await client.put('/vcenter/capacity/sites/members', { vcenterId: c.vcenterId, memberType: 'cluster', memberName: c.name, siteId });
      await load();
    } catch (err) { flash?.('error', 'Failed to update assignment', err?.response?.data?.error); } finally { setBusyKey(null); }
  };

  return (
    <div className="panel p-4" id="clusters" style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <p className="text-sm font-semibold text-ink mr-auto flex items-center gap-2"><Layers size={15} className="text-brand" /> Cluster assignments</p>
        {sites != null && unmapped > 0 && (sites || []).length > 0 && <Badge tone="warn">{unmapped} unmapped</Badge>}
      </div>
      <p className="text-[11px] text-ink-muted mb-4 leading-relaxed">
        Every discovered cluster should belong to exactly one site. Unmapped clusters are left out of the Capacity pages and the failover fit.
      </p>
      {sites == null ? <LoadingPanel label="Loading clusters…" height={100} /> : sites.length === 0 ? (
        <p className="text-sm text-ink-muted py-4 text-center">Add a site first (Sites section), then assign clusters here.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted py-4 text-center">No clusters discovered yet — register a vCenter first.</p>
      ) : (
        <>
          <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by cluster, vCenter or site…" filters={[{ k: 'vcenterName', label: 'vCenters' }, { k: 'siteName', label: 'Sites' }]} />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Cluster" ctl={ctl} />
                <SortTh k="vcenterName" label="vCenter" ctl={ctl} />
                <SortTh k="hostCount" label="Hosts" ctl={ctl} align="right" />
                <SortTh k="vmCount" label="VMs" ctl={ctl} align="right" />
                <SortTh k="siteName" label="Site" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.rows.map((c) => (
                  <tr key={c.key} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{c.name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.vcenterName}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.hostCount)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.vmCount)}</td>
                    <td className="py-2 pr-3">
                      <select value={c.siteId ?? ''} disabled={busyKey === c.key} onChange={(e) => assign(c, e.target.value ? Number(e.target.value) : null)}
                        className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1 text-xs text-ink focus:border-brand/60 outline-none cursor-pointer" style={{ width: 'auto', borderColor: c.siteId == null ? 'rgba(251,191,36,0.5)' : undefined }}>
                        <option value="">Unmapped</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
