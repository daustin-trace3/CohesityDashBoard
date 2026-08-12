// Port of frontend/src/pages/unifi/UnifiDevicesPage.jsx onto the plugin ui kit.
import {
  PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Modal, Fact,
  useTableControls, SortTh, TableControls, TablePager,
  apiFetch, fmtNum, stateTone, stateLabel, typeLabel, typeTone, parseJsonArr, poeWatts, BRAND,
} from '../ui.jsx';
import { Router, Cable } from '../icons.jsx';
import DeviceFaceplate from './faceplate.jsx';

function PortTable({ ports }) {
  if (!ports.length) return <p className="text-xs text-ink-muted py-1">No ports reported.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-1.5 pr-3">Port</th>
          <th className="py-1.5 pr-3">Name</th>
          <th className="py-1.5 pr-3">Media</th>
          <th className="py-1.5 pr-3">Status</th>
          <th className="py-1.5 pr-3 text-right">Speed</th>
          <th className="py-1.5 pr-3">PoE</th>
          <th className="py-1.5 pr-3 text-right">Errors</th>
          <th className="py-1.5 pr-3">Network</th>
        </tr></thead>
        <tbody>
          {ports.map((p) => (
            <tr key={p.port_idx} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 tnum text-ink-muted">{p.port_idx}</td>
              <td className="py-1.5 pr-3 text-ink-muted">{p.name || '—'}</td>
              <td className="py-1.5 pr-3 text-ink-faint">{p.media || '—'}</td>
              <td className="py-1.5 pr-3"><Badge tone={p.up ? 'ok' : 'neutral'}>{p.up ? 'Up' : 'Down'}</Badge></td>
              <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{p.speed ? `${p.speed} Mbps` : '—'}</td>
              <td className="py-1.5 pr-3 text-ink-faint">{p.poe_enable ? `${poeWatts(p) != null ? `${poeWatts(p).toFixed(1)}W` : 'on'}${p.poe_good === 0 ? ' (fault)' : ''}` : '—'}</td>
              <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{(Number(p.rx_errors) || 0) + (Number(p.tx_errors) || 0)}</td>
              <td className="py-1.5 pr-3 text-ink-faint">{p.network_name || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Attached-per-port map from the controller topology: edges carry the
// parent-side port number, the only reliable per-port wiring source.
function buildAttachments(topo, deviceMac, detailClients) {
  if (!topo?.edges) return {};
  const clientRows = new Map((detailClients || []).map((c) => [c.mac, c]));
  const childEdges = new Map();
  for (const e of topo.edges) {
    if (!childEdges.has(e.uplinkMac)) childEdges.set(e.uplinkMac, []);
    childEdges.get(e.uplinkMac).push(e);
  }
  const behindCount = (m, seen = new Set()) => {
    if (seen.has(m)) return 0;
    seen.add(m);
    let n = 0;
    for (const e of childEdges.get(m) || []) { n += 1 + behindCount(e.downlinkMac, seen); }
    return n;
  };
  const out = {};
  for (const e of childEdges.get(deviceMac) || []) {
    if (e.uplinkPortNumber == null) continue;
    const dm = topo.deviceMeta?.[e.downlinkMac];
    const cm = topo.clientMeta?.[e.downlinkMac];
    const row = clientRows.get(e.downlinkMac);
    const entry = dm
      ? { mac: e.downlinkMac, kind: 'device', name: dm.name, model: dm.model, ip: dm.ip, behind: behindCount(e.downlinkMac) }
      : { mac: e.downlinkMac, kind: 'client', name: cm?.name || cm?.hostname || row?.name || row?.hostname, ip: cm?.ip || row?.ip, signal: cm?.signal ?? row?.signal };
    if (!out[e.uplinkPortNumber]) out[e.uplinkPortNumber] = [];
    out[e.uplinkPortNumber].push(entry);
  }
  return out;
}

function DeviceDetailModal({ mac, onClose }) {
  const [detail, setDetail] = React.useState(null);
  const [topo, setTopo] = React.useState(null);

  React.useEffect(() => {
    apiFetch(`/unifi/devices/${mac}`)
      .then((data) => setDetail(data))
      .catch(() => setDetail(false));
    apiFetch('/unifi/topology')
      .then((data) => setTopo(data))
      .catch(() => setTopo(null));
  }, [mac]);

  if (detail === false) {
    return (
      <Modal title="Device" icon={Router} onClose={onClose}>
        <p className="text-sm text-ink-muted py-6 text-center">Could not load device detail.</p>
      </Modal>
    );
  }
  if (!detail) {
    return (
      <Modal title="Loading…" icon={Router} onClose={onClose}>
        <LoadingPanel label="Loading device…" height={160} />
      </Modal>
    );
  }

  const { device, ports, clients } = detail;
  const temps = parseJsonArr(device.temps_json);
  const maxTemp = temps.length ? Math.max(...temps.map((t) => Number(t.value)).filter(Number.isFinite)) : null;

  return (
    <Modal title={device.name || device.mac} subtitle={[device.model, device.ip, device.source_name].filter(Boolean).join(' · ')} icon={Router} onClose={onClose} maxWidth="min(960px,92vw)">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={stateTone(device)}>{stateLabel(device)}</Badge>
        <Badge tone={typeTone(device.type)}>{typeLabel(device.type)}</Badge>
        {device.upgradable ? <Badge tone="info">Upgrade available</Badge> : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="IP" value={device.ip} />
        <Fact label="MAC" value={device.mac} />
        <Fact label="Version" value={device.version} />
        <Fact label="Uptime" value={device.uptime ? `${Math.round(device.uptime / 3600)}h` : null} />
        <Fact label="Clients" value={fmtNum(device.num_sta)} />
        <Fact label="CPU / Mem" value={device.cpu_pct != null ? `${device.cpu_pct.toFixed(0)}% / ${device.mem_pct != null ? device.mem_pct.toFixed(0) : '—'}%` : null} />
        <Fact label="Temp" value={maxTemp != null ? `${maxTemp.toFixed(0)}°C` : null} />
        <Fact label="Satisfaction" value={device.satisfaction != null ? `${device.satisfaction}%` : null} />
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Cable size={13} className="text-brand" /> Front Panel</p>
        <div className="panel p-3">
          <DeviceFaceplate ports={ports} type={device.type} model={device.model} name={device.name}
            deviceMac={device.mac} deviceName={device.name} uplinkPortIdx={device.uplink_port}
            attachments={buildAttachments(topo, device.mac, clients)} />
        </div>
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Cable size={13} className="text-brand" /> Ports ({ports.length})</p>
        <PortTable ports={ports} />
      </div>

      {clients?.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-ink mb-2">Connected Clients ({clients.length})</p>
          <div className="flex flex-col gap-1">
            {clients.map((c) => (
              <div key={c.id} className="flex items-center justify-between text-xs bg-surface-overlay rounded-lg px-3 py-1.5">
                <span className="text-ink">{c.name || c.hostname || c.mac}</span>
                <span className="text-ink-faint tnum">{c.ip}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function UnifiDevicesPage() {
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailMac, setDetailMac] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/unifi/devices')
    .then((data) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);

  const list = (rows || []).map((d) => {
    const temps = parseJsonArr(d.temps_json);
    const maxTemp = temps.length ? Math.max(...temps.map((t) => Number(t.value)).filter(Number.isFinite)) : null;
    return { ...d, state_label: stateLabel(d), type_label: typeLabel(d.type), max_temp: maxTemp };
  });
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'model', 'ip', 'mac', 'source_name'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="uf-root animate-fade-in">
      <PageHeader icon={Router} title="Devices" description="UniFi network devices — gateways, switches and access points">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, model, IP, MAC or source…"
          filters={[{ k: 'type_label', label: 'Types' }, { k: 'source_name', label: 'Sources' }, { k: 'state_label', label: 'States' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading devices…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No devices match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="type_label" label="Type" ctl={ctl} />
                <SortTh k="ip" label="IP" ctl={ctl} />
                <SortTh k="version" label="Version" ctl={ctl} />
                <SortTh k="state_label" label="State" ctl={ctl} />
                <SortTh k="cpu_pct" label="CPU" ctl={ctl} align="right" />
                <SortTh k="mem_pct" label="Mem" ctl={ctl} align="right" />
                <SortTh k="max_temp" label="Temp" ctl={ctl} align="right" />
                <SortTh k="num_sta" label="Clients" ctl={ctl} align="right" />
                <SortTh k="ports_up" label="Ports" ctl={ctl} align="right" />
                <SortTh k="poe_watts_total" label="PoE W" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((d) => (
                  <tr key={d.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailMac(d.mac)} className="text-brand hover:underline cursor-pointer text-left">{d.name || d.mac}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{d.model || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={typeTone(d.type)}>{d.type_label}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{d.ip || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{d.version || '—'}{d.upgradable ? ' *' : ''}</td>
                    <td className="py-2 pr-3"><Badge tone={stateTone(d)}>{d.state_label}</Badge></td>
                    <td className={`py-2 pr-3 text-right tnum ${d.cpu_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{d.cpu_pct != null ? `${d.cpu_pct.toFixed(0)}%` : '—'}</td>
                    <td className={`py-2 pr-3 text-right tnum ${d.mem_pct > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{d.mem_pct != null ? `${d.mem_pct.toFixed(0)}%` : '—'}</td>
                    <td className={`py-2 pr-3 text-right tnum ${d.max_temp > 80 ? 'text-status-warn font-semibold' : 'text-ink-muted'}`}>{d.max_temp != null ? `${d.max_temp.toFixed(0)}°C` : '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(d.num_sta)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{d.ports_up ?? 0}/{d.ports_total ?? 0}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{d.poe_watts_total ? Number(d.poe_watts_total).toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detailMac != null && <DeviceDetailModal mac={detailMac} onClose={() => setDetailMac(null)} />}
    </div>
  );
}
