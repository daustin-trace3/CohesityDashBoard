import { Waypoints, X, Router, Activity } from '../icons.jsx';
import client from '../api.js';
import {
  useToast, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, portalOrInline,
  BRAND, fmtNum, fmtWhen, statusTone, scoreColor,
} from '../ui.jsx';

function ModalShell({ title, subtitle, icon: Icon, onClose, children }) {
  return portalOrInline(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative panel w-full max-w-3xl max-h-[85vh] flex flex-col" style={{ borderTop: `3px solid ${BRAND}` }}>
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
    </div>
  );
}

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '—'}</p>
  </div>
);

function FabricDetailModal({ id, onClose }) {
  const [detail, setDetail] = React.useState(null);
  const { toast } = useToast();
  const navigate = ReactRouterDOM.useNavigate();

  React.useEffect(() => {
    client.get(`/brocade/fabrics/${id}`)
      .then(({ data }) => setDetail(data))
      .catch(() => { setDetail(false); toast({ type: 'error', title: 'Failed to load fabric' }); });
  }, [id, toast]);

  if (detail === false) {
    return (
      <ModalShell title="Fabric" icon={Waypoints} onClose={onClose}>
        <p className="text-sm text-ink-muted py-6 text-center">Could not load fabric detail.</p>
      </ModalShell>
    );
  }
  if (!detail) {
    return (
      <ModalShell title="Loading…" icon={Waypoints} onClose={onClose}>
        <LoadingPanel label="Loading fabric…" height={160} />
      </ModalShell>
    );
  }

  const { fabric, switches = [], healthScore, zoneConfig } = detail;
  const contributors = healthScore?.contributors || [];

  return (
    <ModalShell title={fabric.name} subtitle={fabric.seedSwitchName || fabric.seedSwitchIp} icon={Waypoints} onClose={onClose}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={statusTone(fabric.statusLabel)}>{fabric.statusLabel || 'Unknown'}</Badge>
        {fabric.managed ? <Badge tone="info">Managed</Badge> : null}
        {healthScore?.score != null && (
          <span className="text-sm font-semibold tnum" style={{ color: scoreColor(healthScore.score) }}>Score {healthScore.score}</span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Switches" value={fabric.switchCount} />
        <Fact label="Principal WWN" value={fabric.principalSwitchWwn} />
        <Fact label="Seed IP" value={fabric.seedSwitchIp} />
        <Fact label="Virtual Fabric ID" value={fabric.virtualFabricId} />
        <Fact label="Active Zoneset" value={fabric.activeZonesetName} />
        <Fact label="Management State" value={fabric.managementState} />
        <Fact label="Last Changed" value={fmtWhen(fabric.lastFabricChanged)} />
        <Fact label="Zone Count" value={zoneConfig?.zoneCount} />
      </div>

      {contributors.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Activity size={13} className="text-brand" /> Health Contributors</p>
          <div className="flex flex-col gap-1">
            {contributors.map((c, i) => (
              <div key={i} className="flex items-center justify-between text-xs bg-surface-overlay rounded-lg px-3 py-1.5">
                <span className="text-ink">{c.contributorType}</span>
                <span className="text-ink-faint tnum">{c.score}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {zoneConfig && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-ink mb-2">Active Zone Config</p>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <Fact label="Config Name" value={zoneConfig.cfgName} />
            <Fact label="Default Access" value={zoneConfig.defaultZoneAccess === 1 ? 'All Access' : 'No Access'} />
            <Fact label="Checksum" value={zoneConfig.checksum} />
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-ink flex items-center gap-1.5"><Router size={13} className="text-brand" /> Member Switches ({switches.length})</p>
          <button onClick={() => navigate(`/brocade/switches?fabric=${encodeURIComponent(fabric.name)}`)} className="text-[11px] text-brand underline cursor-pointer">View in Switches →</button>
        </div>
        {switches.length === 0 ? (
          <p className="text-xs text-ink-muted py-1">No switches reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-1.5 pr-3">Name</th>
                <th className="py-1.5 pr-3">IP</th>
                <th className="py-1.5 pr-3">Role</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3">Firmware</th>
              </tr></thead>
              <tbody>
                {switches.map((s) => (
                  <tr key={s.wwn} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink">{s.name}</td>
                    <td className="py-1.5 pr-3 text-ink-muted tnum">{s.ip_address}</td>
                    <td className="py-1.5 pr-3 text-ink-faint">{s.role}</td>
                    <td className="py-1.5 pr-3"><Badge tone={statusTone(s.operational_status)}>{s.operational_status || s.status}</Badge></td>
                    <td className="py-1.5 pr-3 text-ink-faint tnum">{s.firmware_version}</td>
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

export default function BrocadeFabricsPage() {
  const { toast } = useToast();
  const [rows, setRows] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailId, setDetailId] = React.useState(null);
  const navigate = ReactRouterDOM.useNavigate();

  const load = React.useCallback(() => client.get('/brocade/fabrics')
    .then(({ data }) => { setRows(data.fabrics || []); setLastRefreshed(new Date()); })
    .catch(() => { setRows([]); toast({ type: 'error', title: 'Failed to load fabrics' }); }), [toast]);

  React.useEffect(() => { load(); }, [load]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'sourceName', 'principalSwitchWwn'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: false,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Waypoints} title="Fabrics" description="Brocade fabrics discovered across SANnav sources">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by name, source or WWN…"
          filters={[{ k: 'statusLabel', label: 'Statuses' }, { k: 'sourceName', label: 'Sources' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading fabrics…" height={160} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No fabrics found.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No fabrics match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="Name" ctl={ctl} />
                <SortTh k="sourceName" label="Source" ctl={ctl} />
                <SortTh k="statusLabel" label="Status" ctl={ctl} />
                <SortTh k="score" label="Score" ctl={ctl} align="right" />
                <SortTh k="switchCount" label="Switches" ctl={ctl} align="right" />
                <SortTh k="activeZonesetName" label="Active Zoneset" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.rows.map((f) => (
                  <tr key={f.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setDetailId(f.id)} className="text-brand hover:underline cursor-pointer text-left">{f.name}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{f.sourceName}</td>
                    <td className="py-2 pr-3"><Badge tone={statusTone(f.statusLabel)}>{f.statusLabel || 'Unknown'}</Badge></td>
                    <td className="py-2 pr-3 text-right tnum font-semibold" style={{ color: scoreColor(f.score) }}>{f.score ?? '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">
                      <button onClick={() => navigate(`/brocade/switches?fabric=${encodeURIComponent(f.name)}`)} className="text-brand hover:underline cursor-pointer">{fmtNum(f.switchCount)}</button>
                    </td>
                    <td className="py-2 pr-3 text-ink-faint">{f.activeZonesetName || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailId != null && <FabricDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
