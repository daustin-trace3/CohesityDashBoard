import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Router, X, Cable, ShieldCheck } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtMs, statusTone } from './helpers';

// management_state bit decoding — per contract §2 (used both for issues and
// the switch 360 modal's decoded labels).
const MGMT_BITS = [
  { bit: 1, label: 'Credentials invalid' },
  { bit: 2, label: 'Firmware unsupported' },
  { bit: 4, label: 'License expired' },
  { bit: 8, label: 'Certificate error' },
  { bit: 16, label: 'Unreachable' },
];

function decodeManagementState(v) {
  const n = Number(v) || 0;
  return MGMT_BITS.filter((b) => (n & b.bit) === b.bit).map((b) => b.label);
}

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-4xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '—'}</p>
  </div>
);

function SwitchDetailModal({ id, onClose }) {
  const [detail, setDetail] = useState(null);
  const { toast } = useToast();

  useEffect(() => {
    client.get(`/brocade/switches/${id}`)
      .then(({ data }) => setDetail(data))
      .catch(() => { setDetail(false); toast({ type: 'error', title: 'Failed to load switch' }); });
  }, [id, toast]);

  if (detail === false) {
    return (
      <ModalShell title="Switch" icon={Router} onClose={onClose}>
        <p className="text-sm text-ink-muted py-6 text-center">Could not load switch detail.</p>
      </ModalShell>
    );
  }
  if (!detail) {
    return (
      <ModalShell title="Loading…" icon={Router} onClose={onClose}>
        <LoadingPanel label="Loading switch…" height={160} />
      </ModalShell>
    );
  }

  const { switch: sw, ports = [], healthScore, chassis } = detail;
  const mgmtLabels = sw.managementStateLabels || decodeManagementState(sw.managementState);

  return (
    <ModalShell title={sw.name} subtitle={[sw.ipAddress, sw.model, sw.fabricName].filter(Boolean).join(' · ')} icon={Router} onClose={onClose}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={statusTone(sw.operationalStatus)}>{sw.operationalStatus || sw.status}</Badge>
        <Badge tone={statusTone(sw.health)}>{sw.health || 'Unknown'}</Badge>
        {sw.maintenanceMode ? <Badge tone="info">Maintenance mode</Badge> : null}
        {sw.eosStatus ? <Badge tone="warn">EOS</Badge> : null}
        {healthScore?.score != null && <span className="text-sm font-semibold text-ink tnum">Score {healthScore.score}</span>}
      </div>

      {sw.statusReason && (
        <p className="text-xs text-status-warn mb-3">{sw.statusReason}</p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Role" value={sw.role} />
        <Fact label="Domain ID" value={sw.domainId} />
        <Fact label="Firmware" value={sw.firmwareVersion} />
        <Fact label="Serial" value={sw.serialNumber} />
        <Fact label="WWN" value={sw.wwn} />
        <Fact label="Port Count" value={sw.portCount} />
        <Fact label="Max Port" value={sw.maxPort} />
        <Fact label="Cert Expiry" value={fmtMs(sw.tlsCertExpiryMs)} />
      </div>

      {mgmtLabels.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><ShieldCheck size={13} className="text-brand" /> Management State</p>
          <div className="flex flex-wrap gap-1.5">
            {mgmtLabels.map((l) => <Badge key={l} tone="warn">{l}</Badge>)}
          </div>
        </div>
      )}

      {chassis && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-ink mb-2">Chassis</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Fact label="Model" value={chassis.model_number} />
            <Fact label="Part Number" value={chassis.part_number} />
            <Fact label="Max Port" value={chassis.max_port} />
            <Fact label="Virtual Switches" value={chassis.num_virtual_switches} />
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Cable size={13} className="text-brand" /> Ports ({ports.length})</p>
        {ports.length === 0 ? (
          <p className="text-xs text-ink-muted py-1">No ports reported.</p>
        ) : (
          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-cohesity-gray"><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-1.5 pr-3">Port</th>
                <th className="py-1.5 pr-3">Type</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3">Speed</th>
                <th className="py-1.5 pr-3">Remote Device</th>
              </tr></thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={p.wwn} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink-muted">{p.name || p.port_id}</td>
                    <td className="py-1.5 pr-3 text-ink-faint">{p.type}</td>
                    <td className="py-1.5 pr-3"><Badge tone={statusTone(p.status)}>{p.status}</Badge></td>
                    <td className="py-1.5 pr-3 text-ink-muted tnum">{p.speed || '—'}</td>
                    <td className="py-1.5 pr-3 text-ink-faint">{p.remote_device || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

export default function BrocadeSwitchesPage() {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const fabricParam = searchParams.get('fabric') || '';

  const load = useCallback(() => client.get('/brocade/switches', { params: fabricParam ? { fabric: fabricParam } : {} })
    .then(({ data }) => { setRows(data.switches || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load switches' }); }), [toast, fabricParam]);

  useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'ipAddress', 'wwn', 'model', 'fabricName', 'sourceName'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Router} title="Switches" description={fabricParam ? `Brocade switches — fabric ${fabricParam}` : 'Brocade switches across all fabrics'}>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, IP, WWN, model or fabric…"
          filters={[{ k: 'fabricName', label: 'Fabrics' }, { k: 'operationalStatus', label: 'Statuses' }, { k: 'role', label: 'Roles' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading switches…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No switches found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No switches match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="fabricName" label="Fabric" ctl={ctl} />
                <SortTh k="ipAddress" label="IP" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="role" label="Role" ctl={ctl} />
                <SortTh k="operationalStatus" label="Status" ctl={ctl} />
                <SortTh k="firmwareVersion" label="Firmware" ctl={ctl} />
                <SortTh k="portCount" label="Ports" ctl={ctl} align="right" />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((s) => (
                  <tr key={s.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailId(s.id)} className="text-brand hover:underline cursor-pointer text-left">{s.name}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{s.fabricName || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted tnum">{s.ipAddress || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-faint">{s.role || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(s.operationalStatus)}>{s.operationalStatus || s.status || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-faint text-[11px] tnum">{s.firmwareVersion || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(s.portCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {detailId != null && <SwitchDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
