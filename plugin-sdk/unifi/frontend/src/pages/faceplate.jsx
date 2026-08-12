// Port of frontend/src/pages/unifi/DeviceFaceplate.jsx — SVG front-panel
// with link/PoE/attached-count animations, hover tooltip and click popup.
import { poeWatts } from '../ui.jsx';
import { X, Router, Cable, History } from '../icons.jsx';
import PortHistoryModal from './portHistoryModal.jsx';

const PORT_W = 34;
const PORT_H = 30;
const PORT_GAP = 6;
const NUM_H = 11;
const BANK_COLS = 12;
const SFP_W = 40;
const SFP_H = 26;

const LED_UP = '#38c95c';
const LED_ERR = '#e0a13e';
const LED_POE = '#2f81f7';

function isSfp(port) {
  return String(port.media || '').toUpperCase().includes('SFP');
}

function portHasErrors(port) {
  const rx = Number(port.rx_errors) || 0;
  const tx = Number(port.tx_errors) || 0;
  return rx + tx > 0;
}

function isPoeActive(port) {
  return !!port.poe_enable && port.poe_good !== 0 && port.poe_good !== false;
}

export default function DeviceFaceplate({ ports = [], type, model, name, deviceMac, deviceName, uplinkPortIdx, errorFlags, attachments }) {
  const [hover, setHover] = React.useState(null);
  const [popupPort, setPopupPort] = React.useState(null);
  const [historyPort, setHistoryPort] = React.useState(null);

  const rj45 = React.useMemo(() => [...ports].filter((p) => !isSfp(p)).sort((a, b) => a.port_idx - b.port_idx), [ports]);
  const sfp = React.useMemo(() => [...ports].filter(isSfp).sort((a, b) => a.port_idx - b.port_idx), [ports]);

  const rj45Layout = React.useMemo(() => rj45.map((p, i) => {
    const col = Math.floor(i / 2);
    const bank = Math.floor(col / BANK_COLS);
    const colInBank = col % BANK_COLS;
    const row = (i % 2) + bank * 2;
    return { port: p, x: colInBank * (PORT_W + PORT_GAP), y: NUM_H + row * (PORT_H + PORT_GAP), topRow: i % 2 === 0 };
  }), [rj45]);

  const banks = rj45Layout.length ? Math.floor(Math.max(...rj45Layout.map((l) => (l.y - NUM_H) / (PORT_H + PORT_GAP))) / 2) + 1 : 1;
  const cols = rj45Layout.length ? Math.min(BANK_COLS, Math.ceil(rj45.length / 2)) : 0;
  const portAreaH = banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP + NUM_H * 2;

  const isUdm = type === 'udm';
  const lcdW = isUdm ? 64 : 0;
  const bayW = isUdm ? 150 : 0;
  const padX = 18;
  const padTop = 26;
  const rj45AreaW = cols * (PORT_W + PORT_GAP) - (cols ? PORT_GAP : 0);
  const sfpCols = Math.ceil(sfp.length / 2);
  const sfpAreaW = sfpCols * (SFP_W + PORT_GAP);
  const chassisW = padX * 2 + lcdW + (lcdW ? 14 : 0) + bayW + (bayW ? 14 : 0) + rj45AreaW + (sfp.length ? 14 + sfpAreaW : 0);
  const chassisH = padTop + portAreaH + 12;
  const minW = 300;
  const svgW = Math.max(minW, chassisW);
  const svgH = Math.max(110, chassisH);
  const innerH = portAreaH;

  const attachedFor = (p) => (attachments && attachments[p.port_idx]) || [];

  const renderRj45 = ({ port: p, x, y, topRow }) => {
    const errored = errorFlags ? !!errorFlags[p.port_idx] : portHasErrors(p);
    const poeActive = isPoeActive(p);
    const w_ = poeWatts(p);
    const uplink = p.is_uplink || (uplinkPortIdx != null && p.port_idx === uplinkPortIdx);
    const attached = attachedFor(p);
    const stagger = ((p.port_idx % 8) * 0.18).toFixed(2);
    return (
      <g key={`rj45-${p.port_idx}`} transform={`translate(${x},${y})`}
        onMouseEnter={(e) => setHover({ port: p, x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
        onMouseLeave={() => setHover(null)}
        onClick={() => { setHover(null); setPopupPort(p); }}
        style={{ cursor: 'pointer' }}>
        <text x={PORT_W / 2} y={topRow ? -3 : PORT_H + 9} textAnchor="middle" fontSize="7.5" fill="#6b7684" fontWeight="600">
          {p.port_idx}{p.poe_capable ? '⚡' : ''}{uplink ? ' ▲' : ''}
        </text>
        <rect width={PORT_W} height={PORT_H} rx={2.5} fill="#14171b" stroke="#0a0c0e" strokeWidth="1" />
        <rect x={2} y={2} width={PORT_W - 4} height={PORT_H - 4} rx={1.5} fill="#1e2126" />
        <rect x={PORT_W / 2 - 8} y={PORT_H - 9} width={16} height={5} rx={1} fill="#0a0c0e" />
        {p.up ? (
          <>
            <circle cx={5.5} cy={5.5} r={2.4} fill={errored ? LED_ERR : LED_UP} />
            <circle cx={5.5} cy={5.5} r={4} fill="none" stroke={errored ? LED_ERR : LED_UP} strokeWidth="1" opacity="0.35" />
            <circle cx={PORT_W - 5.5} cy={5.5} r={2} fill={errored ? LED_ERR : LED_UP}>
              <animate attributeName="opacity" values="1;0.1;1" dur={errored ? '0.7s' : '1.3s'} begin={`${stagger}s`} repeatCount="indefinite" />
            </circle>
          </>
        ) : (
          <>
            <circle cx={5.5} cy={5.5} r={2.4} fill="#33383f" />
            <circle cx={PORT_W - 5.5} cy={5.5} r={2} fill="#33383f" />
          </>
        )}
        {poeActive && (
          <g>
            <rect x={PORT_W / 2 - 11} y={topRow ? PORT_H + 1.5 : -8.5} width={22} height={7} rx={2} fill={LED_POE} opacity="0.9">
              <animate attributeName="opacity" values="0.9;0.5;0.9" dur="2.4s" begin={`${stagger}s`} repeatCount="indefinite" />
            </rect>
            <text x={PORT_W / 2} y={topRow ? PORT_H + 7 : -3} textAnchor="middle" fontSize="5.5" fill="#fff" fontWeight="700">
              {w_ != null ? `${w_.toFixed(1)}W` : 'PoE'}
            </text>
          </g>
        )}
        {attached.length > 0 && (
          <g transform={`translate(${PORT_W - 5},${PORT_H - 5})`}>
            <circle r={4.5} fill="#0d0f12" stroke={LED_POE} strokeWidth="0.75" />
            <text y={2.5} textAnchor="middle" fontSize="6.5" fill="#E5E5E5" fontWeight="700">{attached.length}</text>
          </g>
        )}
      </g>
    );
  };

  const renderSfp = (p, i) => {
    const errored = errorFlags ? !!errorFlags[p.port_idx] : portHasErrors(p);
    const uplink = p.is_uplink || (uplinkPortIdx != null && p.port_idx === uplinkPortIdx);
    const attached = attachedFor(p);
    const col = Math.floor(i / 2);
    const topRow = i % 2 === 0;
    const x = col * (SFP_W + PORT_GAP);
    const y = NUM_H + (topRow ? 0 : SFP_H + PORT_GAP + 8);
    const stagger = ((p.port_idx % 8) * 0.18).toFixed(2);
    return (
      <g key={`sfp-${p.port_idx}`} transform={`translate(${x},${y})`}
        onMouseEnter={(e) => setHover({ port: p, x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
        onMouseLeave={() => setHover(null)}
        onClick={() => { setHover(null); setPopupPort(p); }}
        style={{ cursor: 'pointer' }}>
        <text x={SFP_W / 2} y={topRow ? -3 : SFP_H + 9} textAnchor="middle" fontSize="7.5" fill="#6b7684" fontWeight="600">
          {p.port_idx}{uplink ? ' ▲' : ''} <tspan fontSize="6">SFP+</tspan>
        </text>
        <rect width={SFP_W} height={SFP_H} rx={2} fill="#14171b" stroke="#0a0c0e" strokeWidth="1" />
        <rect x={3} y={4} width={SFP_W - 6} height={SFP_H - 8} rx={1} fill="#1e2126" stroke="#2c313a" strokeWidth="0.75" />
        <rect x={6} y={SFP_H / 2 - 1.25} width={SFP_W - 12} height={2.5} rx={1.25} fill="#3d434d" />
        {p.up ? (
          <circle cx={SFP_W - 6} cy={6} r={2.2} fill={errored ? LED_ERR : LED_UP}>
            <animate attributeName="opacity" values="1;0.25;1" dur={errored ? '0.7s' : '1.6s'} begin={`${stagger}s`} repeatCount="indefinite" />
          </circle>
        ) : (
          <circle cx={SFP_W - 6} cy={6} r={2.2} fill="#33383f" />
        )}
        {attached.length > 0 && (
          <g transform={`translate(${SFP_W - 6},${SFP_H - 6})`}>
            <circle r={4.5} fill="#0d0f12" stroke={LED_POE} strokeWidth="0.75" />
            <text y={2.5} textAnchor="middle" fontSize="6.5" fill="#E5E5E5" fontWeight="700">{attached.length}</text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${svgW} ${svgH}`} width="100%" style={{ maxWidth: svgW }} className="select-none">
        <defs>
          <linearGradient id="ufp-chassis" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#e8eaed" />
            <stop offset="0.06" stopColor="#f4f5f7" />
            <stop offset="0.5" stopColor="#dfe2e6" />
            <stop offset="1" stopColor="#c3c8cf" />
          </linearGradient>
          <linearGradient id="ufp-bay" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#cfd3d9" />
            <stop offset="0.5" stopColor="#dde0e5" />
            <stop offset="1" stopColor="#c6cbd2" />
          </linearGradient>
        </defs>

        <rect x={0} y={0} width={svgW} height={svgH} rx={8} fill="url(#ufp-chassis)" stroke="#a9afb8" strokeWidth="1" />
        <rect x={0.75} y={1} width={svgW - 1.5} height={2.5} rx={1.25} fill="#ffffff" opacity="0.55" />
        <text x={12} y={16} fontSize="9" fill="#4b535e" fontWeight="700">{name || model || 'Device'}</text>
        {model && <text x={svgW - 12} y={16} fontSize="8" fill="#8a919c" fontWeight="600" textAnchor="end">{model}</text>}

        {isUdm && (
          <g transform={`translate(${padX}, ${padTop + Math.max(0, (innerH - 56) / 2)})`}>
            <rect width={lcdW} height={56} rx={6} fill="#0b0e14" stroke="#2a2f38" strokeWidth="1" />
            <text x={lcdW / 2} y={13} textAnchor="middle" fontSize="6" fill="#7d8794">Network</text>
            <circle cx={lcdW / 2} cy={32} r={11} fill="none" stroke="#2f5cab" strokeWidth="2" opacity="0.9" />
            <circle cx={lcdW / 2} cy={32} r={4.5} fill="#e8eaed">
              <animate attributeName="opacity" values="1;0.55;1" dur="3s" repeatCount="indefinite" />
            </circle>
            <g fill="#3a4552">
              {[0, 1, 2, 3, 4].map((i) => <circle key={i} cx={lcdW / 2 - 10 + i * 5} cy={49} r={1.1} opacity={i === 0 ? 1 : 0.45} />)}
            </g>
          </g>
        )}

        {isUdm && (
          <g transform={`translate(${padX + lcdW + 14}, ${padTop + Math.max(0, (innerH - 56) / 2)})`}>
            {[0, 1].map((i) => (
              <g key={i} transform={`translate(${i * (bayW / 2 + 4)},0)`}>
                <rect width={bayW / 2 - 4} height={56} rx={4} fill="url(#ufp-bay)" stroke="#aeb4bd" strokeWidth="0.75" />
                <circle cx={(bayW / 2 - 4) / 2} cy={28} r={1.6} fill="#f7f8fa" stroke="#9aa1ab" strokeWidth="0.5" />
                <text x={(bayW / 2 - 4) / 2} y={51} textAnchor="middle" fontSize="6" fill="#8a919c">{i + 1}</text>
              </g>
            ))}
          </g>
        )}

        <g transform={`translate(${padX + lcdW + (lcdW ? 14 : 0) + bayW + (bayW ? 14 : 0)}, ${padTop})`}>
          {rj45Layout.map(renderRj45)}
        </g>
        {sfp.length > 0 && (
          <g transform={`translate(${padX + lcdW + (lcdW ? 14 : 0) + bayW + (bayW ? 14 : 0) + rj45AreaW + 14}, ${padTop})`}>
            {sfp.map((p, i) => renderSfp(p, i))}
          </g>
        )}

        <g transform={`translate(12, ${svgH - 7})`} fontSize="6" fill="#8a919c">
          <circle cx={0} cy={-2} r={2} fill={LED_UP} /><text x={5} y={0}>link</text>
          <circle cx={26} cy={-2} r={2} fill={LED_ERR} /><text x={31} y={0}>errors</text>
          <rect x={57} y={-5} width={10} height={6} rx={2} fill={LED_POE} /><text x={70} y={0}>PoE</text>
          <circle cx={92} cy={-2} r={2} fill="#33383f" /><text x={97} y={0}>down</text>
        </g>
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
  return ReactDOM.createPortal(
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
                    : <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="text-ink-faint shrink-0"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>}
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
