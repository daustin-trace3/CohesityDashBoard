import { HardDrive, X, Network } from '../icons.jsx';
import client from '../api.js';
import {
  useToast, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated,
  useTableControls, SortTh, TableControls, TablePager, portalOrInline,
  BRAND, fmtNum, statusTone, parseJsonArr,
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

function EnclosureDetailModal({ enclosure, devicePorts, onClose }) {
  const rows = devicePorts.filter((p) => p.enclosureGuid === enclosure.guid || p.enclosureName === enclosure.name);
  return (
    <ModalShell title={enclosure.name} subtitle={[enclosure.type, enclosure.hostName, enclosure.ipAddress].filter(Boolean).join(' · ')} icon={HardDrive} onClose={onClose}>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={statusTone(enclosure.health)}>{enclosure.health || 'Unknown'}</Badge>
        {enclosure.type && <Badge tone="neutral">{enclosure.type}</Badge>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Vendor" value={enclosure.vendor} />
        <Fact label="Model" value={enclosure.model} />
        <Fact label="Location" value={enclosure.location} />
        <Fact label="Contact" value={enclosure.contact} />
      </div>
      <div>
        <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><Network size={13} className="text-brand" /> Device Ports ({rows.length})</p>
        {rows.length === 0 ? (
          <p className="text-xs text-ink-muted py-1">No device ports reported.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-1.5 pr-3">WWN</th>
                <th className="py-1.5 pr-3">Role</th>
                <th className="py-1.5 pr-3">Switch Port</th>
                <th className="py-1.5 pr-3">Zones</th>
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.wwn} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink tnum">{p.wwn}</td>
                    <td className="py-1.5 pr-3 text-ink-faint">{p.portRole || '—'}</td>
                    <td className="py-1.5 pr-3 text-ink-muted">{p.switchName ? `${p.switchName} · ${p.switchPortName}` : '—'}</td>
                    <td className="py-1.5 pr-3 text-ink-faint">{parseJsonArr(p.activeZones).length || p.activeZoneCount || 0}</td>
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

const TABS = [{ key: 'enclosures', label: 'Enclosures' }, { key: 'devicePorts', label: 'Device Ports' }];

export default function BrocadeDevicesPage() {
  const { toast } = useToast();
  const [searchParams] = ReactRouterDOM.useSearchParams();
  const [tab, setTab] = React.useState('enclosures');
  const [enclosures, setEnclosures] = React.useState(null);
  const [devicePorts, setDevicePorts] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [detailEnclosure, setDetailEnclosure] = React.useState(null);
  const searchQ = searchParams.get('search') || '';

  const load = React.useCallback(() => Promise.all([
    client.get('/brocade/enclosures').then(({ data }) => setEnclosures(data.enclosures || [])).catch(() => setEnclosures([])),
    client.get('/brocade/device-ports').then(({ data }) => setDevicePorts(data.devicePorts || [])).catch(() => setDevicePorts([])),
  ]).then(() => setLastRefreshed(new Date())).catch(() => toast({ type: 'error', title: 'Failed to load devices' })), [toast]);

  React.useEffect(() => { load(); }, [load]);

  const enclosureList = enclosures || [];
  const enclosureCtl = useTableControls(enclosureList, {
    searchKeys: ['name', 'hostName', 'ipAddress', 'vendor', 'model'],
    defaultSortKey: 'name', defaultSortDir: 'asc',
    paginate: true,
  });
  const portList = devicePorts || [];
  const portCtl = useTableControls(portList, {
    searchKeys: ['wwn', 'symbolicName', 'vendor', 'switchName', 'fabricName', 'enclosureName', 'fdmiHostName'],
    defaultSortKey: 'switchName', defaultSortDir: 'asc',
    paginate: true, defaultPageSize: 50,
  });

  React.useEffect(() => {
    if (searchQ) enclosureCtl.setQ(searchQ);
  }, [searchQ]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="animate-fade-in">
      <PageHeader icon={HardDrive} title="Devices & Enclosures" description="Hosts and storage arrays connected to Brocade fabrics">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="flex items-center gap-1 mb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${tab === t.key ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'enclosures' && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <TableControls ctl={enclosureCtl} rows={enclosureList} searchPlaceholder="Filter by name, host, IP, vendor or model…"
            filters={[{ k: 'type', label: 'Types' }, { k: 'vendor', label: 'Vendors' }]} />
          {enclosures == null ? (
            <LoadingPanel label="Loading enclosures…" height={160} />
          ) : enclosureList.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No enclosures found.</div>
          ) : enclosureCtl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No enclosures match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="name" label="Name" ctl={enclosureCtl} />
                  <SortTh k="type" label="Type" ctl={enclosureCtl} />
                  <SortTh k="hostName" label="Host Name" ctl={enclosureCtl} />
                  <SortTh k="ipAddress" label="IP" ctl={enclosureCtl} />
                  <SortTh k="vendor" label="Vendor" ctl={enclosureCtl} />
                  <SortTh k="model" label="Model" ctl={enclosureCtl} />
                  <SortTh k="health" label="Health" ctl={enclosureCtl} />
                  <SortTh k="portCount" label="Ports" ctl={enclosureCtl} align="right" />
                </tr></thead>
                <tbody>
                  {enclosureCtl.pageRows.map((e) => (
                    <tr key={e.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3">
                        <button onClick={() => setDetailEnclosure(e)} className="text-brand hover:underline cursor-pointer text-left">{e.name}</button>
                      </td>
                      <td className="py-2 pr-3 text-ink-faint">{e.type || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted">{e.hostName || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted tnum">{e.ipAddress || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint">{e.vendor || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint">{e.model || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone={statusTone(e.health)}>{e.health || 'Unknown'}</Badge></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(e.portCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={enclosureCtl} />
        </div>
      )}

      {tab === 'devicePorts' && (
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <TableControls ctl={portCtl} rows={portList} searchPlaceholder="Filter by WWN, symbolic name, switch or enclosure…"
            filters={[{ k: 'portRole', label: 'Roles' }, { k: 'fabricName', label: 'Fabrics' }]} />
          {devicePorts == null ? (
            <LoadingPanel label="Loading device ports…" height={200} />
          ) : portList.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No device ports found.</div>
          ) : portCtl.rows.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No device ports match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <SortTh k="wwn" label="WWN" ctl={portCtl} />
                  <SortTh k="portRole" label="Role" ctl={portCtl} />
                  <SortTh k="switchName" label="Switch Port" ctl={portCtl} />
                  <SortTh k="enclosureName" label="Enclosure" ctl={portCtl} />
                  <SortTh k="fdmiHostName" label="FDMI Host" ctl={portCtl} />
                  <SortTh k="zoneAlias" label="Zones" ctl={portCtl} />
                </tr></thead>
                <tbody>
                  {portCtl.pageRows.map((p) => (
                    <tr key={p.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink tnum">{p.wwn}</td>
                      <td className="py-2 pr-3"><Badge tone={p.portRole === 'initiator' ? 'info' : 'neutral'}>{p.portRole || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted">{p.switchName ? `${p.switchName} · ${p.switchPortName}` : '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint">{p.enclosureName || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint">{p.fdmiHostName || '—'}</td>
                      <td className="py-2 pr-3 text-ink-faint">{p.zoneAlias || '—'}{p.activeZoneCount ? ` (${fmtNum(p.activeZoneCount)})` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <TablePager ctl={portCtl} />
        </div>
      )}

      {detailEnclosure && <EnclosureDetailModal enclosure={detailEnclosure} devicePorts={portList} onClose={() => setDetailEnclosure(null)} />}
    </div>
  );
}
