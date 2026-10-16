import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, CheckCircle2, XCircle, ArrowDownCircle } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtDuration, hostStatusTone, hostStatusLabel } from './helpers';
import { Modal, Fact, headRow } from './ui';

function collectorState(c) {
  if (c.isDown && c.inSdt) return { tone: 'neutral', label: 'Down (SDT)' };
  if (c.isDown) return { tone: 'crit', label: 'Down' };
  return { tone: 'ok', label: 'Up' };
}

function CollectorModal({ c, onClose }) {
  const navigate = useNavigate();
  const st = collectorState(c);
  const devices = c.devices || [];
  return (
    <Modal icon={Cpu} title={c.hostname || `Collector ${c.id}`} subtitle={c.description} onClose={onClose} width="max-w-3xl">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={st.tone}>{st.label}</Badge>
        {c.acked ? <Badge tone="info">Acked</Badge> : null}
        {c.behind ? <Badge tone="warn">Build behind {c.mgd || 'MGD'}</Badge> : null}
        {c.ea ? <Badge tone="neutral">Early access</Badge> : null}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Group">{c.groupName}</Fact>
        <Fact label="Platform">{[c.platform, c.arch].filter(Boolean).join(' ') || '-'}</Fact>
        <Fact label="Build">{c.build}</Fact>
        <Fact label="Current MGD">{c.mgd}</Fact>
        <Fact label="Devices">{fmtNum(c.numberOfHosts)}</Fact>
        <Fact label="Instances">{fmtNum(c.numberOfInstances)}</Fact>
        <Fact label="Uptime">{fmtDuration(c.uptimeSeconds)}</Fact>
        <Fact label="Collector id">{c.id}</Fact>
      </div>
      <p className="text-xs font-semibold text-ink mb-2">Devices on this collector{devices.length >= 50 ? ' (first 50)' : ''}</p>
      {devices.length === 0 ? <p className="text-sm text-ink-muted py-3 text-center">No devices assigned.</p> : (
        <table className="w-full text-sm">
          <thead><tr className={headRow}><th className="py-1.5 pr-3">Device</th><th className="py-1.5 pr-3">Status</th></tr></thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-b border-cohesity-border/40 cursor-pointer hover:bg-surface-overlay" onClick={() => navigate(`/logicmonitor/devices?device=${d.id}`)}>
                <td className="py-1.5 pr-3 text-ink">{d.displayName}</td>
                <td className="py-1.5 pr-3"><Badge tone={hostStatusTone(d.hostStatus)}>{hostStatusLabel(d.hostStatus)}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.numberOfHosts > devices.length && (
        <button onClick={() => navigate(`/logicmonitor/devices?collectorId=${c.id}`)} className="text-xs text-brand hover:underline cursor-pointer mt-3">
          All {fmtNum(c.numberOfHosts)} devices on the Devices page
        </button>
      )}
    </Modal>
  );
}

// Mounted as Settings > Connections > Collectors (embedded) since 2026-10-16; the
// /logicmonitor/collectors route redirects there.
export default function LmCollectorsPage({ embedded = false } = {}) {
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/collectors')
    .then(({ data }) => { setRows(Array.isArray(data) ? data : []); setLastRefreshed(new Date()); })
    .catch(() => { setRows((r) => r || []); toast({ type: 'error', title: 'Failed to load collectors' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => (rows || []).map((c) => ({ ...c, stateLabel: collectorState(c).label })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['hostname', 'description', 'groupName', 'build'], defaultSortKey: 'hostname', paginate: true,
  });

  const down = list.filter((c) => c.isDown && !c.inSdt).length;
  const behind = list.filter((c) => c.behind).length;
  const mgd = list.find((c) => c.mgd)?.mgd;

  const csv = [
    { label: 'Hostname', get: 'hostname' }, { label: 'Description', get: 'description' }, { label: 'Group', get: 'groupName' },
    { label: 'Platform', get: 'platform' }, { label: 'Arch', get: 'arch' }, { label: 'Build', get: 'build' },
    { label: 'Behind MGD', get: (r) => (r.behind ? 'yes' : 'no') }, { label: 'State', get: 'stateLabel' },
    { label: 'Devices', get: 'numberOfHosts' }, { label: 'Instances', get: 'numberOfInstances' }, { label: 'Uptime seconds', get: 'uptimeSeconds' },
  ];

  return (
    <div className="animate-fade-in">
      {embedded ? (
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold">Collectors</h2>
            <p className="text-xs text-muted">LogicMonitor collectors, their build against the current mandatory release, and the devices they carry</p>
          </div>
          <div className="flex items-center gap-3">
            <LastUpdated date={lastRefreshed} prefix="Updated" />
            <RefreshButton onClick={load} />
          </div>
        </div>
      ) : (
        <PageHeader icon={Cpu} title="Collectors" description="LogicMonitor collectors, their build against the current mandatory release, and the devices they carry">
          <LastUpdated date={lastRefreshed} prefix="Updated" />
          <RefreshButton onClick={load} />
        </PageHeader>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Cpu} label="Collectors" value={fmtNum(list.length)} loading={rows == null} />
        <StatCard icon={CheckCircle2} label="Up" value={fmtNum(list.length - down)} tone="ok" loading={rows == null} />
        <StatCard icon={XCircle} label="Down" value={fmtNum(down)} tone={down ? 'crit' : 'ok'} loading={rows == null} />
        <StatCard icon={ArrowDownCircle} label="Behind MGD" value={fmtNum(behind)} sub={mgd ? `current ${mgd}` : undefined} tone={behind ? 'warn' : 'ok'} loading={rows == null} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        {rows == null ? <LoadingPanel label="Loading collectors..." height={160} /> : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No collectors reported.</div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <div className="flex-1"><TableControls ctl={ctl} rows={list} searchPlaceholder="Search collectors..."
                filters={[{ k: 'groupName', label: 'groups' }, { k: 'stateLabel', label: 'states' }, { k: 'platform', label: 'platforms' }]} /></div>
              <CsvExportButton filename="logicmonitor-collectors" rows={ctl.rows} columns={csv} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="hostname" label="Hostname" ctl={ctl} />
                  <SortTh k="groupName" label="Group" ctl={ctl} />
                  <SortTh k="platform" label="Platform" ctl={ctl} />
                  <SortTh k="build" label="Build" ctl={ctl} />
                  <SortTh k="stateLabel" label="Status" ctl={ctl} />
                  <SortTh k="numberOfHosts" label="Devices" ctl={ctl} align="right" />
                  <SortTh k="numberOfInstances" label="Instances" ctl={ctl} align="right" />
                  <SortTh k="uptimeSeconds" label="Uptime" ctl={ctl} align="right" />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((c) => {
                    const st = collectorState(c);
                    return (
                      <tr key={`${c.sourceId}-${c.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(c)}>
                        <td className="py-2 pr-3"><p className="text-ink">{c.hostname}</p><p className="text-[10px] text-ink-faint truncate max-w-[240px]">{c.description}</p></td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{c.groupName || '-'}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{[c.platform, c.arch].filter(Boolean).join(' ') || '-'}</td>
                        <td className="py-2 pr-3 tnum text-ink-muted">{c.build || '-'}{c.behind ? <Badge tone="warn" className="ml-1">Behind</Badge> : null}</td>
                        <td className="py-2 pr-3"><Badge tone={st.tone}>{st.label}</Badge>{c.acked ? <Badge tone="info" className="ml-1">Acked</Badge> : null}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(c.numberOfHosts)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(c.numberOfInstances)}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtDuration(c.uptimeSeconds)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {open && <CollectorModal c={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
