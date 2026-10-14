// Governance Inventory group: Model Review (every network device with its
// model, code level and port counts) and Switch Ports to Endpoints. Both read
// the single GET /logicmonitor/governance payload and export through
// /governance.csv?section=modelReview|endpoints.
import { useMemo } from 'react';
import { ListTree, Waypoints } from 'lucide-react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { fmtNum, hostStatusTone, hostStatusLabel, titleCase, platformLabel } from './helpers';
import { SectionPanel, headRow } from './ui';
import { ExportBtn } from './governanceSections';
import EndpointsTable from './endpointsTable';

const arr = (v) => (Array.isArray(v) ? v : []);

export function ModelReviewSection({ rows, rollups, onDevice }) {
  const list = useMemo(() => arr(rows).map((r) => ({
    ...r,
    groupsText: arr(r.groups).join(', '),
    ifUpNum: r.ifUp == null ? null : Number(r.ifUp),
    behindNum: r.behind ? 1 : 0,
  })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['displayName', 'name', 'vendor', 'model', 'version', 'role', 'serial', 'collectorName', 'groupsText', 'sourceName'],
    defaultSortKey: 'displayName', paginate: true,
  });
  const f = ctl.filters;
  const behindCount = list.filter((r) => r.behind).length;
  const anyFilter = Object.values(f).some((v) => v);
  const clearAll = () => ['vendor', 'role', 'model'].forEach((k) => ctl.setFilter(k, ''));

  return (
    <SectionPanel icon={ListTree} title="Model Review" right={<ExportBtn section="modelReview" />}
      blurb={`Every network device LogicMonitor monitors, with hostname, model, code level and port counts. Behind means not on the newest version seen for that vendor and model in this estate (${fmtNum(behindCount)} device(s)). Filter with the dropdowns beside the search box.`}>
      {list.length === 0 ? (
        <p className="text-sm py-4 text-center text-ink-muted">No network devices reported yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-2 mt-1">
            <TableSearch ctl={ctl} placeholder="Search hostname, model, serial, group..." />
            <FilterSelect ctl={ctl} k="vendor" rows={list} label="vendors" />
            <FilterSelect ctl={ctl} k="role" rows={list} label="roles" />
            <FilterSelect ctl={ctl} k="model" rows={list} label="models" />
            {anyFilter && <button type="button" onClick={clearAll} className="text-[11px] text-brand hover:underline cursor-pointer">Clear filters</button>}
            <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} of {fmtNum(list.length)} device(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}>
                <SortTh k="displayName" label="Hostname" ctl={ctl} />
                <SortTh k="name" label="Name / IP" ctl={ctl} />
                <SortTh k="vendor" label="Vendor" ctl={ctl} />
                <SortTh k="model" label="Model" ctl={ctl} />
                <SortTh k="version" label="Code level" ctl={ctl} />
                <SortTh k="role" label="Role" ctl={ctl} />
                <SortTh k="serial" label="Serial" ctl={ctl} />
                <SortTh k="collectorName" label="Collector" ctl={ctl} />
                <SortTh k="groupsText" label="Groups" ctl={ctl} />
                <SortTh k="hostStatus" label="Status" ctl={ctl} />
                <SortTh k="ifUpNum" label="Interfaces" ctl={ctl} align="right" />
                <SortTh k="uplinks" label="Uplinks" ctl={ctl} align="right" />
                <SortTh k="endpoints" label="Endpoints" ctl={ctl} align="right" />
                <SortTh k="behindNum" label="Position" ctl={ctl} />
              </tr></thead>
              <tbody>
                {ctl.pageRows.map((r, i) => (
                  <tr key={`${r.sourceId}-${r.id}-${i}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => r.id && onDevice(r.id, r.sourceId)}>
                    <td className="py-2 pr-3 text-[12px] text-ink">
                      <p className="truncate max-w-[200px]">{r.displayName || '-'}</p>
                      {r.sourceName && <p className="text-[10px] text-ink-faint truncate max-w-[200px]">{r.sourceName}</p>}
                    </td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted truncate max-w-[160px]">{r.name || '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted">{r.vendor || '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted">{r.model || '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted tnum">{r.version || '(not parsed)'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted">{r.role ? titleCase(r.role) : '-'}</td>
                    <td className="py-2 pr-3 text-ink-muted font-mono text-[11px]">{r.serial || '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted truncate max-w-[140px]">{r.collectorName || '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-ink-muted truncate max-w-[180px]" title={r.groupsText}>{r.groupsText || '-'}</td>
                    <td className="py-2 pr-3">{r.hostStatus ? <Badge tone={hostStatusTone(r.hostStatus)}>{hostStatusLabel(r.hostStatus)}</Badge> : '-'}</td>
                    <td className="py-2 pr-3 text-[12px] text-right tnum text-ink-muted">{`${fmtNum(r.ifUp)} / ${fmtNum(r.ifCount)}`}</td>
                    <td className="py-2 pr-3 text-[12px] text-right tnum text-ink-muted">{fmtNum(r.uplinks)}</td>
                    <td className="py-2 pr-3 text-[12px] text-right tnum text-ink-muted">{fmtNum(r.endpoints)}</td>
                    <td className="py-2 pr-3">{r.behind ? <Badge tone="warn">Behind</Badge> : <Badge tone="ok">Newest seen</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePager ctl={ctl} />
        </>
      )}
    </SectionPanel>
  );
}

export function EndpointsSection({ rows, summary, onDevice }) {
  const s = summary || {};
  const byPlatform = arr(s.byPlatform);
  const total = s.total ?? arr(rows).length;
  return (
    <SectionPanel icon={Waypoints} title="Switch Ports to Endpoints" right={<ExportBtn section="endpoints" />}
      blurb="Servers and appliances ICC can place on a switch port: vCenter CDP and LLDP hints from the physical NICs of each ESXi host, plus interface descriptions and neighbour data that name a host another ICC platform knows. The endpoint opens Server 360; the switch opens Device 360.">
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <Badge tone="neutral">{fmtNum(total)} endpoint(s)</Badge>
        {byPlatform.map((p) => <Badge key={p.platform || 'none'} tone="info">{platformLabel(p.platform)} {fmtNum(p.count)}</Badge>)}
        {s.unmatchedPorts ? <Badge tone="warn">{fmtNum(s.unmatchedPorts)} hint(s) with no matching interface</Badge> : null}
      </div>
      <EndpointsTable rows={rows} onDevice={onDevice} />
    </SectionPanel>
  );
}
