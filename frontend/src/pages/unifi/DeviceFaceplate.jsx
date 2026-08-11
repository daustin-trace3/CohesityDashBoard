import { useMemo, useState } from 'react';
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
export default function DeviceFaceplate({ ports = [], type, model, name, deviceMac, deviceName, uplinkPortIdx, errorFlags }) {
  const [hover, setHover] = useState(null); // { port, x, y }
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

  const onPortClick = (port) => {
    if (!deviceMac) return;
    setHistoryPort(port);
  };

  const renderPort = (p, x, y, w, h, keyPrefix) => {
    const errored = errorFlags ? !!errorFlags[p.port_idx] : portHasErrors(p);
    const color = portColor(p, errored);
    const poeActive = isPoeActive(p);
    const w_ = poeWatts(p);
    const uplink = p.is_uplink || (uplinkPortIdx != null && p.port_idx === uplinkPortIdx);
    return (
      <g key={`${keyPrefix}-${p.port_idx}`}
        transform={`translate(${x},${y})`}
        onMouseEnter={(e) => setHover({ port: p, x: e.clientX, y: e.clientY })}
        onMouseMove={(e) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))}
        onMouseLeave={() => setHover(null)}
        onClick={() => onPortClick(p)}
        style={{ cursor: deviceMac ? 'pointer' : 'default' }}
      >
        {poeActive && (
          <rect x={-2} y={-2} width={w + 4} height={h + 4} rx={4} fill="none" stroke={COLOR_POE} strokeWidth="2" opacity="0.85" />
        )}
        <rect width={w} height={h} rx={2} fill={color} stroke="#1A1A1A" strokeWidth="1" />
        <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize="9" fill="#111" fontWeight="600">{p.port_idx}</text>
        {uplink && <text x={w / 2} y={-4} textAnchor="middle" fontSize="9" fill="#E5E5E5">&#9650;</text>}
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
            <circle cx={lcdW / 2} cy={(banks * 2 * (PORT_H + PORT_GAP) - PORT_GAP) / 2} r={3} fill="#006FFF" opacity="0.8" />
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

      {hover && (
        <div className="fixed z-50 pointer-events-none bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl px-3 py-2 text-[11px] text-ink"
          style={{ left: hover.x + 12, top: hover.y + 12, maxWidth: 220 }}>
          <p className="font-semibold mb-1">Port {hover.port.port_idx}{hover.port.name ? ` — ${hover.port.name}` : ''}</p>
          <p className="text-ink-muted">{hover.port.up ? 'Up' : 'Down'}{hover.port.speed ? ` · ${hover.port.speed} Mbps` : ''}{hover.port.full_duplex != null ? ` · ${hover.port.full_duplex ? 'Full' : 'Half'} duplex` : ''}</p>
          {hover.port.poe_class && <p className="text-ink-muted">PoE {hover.port.poe_class}{poeWatts(hover.port) != null ? ` · ${poeWatts(hover.port).toFixed(1)}W` : ''}{hover.port.poe_voltage ? ` · ${Number(hover.port.poe_voltage).toFixed(1)}V` : ''}</p>}
          {(Number(hover.port.rx_errors) || Number(hover.port.tx_errors)) ? (
            <p className="text-status-warn">{fmtErrCount(hover.port)} errors</p>
          ) : null}
        </div>
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

function fmtErrCount(port) {
  const n = (Number(port.rx_errors) || 0) + (Number(port.tx_errors) || 0);
  return n.toLocaleString();
}
