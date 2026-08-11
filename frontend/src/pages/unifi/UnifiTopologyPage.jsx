import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Share2, ZoomIn, ZoomOut, Maximize2, RotateCcw, X, Search } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtWhen, typeLabel } from './helpers';

const COL_W = 200;
const ROW_H = 46;
const DEVICE_W = 148;
const DEVICE_H = 34;
const CLIENT_R = 7;

const TYPE_ICON = { udm: '⌂', usw: '▦', uap: '◎' };
const TYPE_ORDER = ['udm', 'usw', 'uap', 'other'];

// Live controllers mark network gear with type 'DEVICE' (unifiDevice is undefined there),
// while Protect cameras arrive as CLIENT vertices with unifiDevice:true — so type/meta,
// not the unifiDevice flag, decides what counts as an infrastructure node.
function isDeviceVertex(v, deviceMeta) {
  return String(v.type || '').toUpperCase() === 'DEVICE' || !!deviceMeta[v.mac];
}

function buildTree(vertices, edges, deviceMeta) {
  const byMac = new Map(vertices.map((v) => [v.mac, v]));
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const e of edges) {
    if (!byMac.has(e.uplinkMac) || !byMac.has(e.downlinkMac)) continue;
    if (!childrenOf.has(e.uplinkMac)) childrenOf.set(e.uplinkMac, []);
    childrenOf.get(e.uplinkMac).push(e);
    hasParent.add(e.downlinkMac);
  }
  const deviceVerts = vertices.filter((v) => isDeviceVertex(v, deviceMeta));
  let rootMac = deviceVerts.find((v) => deviceMeta[v.mac]?.type === 'udm')?.mac;
  if (!rootMac) rootMac = deviceVerts.find((v) => !hasParent.has(v.mac))?.mac;
  if (!rootMac) rootMac = deviceVerts[0]?.mac;
  if (!rootMac) return null;

  const visited = new Set();
  function makeNode(mac) {
    if (visited.has(mac)) return null;
    visited.add(mac);
    const v = byMac.get(mac);
    const meta = deviceMeta[mac];
    const childEdges = childrenOf.get(mac) || [];
    const children = childEdges
      .map((e) => ({ edge: e, node: makeNode(e.downlinkMac) }))
      .filter((c) => c.node);
    return {
      mac, vertex: v, meta, isClient: !isDeviceVertex(v, deviceMeta),
      isCamera: !isDeviceVertex(v, deviceMeta) && v.unifiDevice === true,
      children,
    };
  }
  return makeNode(rootMac);
}

function layoutTree(root) {
  const yCursor = { current: 0 };
  function place(node, depth) {
    node.x = depth * COL_W;
    if (node.children.length === 0) {
      node.y = yCursor.current;
      yCursor.current += ROW_H;
    } else {
      node.children.forEach((c) => place(c.node, depth + 1));
      const ys = node.children.map((c) => c.node.y);
      node.y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
  }
  place(root, 0);
  return yCursor.current || ROW_H;
}

function flatten(node, out = []) {
  out.push(node);
  node.children.forEach((c) => flatten(c.node, out));
  return out;
}

function edgeColor(type) {
  return type === 'WIRELESS' ? '#8FA3B0' : BRAND;
}

function rateTier(rateMbps) {
  const r = Number(rateMbps) || 0;
  if (r >= 1000) return 3;
  if (r >= 100) return 2;
  return 1;
}

export default function UnifiTopologyPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [showClients, setShowClients] = useState(true);
  const [clientFilter, setClientFilter] = useState('all'); // all | wired | wireless
  const [typeFilter, setTypeFilter] = useState(() => new Set(TYPE_ORDER));
  const [search, setSearch] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('q') || ''; } catch { return ''; }
  });
  const [selected, setSelected] = useState(null);
  const [view, setView] = useState({ x: 40, y: 40, scale: 1 });
  const dragRef = useRef(null);
  const svgWrapRef = useRef(null);

  const load = useCallback(() => client.get('/unifi/topology')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ vertices: [], edges: [], deviceMeta: {}, clientMeta: {} }); toast({ type: 'error', title: 'Failed to load topology' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const tree = useMemo(() => {
    if (!data || !data.vertices?.length) return null;
    return buildTree(data.vertices, data.edges || [], data.deviceMeta || {});
  }, [data]);

  const totalH = useMemo(() => (tree ? layoutTree(tree) : 0), [tree]);

  // Tag each node with the type of edge that connects it to its parent (for client wired/wireless filtering).
  useMemo(() => {
    if (!tree) return;
    (function tag(node) {
      node.children.forEach((c) => { c.node.__edgeType = c.edge.type; tag(c.node); });
    })(tree);
  }, [tree]);

  const visibleNodes = useMemo(() => {
    if (!tree) return [];
    const all = flatten(tree);
    return all.filter((n) => {
      if (n.isClient) {
        if (!showClients) return false;
        if (clientFilter !== 'all') {
          const parentEdge = n.__edgeType;
          if (clientFilter === 'wired' && parentEdge === 'WIRELESS') return false;
          if (clientFilter === 'wireless' && parentEdge === 'WIRED') return false;
        }
        return true;
      }
      const t = n.meta?.type || 'other';
      return typeFilter.has(t) || typeFilter.has('other');
    });
  }, [tree, showClients, clientFilter, typeFilter]);

  const visibleMacs = useMemo(() => new Set(visibleNodes.map((n) => n.mac)), [visibleNodes]);

  const term = search.trim().toLowerCase();
  const nodeLabel = (n) => n.vertex?.name || n.meta?.name || n.mac;
  const isMatch = (n) => !term || nodeLabel(n).toLowerCase().includes(term) || n.mac.toLowerCase().includes(term);

  const edgesToDraw = useMemo(() => {
    if (!tree) return [];
    const list = [];
    (function walk(node) {
      node.children.forEach((c) => {
        if (visibleMacs.has(node.mac) && visibleMacs.has(c.node.mac)) list.push({ from: node, to: c.node, edge: c.edge });
        walk(c.node);
      });
    })(tree);
    return list;
  }, [tree, visibleMacs]);

  // ── Pan / zoom ──────────────────────────────────────────────────────────
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    setView((v) => {
      const scale = Math.min(4, Math.max(0.25, v.scale * (1 + delta)));
      return { ...v, scale };
    });
  };
  const onPointerDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setView((v) => ({ ...v, x: dragRef.current.origX + dx, y: dragRef.current.origY + dy }));
  };
  const onPointerUp = () => { dragRef.current = null; };

  const zoomBy = (f) => setView((v) => ({ ...v, scale: Math.min(4, Math.max(0.25, v.scale * f)) }));
  const resetView = () => setView({ x: 40, y: 40, scale: 1 });
  const fitView = () => {
    const wrap = svgWrapRef.current;
    if (!wrap || !tree) return resetView();
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const contentW = 6 * COL_W;
    const contentH = totalH || ROW_H;
    const scale = Math.min(4, Math.max(0.25, Math.min((w - 80) / contentW, (h - 80) / contentH, 1)));
    setView({ x: 40, y: 40, scale });
  };

  const toggleType = (t) => setTypeFilter((s) => {
    const next = new Set(s);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Share2} title="Topology" description="Network tree — gateway, switches, access points and connected clients">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading topology…" height={300} />
      ) : !tree ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">No topology data collected yet.</div>
      ) : (
        <div className="flex gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search nodes…"
                  className="bg-surface-overlay border border-cohesity-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-ink focus:border-brand/60 outline-none w-48" />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none px-2">
                <input type="checkbox" checked={showClients} onChange={(e) => setShowClients(e.target.checked)} className="accent-brand cursor-pointer" />
                Show clients
              </label>
              {showClients && (
                <div className="flex items-center gap-1">
                  {['all', 'wired', 'wireless'].map((k) => (
                    <button key={k} onClick={() => setClientFilter(k)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold cursor-pointer transition-colors capitalize ${clientFilter === k ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
                      {k}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1">
                {TYPE_ORDER.filter((t) => t !== 'other').map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer select-none px-1.5">
                    <input type="checkbox" checked={typeFilter.has(t)} onChange={() => toggleType(t)} className="accent-brand cursor-pointer" />
                    {typeLabel(t)}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-1 ml-auto">
                <button onClick={() => zoomBy(1.25)} title="Zoom in" className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink cursor-pointer"><ZoomIn size={13} /></button>
                <button onClick={() => zoomBy(0.8)} title="Zoom out" className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink cursor-pointer"><ZoomOut size={13} /></button>
                <button onClick={fitView} title="Fit to view" className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink cursor-pointer"><Maximize2 size={13} /></button>
                <button onClick={resetView} title="Reset" className="flex items-center justify-center h-7 w-7 rounded-md border border-cohesity-border text-ink-muted hover:text-ink cursor-pointer"><RotateCcw size={13} /></button>
              </div>
            </div>

            <div ref={svgWrapRef} className="panel overflow-hidden" style={{ height: '70vh', borderTop: `3px solid ${BRAND}` }}>
              <svg
                width="100%" height="100%"
                onWheel={onWheel}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={onPointerUp}
                style={{ cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
              >
                <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
                  {edgesToDraw.map(({ from, to, edge }, i) => {
                    const dimmed = term && !(isMatch(from) || isMatch(to));
                    return (
                      <g key={i}>
                        <line
                          x1={from.x + DEVICE_W} y1={from.y} x2={to.x} y2={to.y}
                          stroke={edgeColor(edge.type)} strokeWidth={rateTier(edge.rateMbps)}
                          strokeDasharray={edge.type === 'WIRELESS' ? '4 3' : undefined}
                          opacity={dimmed ? 0.15 : 0.7}
                        />
                        {edge.type === 'WIRELESS' && edge.rateMbps != null && !dimmed && (
                          <text x={(from.x + DEVICE_W + to.x) / 2} y={(from.y + to.y) / 2 - 4} fontSize="8" fill="#8FA3B0" textAnchor="middle">
                            {edge.rateMbps} Mbps
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {visibleNodes.map((n) => {
                    const matched = isMatch(n);
                    const dimmed = term && !matched;
                    const label = nodeLabel(n);
                    if (n.isClient) {
                      return (
                        <g key={n.mac} transform={`translate(${n.x},${n.y})`} opacity={dimmed ? 0.25 : 1}
                          onClick={() => setSelected(n)} style={{ cursor: 'pointer' }}>
                          <circle r={CLIENT_R} fill={selected?.mac === n.mac ? BRAND : n.isCamera ? '#7bb3ff' : '#8FA3B0'} stroke="#1A1A1A" strokeWidth="1" />
                          {n.isCamera && <circle r={2.5} fill="#1A1A1A" />}
                          <text x={CLIENT_R + 5} y={4} fontSize="9" fill="#E5E5E5">{label}</text>
                        </g>
                      );
                    }
                    return (
                      <g key={n.mac} transform={`translate(${n.x},${n.y - DEVICE_H / 2})`} opacity={dimmed ? 0.25 : 1}
                        onClick={() => setSelected(n)} style={{ cursor: 'pointer' }}>
                        <rect width={DEVICE_W} height={DEVICE_H} rx={6} fill="#1e2126"
                          stroke={selected?.mac === n.mac ? BRAND : '#3a4048'} strokeWidth={selected?.mac === n.mac ? 2 : 1} />
                        <text x={10} y={14} fontSize="10" fill={BRAND} fontWeight="700">{TYPE_ICON[n.meta?.type] || '□'}</text>
                        <text x={24} y={14} fontSize="10" fill="#E5E5E5" fontWeight="600">{label.length > 18 ? `${label.slice(0, 17)}…` : label}</text>
                        <text x={24} y={26} fontSize="8" fill="#8FA3B0">{n.meta?.model || typeLabel(n.meta?.type)}</text>
                        {n.meta?.state != null && n.meta.state !== 1 && (
                          <circle cx={DEVICE_W - 10} cy={10} r={3.5} fill="#C75D5D" />
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
            </div>
            {data.hasUnknownSwitch ? (
              <p className="text-[11px] text-status-warn mt-2">Some switches in the path are unmanaged/unknown — the tree may be incomplete.</p>
            ) : null}
            <p className="text-[11px] text-ink-faint mt-1">Captured {fmtWhen(data.capturedAt)}</p>
          </div>

          {selected && (
            <div className="w-72 shrink-0 panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="flex items-start justify-between mb-3">
                <p className="text-sm font-semibold text-ink truncate pr-2">{nodeLabel(selected)}</p>
                <button onClick={() => setSelected(null)} className="text-ink-muted hover:text-ink cursor-pointer"><X size={15} /></button>
              </div>
              {selected.isClient ? (
                <div className="flex flex-col gap-2 text-xs">
                  <Row label="IP" value={selected.meta?.ip} />
                  <Row label="MAC" value={selected.mac} />
                  <Row label="Wired" value={selected.meta?.is_wired ? 'Yes' : 'No'} />
                  {selected.meta?.signal != null && <Row label="Signal" value={`${selected.meta.signal} dBm`} />}
                  <Link to={`/unifi/clients?q=${encodeURIComponent(nodeLabel(selected))}`} className="text-brand text-xs underline mt-2">View in Clients</Link>
                </div>
              ) : (
                <div className="flex flex-col gap-2 text-xs">
                  <Row label="Type" value={typeLabel(selected.meta?.type)} />
                  <Row label="Model" value={selected.meta?.model} />
                  <Row label="IP" value={selected.meta?.ip} />
                  <Row label="State" value={selected.meta?.state === 1 ? 'Online' : 'Offline'} />
                  <Row label="Ports" value={`${selected.children.filter((c) => !c.node.isClient).length} device link(s), ${selected.children.filter((c) => c.node.isClient).length} client(s)`} />
                  <Link to={`/unifi/devices?q=${encodeURIComponent(nodeLabel(selected))}`} className="text-brand text-xs underline mt-2">View in Devices</Link>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="text-ink">{value ?? '—'}</p>
    </div>
  );
}
