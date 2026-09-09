import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Network, Box, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import NetworkDetailModal from './NetworkDetailModal';
import {
  BRAND, fmtNum, fmtPct, fmtWhen, gatewaySourceLabel, gatewaySourceTone, freeStaticTone,
} from './helpers';

function buildTree(blocks) {
  const byParent = new Map();
  for (const b of blocks) {
    const key = b.parentBlockId || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(b);
  }
  return byParent;
}

function BlockNode({ block, byParent, depth, selectedId, onSelect }) {
  const children = byParent.get(block.blockId) || [];
  const active = selectedId === block.id;
  return (
    <div>
      <button onClick={() => onSelect(block)}
        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors cursor-pointer ${
          active ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}>
        <span className="truncate flex items-center gap-1.5">
          <Box size={11} className="shrink-0 text-brand" />
          {block.range}{block.name ? ` (${block.name})` : ''}
        </span>
        {block.lowSpaceCount > 0 && <Badge tone="warn" className="shrink-0">{block.lowSpaceCount}</Badge>}
      </button>
      {children.map((c) => (
        <BlockNode key={c.id} block={c} byParent={byParent} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function BluecatIpSpacesPage() {
  const { toast } = useToast();
  const [blocks, setBlocks] = useState(null);
  const [networks, setNetworks] = useState(null);
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [ipVersion, setIpVersion] = useState('');
  const [lowSpaceOnly, setLowSpaceOnly] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [detailId, setDetailId] = useState(() => {
    const v = Number(searchParams.get('network'));
    return Number.isInteger(v) && v > 0 ? v : null;
  });
  // Deep link from the DNS page: /bluecat/ipspaces?network=<row id>.
  useEffect(() => {
    const v = Number(searchParams.get('network'));
    if (Number.isInteger(v) && v > 0) setDetailId(v);
  }, [searchParams]);
  const closeDetail = () => {
    setDetailId(null);
    if (searchParams.has('network')) {
      const next = new URLSearchParams(searchParams);
      next.delete('network');
      setSearchParams(next, { replace: true });
    }
  };

  const loadBlocks = useCallback(() => client.get('/bluecat/blocks')
    .then(({ data }) => setBlocks(Array.isArray(data) ? data : []))
    .catch(() => setBlocks([])), []);

  const loadNetworks = useCallback(() => {
    const params = {};
    if (selectedBlock) params.blockId = selectedBlock.blockId;
    if (ipVersion) params.ipVersion = ipVersion;
    if (lowSpaceOnly) params.lowSpace = 1;
    return client.get('/bluecat/networks', { params })
      .then(({ data }) => { setNetworks(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
      .catch(() => { setNetworks([]); toast({ type: 'error', title: 'Failed to load networks' }); });
  }, [selectedBlock, ipVersion, lowSpaceOnly, toast]);

  useEffect(() => { loadBlocks(); }, [loadBlocks]);
  useEffect(() => { loadNetworks(); }, [loadNetworks]);

  const byParent = useMemo(() => buildTree(blocks || []), [blocks]);
  const roots = byParent.get('root') || [];

  const list = (networks || []).map((n) => ({
    ...n,
    gateway_source_label: gatewaySourceLabel(n.gatewaySource),
    ip_version_label: n.ipVersion === 6 ? 'IPv6' : 'IPv4',
  }));

  const ctl = useTableControls(list, {
    searchKeys: ['range', 'name', 'gateway', 'locationName', 'sourceName'],
    defaultSortKey: 'range', defaultSortDir: 'asc',
    paginate: true,
  });

  const refresh = () => { loadBlocks(); loadNetworks(); };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Network} title="IP Spaces" description="BlueCat blocks and networks — utilization, gateways and DHCP pools">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={refresh} />
      </PageHeader>

      <div className="flex flex-col md:flex-row gap-4 items-start">
        <div className="w-full md:w-64 shrink-0 panel p-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint px-2 py-1">Blocks</p>
          <button onClick={() => setSelectedBlock(null)}
            className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left text-xs cursor-pointer ${
              !selectedBlock ? 'bg-surface-overlay text-ink' : 'text-ink-muted hover:text-ink'
            }`}>
            All blocks
          </button>
          {blocks == null ? (
            <LoadingPanel label="Loading blocks…" height={80} />
          ) : roots.length === 0 ? (
            <p className="text-xs text-ink-muted px-2 py-3">No blocks found.</p>
          ) : (
            roots.map((b) => (
              <BlockNode key={b.id} block={b} byParent={byParent} depth={0} selectedId={selectedBlock?.id} onSelect={setSelectedBlock} />
            ))
          )}
        </div>

        <div className="flex-1 min-w-0 panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <TableSearch ctl={ctl} placeholder="Search range, name, gateway, location…" className="flex-1 min-w-[200px]" />
            <select value={ipVersion} onChange={(e) => setIpVersion(e.target.value)}
              className="bg-surface-overlay border border-cohesity-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none cursor-pointer">
              <option value="">All IP versions</option>
              <option value="4">IPv4</option>
              <option value="6">IPv6</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none">
              <input type="checkbox" checked={lowSpaceOnly} onChange={(e) => setLowSpaceOnly(e.target.checked)} className="accent-brand cursor-pointer" />
              <AlertTriangle size={12} /> Low space only
            </label>
          </div>

          {networks == null ? (
            <LoadingPanel label="Loading networks…" height={200} />
          ) : list.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No networks found.</div>
          ) : ctl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No networks match your search.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="range" label="Range" ctl={ctl} />
                  <SortTh k="name" label="Name" ctl={ctl} />
                  <SortTh k="gateway" label="Gateway" ctl={ctl} />
                  <SortTh k="freePct" label="Used / Free / Capacity" ctl={ctl} />
                  <SortTh k="dhcpPool" label="DHCP Pool" ctl={ctl} align="right" />
                  <SortTh k="enumeratedAt" label="Enumerated" ctl={ctl} />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((n) => (
                    <tr key={n.id} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setDetailId(n.id)}>
                      <td className="py-2 pr-3 text-ink tnum">{n.range}</td>
                      <td className="py-2 pr-3 text-ink-muted">{n.name || '—'}</td>
                      <td className="py-2 pr-3">
                        <span className="text-ink-muted tnum mr-1.5">{n.gateway || '—'}</span>
                        <Badge tone={gatewaySourceTone(n.gatewaySource)}>{n.gateway_source_label}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        {n.capacity == null ? (
                          <span className="text-xs text-ink-faint">not enumerated</span>
                        ) : (
                          <div className="min-w-[140px]">
                            <div className="h-1.5 rounded-full bg-surface-overlay overflow-hidden">
                              <div className="h-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, ((n.usedStatic || 0) / n.capacity) * 100))}%` }} />
                            </div>
                            <p className="text-[10px] text-ink-faint mt-0.5 tnum">
                              {fmtNum(n.usedStatic)} / <Badge tone={freeStaticTone(n.freeStatic)}>{fmtNum(n.freeStatic)}</Badge> / {fmtNum(n.capacity)} ({fmtPct(n.freePct)})
                            </p>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(n.dhcpPool)}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px]">{fmtWhen(n.enumeratedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={ctl} />
        </div>
      </div>

      {detailId != null && (
        <NetworkDetailModal networkId={detailId} onClose={closeDetail} onChanged={loadNetworks} />
      )}
    </div>
  );
}
