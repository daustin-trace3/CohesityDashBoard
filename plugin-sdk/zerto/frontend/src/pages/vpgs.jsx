// Zerto VPGs — ported from frontend/src/pages/zerto/ZertoVpgsPage.jsx. The
// original's raw fixed-overlay modal is replaced with ui.jsx's Modal
// primitive (portalOrInline-guarded — window.ReactDOM has no createPortal).
import { ShieldCheck, MonitorSmartphone } from '../icons.jsx';
import {
  apiFetch, PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated, Modal, BRAND,
  useTableControls, SortTh, TableControls, TablePager, fmtNum, fmtMb, fmtRpo, healthTone, parseJsonList,
} from '../ui.jsx';

export default function ZertoVpgsPage() {
  const [rows, setRows] = React.useState(null);
  const [vms, setVms] = React.useState(null);
  const [modalVpg, setModalVpg] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/zerto/vpgs')
    .then((json) => { setRows(json); setLastRefreshed(new Date()); })
    .catch(() => setRows([])), []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    apiFetch('/zerto/vms').then((json) => setVms(json)).catch(() => setVms([]));
  }, []);

  const modalVms = React.useMemo(() => {
    if (!modalVpg || !vms) return null;
    return vms.filter((vm) => parseJsonList(vm.vpg_names).includes(modalVpg.name));
  }, [modalVpg, vms]);

  const list = rows || [];
  const ctl = useTableControls(list, {
    searchKeys: ['name', 'protected_site', 'recovery_site', 'zorg_name', 'status'],
    defaultSortKey: 'actual_rpo', defaultSortDir: 'desc',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Zerto VPGs" description="Virtual Protection Groups with RPO, health and journal state">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by VPG, site, ZORG or status…"
          filters={[{ k: 'protected_site', label: 'Protected sites' }, { k: 'recovery_site', label: 'Recovery sites' }, { k: 'health', label: 'Health' }, { k: 'status', label: 'Statuses' }]} />
        {rows == null ? (
          <LoadingPanel label="Loading VPGs…" height={140} />
        ) : list.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPGs found — check the Zerto credentials under Settings.</div>
        ) : ctl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No VPGs match your filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="name" label="VPG" ctl={ctl} />
                <SortTh k="protected_site" label="Protected Site" ctl={ctl} />
                <SortTh k="recovery_site" label="Recovery Site" ctl={ctl} />
                <SortTh k="vms_count" label="VMs" ctl={ctl} align="right" />
                <SortTh k="health" label="Health" ctl={ctl} />
                <SortTh k="status" label="Status" ctl={ctl} />
                <SortTh k="actual_rpo" label="Actual RPO" ctl={ctl} align="right" />
                <SortTh k="configured_rpo" label="SLA RPO" ctl={ctl} align="right" />
                <SortTh k="actual_journal_history" label="Journal" ctl={ctl} align="right" />
                <SortTh k="zorg_name" label="ZORG" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((v) => (
                  <tr key={v.vpg_identifier} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3">
                      <button onClick={() => setModalVpg(v)}
                        className="text-ink hover:text-brand underline decoration-dotted underline-offset-2 transition-colors cursor-pointer text-left"
                        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit' }}>
                        {v.name || '—'}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-ink-muted">{v.protected_site || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.recovery_site || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.vms_count)}</td>
                    <td className="py-2 pr-3"><Badge tone={healthTone(v.health)}>{v.health || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{v.status || '—'}{v.sub_status && v.sub_status !== 'None' ? ` · ${v.sub_status}` : ''}</td>
                    <td className={`py-2 pr-3 text-right tnum ${v.configured_rpo && v.actual_rpo > v.configured_rpo ? 'text-status-crit font-semibold' : 'text-ink'}`}>{fmtRpo(v.actual_rpo)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{fmtRpo(v.configured_rpo)}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{v.actual_journal_history != null ? `${v.actual_journal_history}h` : '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{v.zorg_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ctl} />
      </div>

      {modalVpg && (
        <Modal
          title={`VMs in ${modalVpg.name}`}
          subtitle={`${modalVpg.protected_site || '—'} → ${modalVpg.recovery_site || '—'} · ${fmtNum(modalVpg.vms_count)} VM${modalVpg.vms_count === 1 ? '' : 's'}`}
          icon={MonitorSmartphone}
          onClose={() => setModalVpg(null)}
        >
          {modalVms == null ? (
            <LoadingPanel label="Loading VMs…" height={100} />
          ) : modalVms.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">
              No VM details available for this VPG{modalVpg.vms_count ? ` (the group reports ${modalVpg.vms_count} VM${modalVpg.vms_count === 1 ? '' : 's'}, but they haven't appeared in the protected-VMs feed yet)` : ''}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">VM</th>
                  <th className="py-2 pr-3 text-right">Provisioned</th>
                  <th className="py-2 pr-3 text-right">Used</th>
                  <th className="py-2 pr-3">ZORG</th>
                </tr></thead>
                <tbody>
                  {modalVms.map((vm) => (
                    <tr key={vm.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3 text-ink">{vm.name || '—'}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMb(vm.provisioned_storage_mb)}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMb(vm.used_storage_mb)}</td>
                      <td className="py-2 pr-3 text-ink-muted">{vm.zorg_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
