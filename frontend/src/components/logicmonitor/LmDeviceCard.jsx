// LogicMonitor's view of an object another platform shows (a Brocade switch,
// a Cohesity node, a NetApp cluster): host status, open alerts and the switch
// ports ICC ties to the same names and addresses. Reads
// GET /logicmonitor/lookup and renders nothing when the platform is off, the
// caller has no grant, LogicMonitor does not know the object, or the call
// fails, so a page can mount it unconditionally.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { Badge } from '../ui/primitives';
import { BRAND, hostStatusTone, hostStatusLabel, severityTone, statusTextTone, fmtWhen } from '../../pages/logicmonitor/helpers';

const clean = (list) => Array.from(new Set((list || []).map((v) => String(v == null ? '' : v).trim()).filter(Boolean)));

const fmtVal = (m) => {
  const v = m.value;
  if (v == null) return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (m.unit === 'bytes') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let x = n; let u = 0;
    while (Math.abs(x) >= 1024 && u < units.length - 1) { x /= 1024; u += 1; }
    return `${Math.round(x * 10) / 10} ${units[u]}`;
  }
  const r = Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
  return m.unit ? `${r} ${m.unit}` : r;
};

// Metrics LogicMonitor collected for the object, one compact table per DataSource.
// An instance row shows its metrics as "label: value" pairs; more than six
// instances in a group collapse behind "show all".
function ViaLogicMonitor({ metrics }) {
  const [open, setOpen] = useState({});
  const groups = [];
  const byDs = new Map();
  for (const m of metrics) {
    let g = byDs.get(m.datasource);
    if (!g) { g = { ds: m.datasource, label: m.datasourceLabel || m.datasource, instances: new Map() }; byDs.set(m.datasource, g); groups.push(g); }
    let inst = g.instances.get(m.instanceKey);
    if (!inst) { inst = { key: m.instanceKey, name: m.instanceName || m.instanceKey, items: [] }; g.instances.set(m.instanceKey, inst); }
    inst.items.push(m);
  }
  return (
    <div className="mt-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Via LogicMonitor</p>
      {groups.map((g) => {
        const rows = [...g.instances.values()];
        const showAll = !!open[g.ds];
        const shown = showAll ? rows : rows.slice(0, 6);
        return (
          <div key={g.ds} className="mb-2">
            <p className="text-[11px] text-ink font-semibold">{g.label} <span className="text-ink-faint font-normal">({rows.length} instance{rows.length === 1 ? '' : 's'})</span></p>
            <table className="w-full text-[11px] text-ink-muted tnum">
              <tbody>
                {shown.map((inst) => (
                  <tr key={inst.key} className="border-t border-cohesity-border/30">
                    <td className="py-0.5 pr-3 text-ink whitespace-nowrap align-top">{inst.name}</td>
                    <td className="py-0.5">{inst.items.map((m) => (
                      <span key={m.metric} className="mr-3 whitespace-nowrap">{m.label}: <span className="text-ink">{fmtVal(m)}</span></span>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 6 && (
              <button type="button" onClick={() => setOpen((o) => ({ ...o, [g.ds]: !showAll }))} className="text-[11px] text-brand hover:text-brand-bright">
                {showAll ? 'show fewer' : `show all ${rows.length}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function LmDeviceCard({ names = [], ips = [], family = '', showMetrics = true, className = '' }) {
  const n = clean(names).join(',');
  const i = clean(ips).join(',');
  const [res, setRes] = useState(null);

  useEffect(() => {
    if (!n && !i) { setRes(null); return undefined; }
    let live = true;
    const params = {};
    if (n) params.names = n;
    if (i) params.ips = i;
    if (family) params.family = family;
    client.get('/logicmonitor/lookup', { params })
      .then(({ data }) => { if (live) setRes(data || null); })
      .catch(() => { if (live) setRes(null); });
    return () => { live = false; };
  }, [n, i, family]);

  if (!res) return null;
  const device = res.device || null;
  const ports = Array.isArray(res.switchPorts) ? res.switchPorts : [];
  const alerts = Array.isArray(res.alerts) ? res.alerts : [];
  if (!device && !ports.length) return null;
  const health = res.health || {};
  const metrics = showMetrics && Array.isArray(res.metrics) ? res.metrics : [];

  return (
    <div className={`rounded-lg border border-cohesity-border/60 bg-surface-overlay/40 p-3 ${className}`} style={{ borderTop: `3px solid ${BRAND}` }}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{ borderColor: `${BRAND}55`, color: BRAND, backgroundColor: `${BRAND}14` }}>
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: BRAND }} />
          LogicMonitor
        </span>
        {device ? (
          <>
            <span className="text-xs text-ink font-semibold">{device.displayName}</span>
            <Badge tone={hostStatusTone(health.hostStatus)}>{hostStatusLabel(health.hostStatus)}</Badge>
            {health.collectorDown ? <Badge tone="warn">Collector down</Badge> : null}
            <Badge tone={alerts.length ? 'warn' : 'ok'}>{alerts.length ? `${alerts.length} open alert${alerts.length === 1 ? '' : 's'}` : 'No open alerts'}</Badge>
            {health.deadSince ? <span className="text-[11px] text-ink-faint">dead since {fmtWhen(health.deadSince)}</span> : null}
            <Link to={`/logicmonitor/devices?device=${device.id}`} className="ml-auto text-[11px] text-brand hover:text-brand-bright">Open in LogicMonitor</Link>
          </>
        ) : <span className="text-[11px] text-ink-faint">Not monitored by LogicMonitor; switch ports below come from neighbour data.</span>}
      </div>

      {device && (device.vendor || device.model || device.version) ? (
        <p className="text-[11px] text-ink-muted mb-2">{[device.vendor, device.model, device.version].filter(Boolean).join(' ')}{device.collector ? ` - collector ${device.collector}` : ''}</p>
      ) : null}

      {alerts.length > 0 && (
        <div className="mb-2">
          {alerts.slice(0, 5).map((a, k) => (
            <p key={`${a.datasource}-${a.instanceName}-${k}`} className="text-[11px] text-ink-muted tnum">
              <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>{' '}
              {[a.datasource, a.instanceName, a.dataPointName].filter(Boolean).join(' / ')} = {a.alertValue ?? '-'}
              <span className="text-ink-faint"> since {fmtWhen(a.startedAt)}</span>
            </p>
          ))}
          {alerts.length > 5 && (
            <Link to={`/logicmonitor/alerts?deviceId=${device.id}`} className="text-[11px] text-brand hover:text-brand-bright">
              and {alerts.length - 5} more
            </Link>
          )}
        </div>
      )}

      {metrics.length > 0 && <ViaLogicMonitor metrics={metrics} />}

      {ports.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Switch ports</p>
          {ports.slice(0, 6).map((p, k) => (
            <p key={`${p.deviceId}-${p.port}-${k}`} className="text-[11px] text-ink-muted tnum">
              <span className="text-ink">{p.deviceName || '?'}</span> <span className="font-mono">{p.port || '?'}</span>{' '}
              <Badge tone={statusTextTone(p.statusText)}>{p.statusText || 'unknown'}</Badge>
              {p.inUtilPct != null || p.outUtilPct != null ? <span className="text-ink-faint"> in {p.inUtilPct ?? '-'}% out {p.outUtilPct ?? '-'}%</span> : null}
              {p.nic ? <span className="text-ink-faint"> ({p.nic})</span> : null}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
