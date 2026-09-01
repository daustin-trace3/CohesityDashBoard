import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Grid3x3, X } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, statusTone, parseJsonArr } from './helpers';

const COL_GAP_EVERY = 8;
const SQ = 18;
const SQ_GAP = 5;
const GROUP_GAP = 10;
const ROW_GAP = 8;
const LABEL_H = 12;

const COLOR = {
  fenced: '#C75D5D',
  online: '#3FB950',
  noModule: '#2A2A2A',
  offline: '#6B6B6B',
  marginal: '#D4A24E',
  dim: '#3A3A3A',
};

function portColor(p) {
  if (p.fenced || p.blocked) return COLOR.fenced;
  const health = String(p.health || '').toLowerCase();
  if (health.includes('marginal') || health.includes('degraded')) return COLOR.marginal;
  const status = String(p.status || '').toLowerCase();
  if (status.includes('no_module') || status.includes('mod_inv')) return COLOR.noModule;
  const state = String(p.state || '').toLowerCase();
  if (state === 'online') return COLOR.online;
  if (state === 'offline') return COLOR.offline;
  if (!p.state && !p.status) return COLOR.dim;
  return COLOR.dim;
}

function isNoModule(p) {
  const status = String(p.status || '').toLowerCase();
  return status.includes('no_module') || status.includes('mod_inv');
}

function isEPort(p) {
  const t = String(p.type || '').toUpperCase();
  return t === 'E_PORT' || t === 'EX_PORT' || t.includes('E_PORT') || t.includes('EX_PORT');
}

function groupBySlot(ports, maxPort) {
  const slots = new Map();
  for (const p of ports) {
    const slot = p.slotNumber || 0;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push(p);
  }
  if (slots.size === 0) slots.set(0, []);
  // fill placeholders up to maxPort per slot when a single slot (fixed-port switch)
  if (slots.size === 1 && maxPort) {
    const [slot, list] = [...slots.entries()][0];
    const byNum = new Map(list.map((p) => [p.portNumber, p]));
    const filled = [];
    for (let n = 0; n < maxPort; n++) {
      filled.push(byNum.get(n) || { portNumber: n, placeholder: true });
    }
    slots.set(slot, filled);
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]);
}

function PortSquare({ port, x, y, onHover, onMove, onLeave, onClick, showLabel, selected }) {
  if (port.placeholder) {
    return (
      <g>
        <rect x={x} y={y} width={SQ} height={SQ} rx={2} fill="none" stroke="#333" strokeDasharray="2,2" />
        {showLabel && (
          <text x={x + SQ / 2} y={y - 3} textAnchor="middle" fontSize="8" fill="#555">{port.portNumber}</text>
        )}
      </g>
    );
  }
  const color = portColor(port);
  const noModule = isNoModule(port);
  const eport = isEPort(port);
  const hatch = port.persistentDisable === 1;
  const hatchId = `hatch-${port.id || port.portId || `${port.slotNumber}-${port.portNumber}`}`;
  return (
    <g
      onMouseEnter={(e) => onHover(port, e)}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={() => onClick(port)}
      style={{ cursor: 'pointer' }}
    >
      {hatch && (
        <defs>
          <pattern id={hatchId} width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill={color} />
            <line x1="0" y1="0" x2="0" y2="4" stroke="#000" strokeOpacity="0.35" strokeWidth="1.5" />
          </pattern>
        </defs>
      )}
      <rect
        x={x} y={y} width={SQ} height={SQ} rx={2}
        fill={hatch ? `url(#${hatchId})` : color}
        stroke={selected ? '#fff' : noModule ? '#555' : 'rgba(0,0,0,0.35)'}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={noModule ? '2,2' : undefined}
      />
      {eport && <rect x={x} y={y} width={SQ} height={3} fill="#8AB4F8" opacity={0.85} />}
      {port.trunked && (
        <polygon points={`${x + SQ},${y} ${x + SQ},${y + 6} ${x + SQ - 6},${y}`} fill="#fff" opacity={0.9} />
      )}
      {showLabel && (
        <text x={x + SQ / 2} y={y - 3} textAnchor="middle" fontSize="8" fill="#8A8A8A">{port.portNumber}</text>
      )}
    </g>
  );
}

function SlotFaceplate({ slot, ports, onHover, onMove, onLeave, onClick, selectedId }) {
  const evenPorts = ports.filter((p) => (p.portNumber % 2) === 0).sort((a, b) => a.portNumber - b.portNumber);
  const oddPorts = ports.filter((p) => (p.portNumber % 2) === 1).sort((a, b) => a.portNumber - b.portNumber);
  const cols = Math.max(evenPorts.length, oddPorts.length);
  const manyPorts = ports.length > 64;
  const stepBase = SQ + SQ_GAP;

  const colX = (i) => {
    const groups = Math.floor(i / COL_GAP_EVERY);
    return i * stepBase + groups * GROUP_GAP;
  };

  const width = cols > 0 ? colX(cols - 1) + SQ + 4 : 40;
  const height = LABEL_H + SQ + ROW_GAP + SQ + 4;

  const renderRow = (list, y) => list.map((p, i) => {
    return (
      <PortSquare
        key={p.id || p.portId || `${slot}-${p.portNumber}`}
        port={p}
        x={colX(i)}
        y={y}
        showLabel={!manyPorts || (p.portNumber % 8 === 0)}
        onHover={onHover} onMove={onMove} onLeave={onLeave} onClick={onClick}
        selected={selectedId != null && p.id === selectedId}
      />
    );
  });

  return (
    <div className="mb-4">
      {slot != null && slot > 0 && <p className="text-[11px] font-semibold text-ink-faint mb-1">Slot {slot}</p>}
      <div className="overflow-x-auto">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }}>
          <g transform={`translate(0, ${LABEL_H})`}>
            {renderRow(evenPorts, 0)}
            {renderRow(oddPorts, SQ + ROW_GAP)}
          </g>
        </svg>
      </div>
    </div>
  );
}

const LEGEND = [
  { color: COLOR.online, label: 'Online' },
  { color: COLOR.offline, label: 'Offline' },
  { color: COLOR.noModule, label: 'No module', dashed: true },
  { color: COLOR.fenced, label: 'Fenced / Blocked' },
  { color: COLOR.marginal, label: 'Marginal / Degraded' },
];

function Legend({ ports }) {
  const counts = useMemo(() => {
    const c = { online: 0, offline: 0, noModule: 0, fenced: 0 };
    for (const p of ports) {
      if (p.fenced || p.blocked) c.fenced++;
      else if (isNoModule(p)) c.noModule++;
      else if (String(p.state || '').toLowerCase() === 'online') c.online++;
      else if (String(p.state || '').toLowerCase() === 'offline') c.offline++;
    }
    return c;
  }, [ports]);

  return (
    <div className="flex items-center gap-4 flex-wrap text-[11px] text-ink-muted border-t border-cohesity-border pt-3 mt-1">
      {LEGEND.map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: l.color, border: l.dashed ? '1px dashed #666' : 'none' }} />
          {l.label}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-3 tnum">
        <span>Online <b className="text-ink">{counts.online}</b></span>
        <span>Offline <b className="text-ink">{counts.offline}</b></span>
        <span>No module <b className="text-ink">{counts.noModule}</b></span>
        <span>Fenced <b className="text-ink">{counts.fenced}</b></span>
      </span>
    </div>
  );
}

function RoleChip({ role }) {
  if (!role) return null;
  const isInit = String(role).toLowerCase().includes('init');
  const isTarget = String(role).toLowerCase().includes('target');
  const cls = isInit ? 'bg-status-info/10 text-status-info border-status-info/25'
    : isTarget ? 'bg-brand/10 text-brand border-brand/25'
    : 'bg-surface-overlay text-ink-muted border-cohesity-border';
  return <span className={`chip ${cls}`}>{role}</span>;
}

function PortDetails({ port }) {
  if (!port) return null;
  const device = port.device;
  const zones = device ? parseJsonArr(device.activeZones) : [];
  const speedLabel = port.speed ? `${port.speed}${Number(port.speedType) === 2 ? 'G' : ''}` : '—';
  const hasStats = !!port.statsTs;

  return (
    <div className="space-y-2.5">
      <div>
        <p className="text-sm font-semibold text-ink">{port.name || port.portId || `Port ${port.portNumber}`}</p>
        <p className="text-[11px] text-ink-faint">{port.type || 'Unknown type'}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge tone={statusTone(port.state)}>{port.state || 'Unknown'}</Badge>
        {port.status && <Badge tone={statusTone(port.status)}>{port.status}</Badge>}
        {(port.fenced || port.blocked) && <Badge tone="crit">{port.fenced ? 'Fenced' : 'Blocked'}</Badge>}
        {port.persistentDisable === 1 && <Badge tone="warn">Persistent disable</Badge>}
      </div>
      <p className="text-xs text-ink-muted">Speed: <span className="text-ink tnum">{speedLabel}</span></p>

      {device ? (
        <div className="pt-2 border-t border-cohesity-border space-y-1.5">
          <p className="text-xs font-semibold text-ink">Connected Device</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <RoleChip role={device.portRole} />
            {device.vendor && <span className="text-[11px] text-ink-faint">{device.vendor}</span>}
          </div>
          <p className="text-xs text-ink-muted">{device.symbolicName || device.deviceSymbolicName || '—'}</p>
          {(device.enclosureHostName || device.enclosureName) && (
            <p className="text-xs text-ink-faint">Enclosure: <span className="text-ink">{device.enclosureHostName || device.enclosureName}</span></p>
          )}
          {zones.length > 0 && (
            <p className="text-xs text-ink-faint">
              Zones: {zones.slice(0, 3).join(', ')}{zones.length > 3 ? ` +${zones.length - 3}` : ''}
            </p>
          )}
          {(device.enclosureName || device.enclosureHostName) && (
            <Link
              to={`/brocade/devices?search=${encodeURIComponent(device.enclosureHostName || device.enclosureName)}`}
              className="text-xs text-brand hover:underline inline-block pt-1"
            >
              View in Devices →
            </Link>
          )}
        </div>
      ) : (port.remoteDevice || port.remotePortWwn) ? (
        <div className="pt-2 border-t border-cohesity-border space-y-1">
          <p className="text-xs font-semibold text-ink">Remote (ISL)</p>
          <p className="text-xs text-ink-muted">{port.remoteDevice || port.remotePortWwn}</p>
        </div>
      ) : null}

      {hasStats && (
        <div className="pt-2 border-t border-cohesity-border">
          <p className="text-xs font-semibold text-ink mb-1">IO Rates</p>
          <p className="text-xs text-ink-faint tnum">
            In {Math.round(port.inFramesPerSec || 0).toLocaleString()} fr/s · {Number(port.inMbPerSec || 0).toFixed(1)} MB/s
          </p>
          <p className="text-xs text-ink-faint tnum">
            Out {Math.round(port.outFramesPerSec || 0).toLocaleString()} fr/s · {Number(port.outMbPerSec || 0).toFixed(1)} MB/s
          </p>
        </div>
      )}

      <p className="text-[10px] text-ink-faint pt-2 border-t border-cohesity-border">Compare IO in Ports page</p>
    </div>
  );
}

function Tooltip({ port, pos }) {
  if (!port || !pos) return null;
  const device = port.device;
  const zones = device ? parseJsonArr(device.activeZones) : [];
  const speedLabel = port.speed ? `${port.speed}${Number(port.speedType) === 2 ? 'G' : ''}` : '—';
  return (
    <div
      className="fixed z-50 pointer-events-none panel px-3 py-2 text-xs shadow-lg max-w-[280px]"
      style={{ left: pos.x + 14, top: pos.y + 14, borderTop: `2px solid ${BRAND}` }}
    >
      <p className="font-semibold text-ink">{port.name || port.portId || `Port ${port.portNumber}`}</p>
      <p className="text-ink-faint">{port.type || 'Unknown'} · {port.state || 'Unknown'}{port.status ? ` / ${port.status}` : ''}</p>
      <p className="text-ink-faint">Speed: {speedLabel}</p>
      {device ? (
        <div className="mt-1 pt-1 border-t border-cohesity-border">
          <p className="text-ink">{device.symbolicName || device.deviceSymbolicName || '—'}</p>
          {device.vendor && <p className="text-ink-faint">{device.vendor}{device.portRole ? ` · ${device.portRole}` : ''}</p>}
          {(device.enclosureHostName || device.enclosureName) && (
            <p className="text-ink-faint">{device.enclosureHostName || device.enclosureName}</p>
          )}
          {zones.length > 0 && (
            <p className="text-ink-faint">Zones: {zones.slice(0, 3).join(', ')}{zones.length > 3 ? ` +${zones.length - 3}` : ''}</p>
          )}
        </div>
      ) : (port.remoteDevice || port.remotePortWwn) ? (
        <div className="mt-1 pt-1 border-t border-cohesity-border">
          <p className="text-ink-faint">Remote: {port.remoteDevice || port.remotePortWwn}</p>
        </div>
      ) : null}
      {port.statsTs && (
        <p className="mt-1 pt-1 border-t border-cohesity-border text-ink-faint tnum">
          In {Math.round(port.inFramesPerSec || 0).toLocaleString()} fr/s / {Number(port.inMbPerSec || 0).toFixed(1)} MB/s · Out {Math.round(port.outFramesPerSec || 0).toLocaleString()} fr/s / {Number(port.outMbPerSec || 0).toFixed(1)} MB/s
        </p>
      )}
    </div>
  );
}

export default function BrocadePortMapPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [switches, setSwitches] = useState(null);
  const [switchId, setSwitchId] = useState(searchParams.get('switch') || '');
  const [detail, setDetail] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [hover, setHover] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);
  const [selectedPort, setSelectedPort] = useState(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    client.get('/brocade/switches')
      .then(({ data }) => {
        const list = data.switches || [];
        setSwitches(list);
        const qsSwitch = searchParams.get('switch');
        if (!switchId && qsSwitch) setSwitchId(qsSwitch);
        else if (!switchId && list.length > 0) setSwitchId(String(list[0].id));
      })
      .catch(() => { setSwitches([]); toast({ type: 'error', title: 'Failed to load switches' }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPortmap = useCallback((id) => {
    if (!id) return;
    loadingRef.current = true;
    client.get(`/brocade/switches/${id}/portmap`)
      .then(({ data }) => { setDetail(data); setLastRefreshed(new Date()); })
      .catch(() => { setDetail(false); toast({ type: 'error', title: 'Failed to load port map' }); })
      .finally(() => { loadingRef.current = false; });
  }, [toast]);

  useEffect(() => {
    if (switchId) {
      setDetail(null);
      setSelectedPort(null);
      loadPortmap(switchId);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('switch', switchId);
        return next;
      }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchId]);

  const grouped = useMemo(() => {
    if (!switches) return [];
    const byFabric = new Map();
    for (const s of switches) {
      const f = s.fabricName || 'Unassigned';
      if (!byFabric.has(f)) byFabric.set(f, []);
      byFabric.get(f).push(s);
    }
    return [...byFabric.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [switches]);

  const sw = detail && detail.switch;
  const ports = (detail && detail.ports) || [];
  const slots = useMemo(() => groupBySlot(ports, sw?.maxPort), [ports, sw]);

  const handleHover = (port, e) => {
    setHover(port);
    setHoverPos({ x: e.clientX, y: e.clientY });
  };
  const handleMove = (e) => setHoverPos({ x: e.clientX, y: e.clientY });
  const handleLeave = () => { setHover(null); setHoverPos(null); };
  const handleClick = (port) => setSelectedPort(port);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Grid3x3} title="Port Map" description="Visual switch faceplate — port state, connected devices, IO">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={() => loadPortmap(switchId)} />
      </PageHeader>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {switches == null ? (
          <LoadingPanel label="Loading switches…" height={60} />
        ) : switches.length === 0 ? (
          <div className="text-sm text-ink-muted py-2">No switches found.</div>
        ) : (
          <select
            value={switchId}
            onChange={(e) => setSwitchId(e.target.value)}
            className="bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink w-full max-w-md"
          >
            {grouped.map(([fabric, list]) => (
              <optgroup key={fabric} label={fabric}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} — {s.model || s.ipAddress || ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </div>

      <div className="flex gap-4 items-start">
        <div className="panel p-4 flex-1 min-w-0" style={{ borderTop: `3px solid ${BRAND}` }}>
          {detail === false ? (
            <div className="text-sm text-ink-muted py-6 text-center">Could not load port map.</div>
          ) : detail == null ? (
            <LoadingPanel label="Loading port map…" height={220} />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                <div>
                  <p className="text-sm font-semibold text-ink">{sw.name}</p>
                  <p className="text-[11px] text-ink-faint">{[sw.model, sw.ipAddress, sw.fabricName].filter(Boolean).join(' · ')}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge tone={statusTone(sw.operationalStatus)}>{sw.operationalStatus || 'Unknown'}</Badge>
                  <Badge tone={statusTone(sw.health)}>{sw.health || 'Unknown'}</Badge>
                </div>
              </div>

              {ports.length === 0 ? (
                <div className="text-sm text-ink-muted py-6 text-center">No ports inventoried yet.</div>
              ) : (
                <>
                  {slots.map(([slot, list]) => (
                    <SlotFaceplate
                      key={slot}
                      slot={sw.maxPort ? slot : null}
                      ports={list}
                      onHover={handleHover}
                      onMove={handleMove}
                      onLeave={handleLeave}
                      onClick={handleClick}
                      selectedId={selectedPort?.id}
                    />
                  ))}
                  <Legend ports={ports.filter((p) => !p.placeholder)} />
                </>
              )}
            </>
          )}
        </div>

        {selectedPort && (
          <div className="panel p-4 w-72 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-faint uppercase tracking-wide">Port Details</p>
              <button onClick={() => setSelectedPort(null)} aria-label="Close"
                className="flex items-center justify-center h-6 w-6 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer">
                <X size={13} />
              </button>
            </div>
            <PortDetails port={selectedPort} />
          </div>
        )}
      </div>

      <Tooltip port={hover} pos={hoverPos} />
    </div>
  );
}
