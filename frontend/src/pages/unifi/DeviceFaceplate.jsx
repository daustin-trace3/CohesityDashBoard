import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Router, Monitor, History, Cable } from 'lucide-react';
import PortHistoryModal from './PortHistoryModal';
import { poeWatts } from './helpers';

const PORT_W = 30;
const PORT_H = 34;
const PORT_GAP = 4;
const BANK_COLS = 12;
const SFP_W = 38;

const COLOR_DOWN = '#3a4048';
const COLOR_UP = '#6CB33F';
const COLOR_ERROR = '#D4A24E';
const COLOR_POE = '#006FFF';

function isSfp(port) {
  return String(port.media || '').toUpperCase().includes('SFP');
}

function portColor(port, errored) {
  if (!port.up) return COLOR_DOWN;
  if (errored) return COLOR_ERROR;
  return COLOR_UP;
}

function portHasErrors(port) {
  const rx = Number(port.rx_errors) || 0;
  const tx = Number(port.tx_errors) || 0;
  return rx + tx > 0;
}

function isPoeActive(port) {
  return !!port.poe_enable && port.poe_good !== 0 && port.poe_good !== false;
}

// Generic front-panel render, driven entirely by the ports array — scales from
// 5 to 24+ ports (wraps into extra port banks of up to 12 columns). Reused on
// both the Devices detail modal and directly on switch/AP rows.
// `attachments` maps port_idx -> [{mac,name,kind:'device'|'client',ip,signal,model}]
// and powers the port click popup; without it the popup still shows port facts.
export default function DeviceFaceplate({ ports = [], type, model, name, deviceMac, deviceName, uplinkPortIdx, errorFlags, attachments }) {
  const [hover, setHover] = useState(null); // { port, x, y }
  const [popupPort, setPopupPort] = useState(null);
  const [historyPort, setHistoryPort] = useState(null);

  const rj45 = useMemo(() => [...ports].filter((p) => !isSfp(p)).sort((a, b) => a.port_idx - b.port_idx), [ports]);
  const sfp = useMemo(() => [...ports].filter(isSfp).sort((a, b) => a.port_idx - b.port_idx), [ports]);

  const rj45Layout = useMemo(() => rj45.map((p, i) => {
    const col = Math.floor(i / 2);
    const bank = Math.floor(col / BANK_COLS);
    const colInBank = col % BANK_COLS;
    const row = (i % 2) + bank * 2;
    return { port: p, x: colInBank * (PORT_W + PORT_GAP), y: row * (PORT_H + PORT_GAP) };
  }), [rj45]);

  const banks = rj45Layout.length ? Math.max(...rj45Layout.map((l) => Math.floor(l.y / (PORT_H + PORT_GAP)))) / 2 + 1 : 1;
  const cols = rj45Layout.length ? Math.min(BANK_COLS, Math.ceil(rj45.length / 2)) : 0;

  const isUdm = type === 'udm';
  const lcdW = isUdm ? 56 : 0;
  const padX = 16;
  const padTop = 30; // room for device label
  const rj45AreaW = cols * (PORT_W + PORT_GAP) - (cols ? PORT_GAP : 0);
  const sfpAreaW = sfp.length * (SFP_W + PORT_GAP);
  const chassisW = padX * 2 + lcdW + (lcdW ? 12 : 0) + rj45AreaW + (sfp.length ? 12 + sfpAreaW : 0);
  const chassisH = padTop + banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP + 14;
  const minW = 260;
  const svgW = Math.max(minW, chassisW);
  const svgH = Math.max(120, chassisH);

  const attachedFor = (p) => (attachments && attachments[p.port_idx]) || [];

  const renderPort = (p, x, y, w, h, keyPrefix) => {
    const errored = errorFlags ? !!errorFlags[p.port_idx] : portHasErrors(p);
    const color = portColor(p, errored);
    const poeActive = isPoeActive(p);
    const w_ = poeWatts(p);
    const uplink = p.is_uplink || (uplinkPortIdx != null && p.port_idx === uplinkPortIdx);
    const attached = attachedFor(p);
    const stagger = ((p.port_idx % 8) * 0.18).toFixed(2);
    return (
      <g key={`${keyPrefix}-${p.port_idx}`}
        transform={`translate(${x},${y})`}
        onMouseEnter={(e) => setHover({ port: p, x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
        onMouseLeave={() => setHover(null)}
        onClick={() => { setHover(null); setPopupPort(p); }}
        style={{ cursor: 'pointer' }}
      >
        {poeActive && (
          <rect x={-2} y={-2} width={w + 4} height={h + 4} rx={4} fill="none" stroke={COLOR_POE} strokeWidth="2">
            <animate attributeName="opacity" values="0.9;0.35;0.9" dur="2.4s" begin={`${stagger}s`} repeatCount="indefinite" />
          </rect>
        )}
        <rect width={w} height={h} rx={2} fill={color} stroke="#1A1A1A" strokeWidth="1" />
        {p.up && (
          <rect x={3} y={3} width={5} height={3.5} rx={1} fill={errored ? '#7a5a1e' : '#eafff0'}>
            <animate attributeName="opacity" values="1;0.15;1" dur={errored ? '0.7s' : '1.3s'} begin={`${stagger}s`} repeatCount="indefinite" />
          </rect>
        )}
        <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize="9" fill="#111" fontWeight="600">{p.port_idx}</text>
        {uplink && <text x={w / 2} y={-4} textAnchor="middle" fontSize="9" fill="#E5E5E5">&#9650;</text>}
        {attached.length > 0 && (
          <g transform={`translate(${w - 5},${h - 5})`}>
            <circle r={4.5} fill="#0d0f12" stroke={COLOR_POE} strokeWidth="0.75" />
            <text y={2.5} textAnchor="middle" fontSize="6.5" fill="#E5E5E5" fontWeight="700">{attached.length}</text>
          </g>
        )}
        {poeActive && w_ != null && (
          <text x={w / 2} y={h + 11} textAnchor="middle" fontSize="7" fill="#8FA3B0">{w_.toFixed(1)}W</text>
        )}
      </g>
    );
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} width="100%" style={{ maxWidth: svgW }} className="select-none">
        <rect x={0} y={0} width={svgW} height={svgH} rx={10} fill="#1e2126" stroke="#3a4048" strokeWidth="1.5" />
        <text x={10} y={16} fontSize="10" fill="#E5E5E5" fontWeight="600">{name || model || 'Device'}</text>
        {isUdm && (
          <g transform={`translate(${padX}, ${padTop})`}>
            <rect width={lcdW} height={banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP} rx={4} fill="#0d0f12" stroke="#3a4048" strokeWidth="1" />
            <rect x={6} y={6} width={lcdW - 12} height={(banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP) - 12} rx={2} fill="#062033" stroke="#006FFF" strokeWidth="0.5" opacity="0.6" />
            <circle cx={lcdW / 2} cy={(banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP) / 2} r={3} fill="#006FFF">
              <animate attributeName="opacity" values="0.9;0.3;0.9" dur="3s" repeatCount="indefinite" />
            </circle>
          </g>
        )}
        <g transform={`translate(${padX + lcdW + (lcdW ? 12 : 0)}, ${padTop})`}>
          {rj45Layout.map(({ port, x, y }) => renderPort(port, x, y, PORT_W, PORT_H, 'rj45'))}
        </g>
        {sfp.length > 0 && (
          <g transform={`translate(${padX + lcdW + (lcdW ? 12 : 0) + rj45AreaW + 12}, ${padTop})`}>
            {sfp.map((p, i) => renderPort(p, i * (SFP_W + PORT_GAP), 0, SFP_W, PORT_H, 'sfp'))}
          </g>
        )}
      </svg>

      {hover && !popupPort && (
        <div className="fixed z-50 pointer-events-none bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl px-3 py-2 text-[11px] text-ink"
          style={{ left: hover.x + 12, top: hover.y + 12, maxWidth: 220 }}>
          <p className="font-semibold mb-1">Port {hover.port.port_idx}{hover.port.name ? ` — ${hover.port.name}` : ''}</p>
          <p className="text-ink-muted">{hover.port.up ? 'Up' : 'Down'}{hover.port.speed ? ` · ${hover.port.speed} Mbps` : ''}{hover.port.full_duplex != null ? ` · ${hover.port.full_duplex ? 'Full' : 'Half'} duplex` : ''}</p>
          {hover.port.poe_class && <p className="text-ink-muted">PoE {hover.port.poe_class}{poeWatts(hover.port) != null ? ` · ${poeWatts(hover.port).toFixed(1)}W` : ''}{hover.port.poe_voltage ? ` · ${Number(hover.port.poe_voltage).toFixed(1)}V` : ''}</p>}
          {attachedFor(hover.port).length > 0 && <p className="text-ink-muted">{attachedFor(hover.port).length} attached</p>}
          {(Number(hover.port.rx_errors) || Number(hover.port.tx_errors)) ? (
            <p className="text-status-warn">{fmtErrCount(hover.port)} errors</p>
          ) : null}
          <p className="text-ink-faint mt-1">Click for details</p>
        </div>
      )}

      {popupPort && (
        <PortPopup
          port={popupPort}
          attached={attachedFor(popupPort)}
          deviceName={deviceName || name}
          canHistory={!!deviceMac}
          onHistory={() => { setPopupPort(null); setHistoryPort(popupPort); }}
          onClose={() => setPopupPort(null)}
        />
      )}

      {historyPort && (
        <PortHistoryModal
          mac={deviceMac}
          portIdx={historyPort.port_idx}
          portLabel={historyPort.name}
          deviceName={deviceName || name}
          onClose={() => setHistoryPort(null)}
        />
      )}
    </div>
  );
}

function PortPopup({ port, attached, deviceName, canHistory, onHistory, onClose }) {
  const errs = (Number(port.rx_errors) || 0) + (Number(port.tx_errors) || 0);
  const drops = (Number(port.rx_dropped) || 0) + (Number(port.tx_dropped) || 0);
  const w_ = poeWatts(port);
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-md max-h-[80vh] flex flex-col" style={{ borderTop: '3px solid #006FFF' }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            <Cable size={16} className="text-brand shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">Port {port.port_idx}{port.name && port.name !== `Port ${port.port_idx}` ? ` — ${port.name}` : ''}</p>
              <p className="text-[11px] text-ink-faint truncate">{deviceName}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          <div className="grid grid-cols-3 gap-3 mb-4 text-xs">
            <PFact label="Status" value={port.up ? `Up · ${port.speed ? `${port.speed} Mbps` : ''}` : 'Down'} tone={port.up ? 'ok' : undefined} />
            <PFact label="Media" value={port.media || '—'} />
            <PFact label="Network" value={port.network_name || '—'} />
            <PFact label="PoE" value={port.poe_enable ? `${port.poe_class || 'on'}${w_ != null ? ` · ${w_.toFixed(1)}W` : ''}${port.poe_good === 0 ? ' · FAULT' : ''}` : '—'}
              tone={port.poe_good === 0 && port.poe_enable ? 'bad' : undefined} />
            <PFact label="Errors" value={errs.toLocaleString()} tone={errs > 0 ? 'warn' : undefined} />
            <PFact label="Dropped" value={drops.toLocaleString()} />
          </div>

          <p className="text-xs font-semibold text-ink mb-2">Attached ({attached.length})</p>
          {attached.length === 0 ? (
            <p className="text-xs text-ink-muted mb-3">{port.up ? 'Nothing directly attached is reported on this port.' : 'Port is down — nothing attached.'}</p>
          ) : (
            <div className="flex flex-col gap-1 mb-3">
              {attached.map((a) => (
                <div key={a.mac} className="flex items-center gap-2 text-xs bg-surface-overlay rounded-lg px-3 py-2">
                  {a.kind === 'device'
                    ? <Router size={13} className="text-brand shrink-0" />
                    : <Monitor size={13} className="text-ink-faint shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-ink truncate">{a.name || a.mac}</p>
                    <p className="text-[10px] text-ink-faint truncate">
                      {[a.kind === 'device' ? (a.model || 'UniFi device') : null, a.ip, a.mac, a.signal != null ? `${a.signal} dBm` : null]
                        .filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {a.kind === 'device' && a.behind > 0 && (
                    <span className="text-[10px] text-ink-faint shrink-0">+{a.behind} behind</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {canHistory && (
            <button onClick={onHistory}
              className="flex items-center gap-1.5 text-xs font-semibold text-brand border border-brand/30 bg-brand/10 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-brand/20 transition-colors">
              <History size={13} /> View port history
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function PFact({ label, value, tone }) {
  const toneCls = tone === 'ok' ? 'text-status-ok' : tone === 'warn' ? 'text-status-warn' : tone === 'bad' ? 'text-status-bad' : 'text-ink';
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={toneCls}>{value ?? '—'}</p>
    </div>
  );
}

function fmtErrCount(port) {
  const n = (Number(port.rx_errors) || 0) + (Number(port.tx_errors) || 0);
  return n.toLocaleString();
}
