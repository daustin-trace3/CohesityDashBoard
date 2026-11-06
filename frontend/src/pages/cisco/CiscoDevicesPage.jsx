import { useMemo, useState } from 'react';
import { Server } from 'lucide-react';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import {
  useTableControls, SortTh, TableSearch, FilterSelect, TablePager, CsvExportButton,
} from '../../components/ui/tableTools';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { headRow } from '../logicmonitor/ui';
import { StateDot, stateWord, stateRankOf } from '../logicmonitor/groupTree';
import LmDevice360 from '../logicmonitor/LmDevice360';
import { BRAND, API, OLDER_VERSION, kindLabel, familyLabel, rowsOf, useCiscoGet } from './ciscoShared';

const CSV_COLUMNS = [
  { label: 'Device', get: 'name' },
  { label: 'Family', get: 'familyText' },
  { label: 'Kind', get: 'kindText' },
  { label: 'State', get: 'stateText' },
  { label: 'Why', get: 'reasonText' },
  { label: 'Site', get: 'siteLabel' },
  { label: 'Model', get: 'model' },
  { label: 'Version', get: 'version' },
  { label: 'Open alerts', get: 'openAlerts' },
  { label: 'Portal', get: 'sourceName' },
];

export default function CiscoDevicesPage() {
  const { data, error, loading, reload, loadedAt } = useCiscoGet(`${API}/devices`, 'Cisco devices');
  const [open, setOpen] = useState(null);

  const raw = rowsOf(data);
  const rows = useMemo(() => (raw || []).map((r) => ({
    ...r,
    name: r.displayName || r.name || '',
    familyText: familyLabel(r.vendorKey),
    kindText: kindLabel(r.vendorKind),
    stateText: stateWord(r.state),
    stateRank: stateRankOf(r.state),
    reasonText: Array.isArray(r.reasons) ? r.reasons.join('; ') : (r.reasons || ''),
    siteLabel: r.siteName || r.siteKey || '',
  })), [raw]);

  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'familyText', 'kindText', 'siteLabel', 'model', 'version', 'reasonText'], defaultSortKey: 'stateRank', defaultSortDir: 'desc', paginate: true,
  });
  const shapeBad = !loading && !error && raw == null;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Server} title="Cisco Devices" description="Every device LogicMonitor monitors that ICC classified as Cisco or Meraki, with family, kind, state and the reason for it">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <TableSearch ctl={ctl} placeholder="Search device, site, model or reason..." />
          <FilterSelect ctl={ctl} k="familyText" rows={rows} label="families" />
          <FilterSelect ctl={ctl} k="kindText" rows={rows} label="kinds" />
          <FilterSelect ctl={ctl} k="stateText" rows={rows} label="states" />
          <FilterSelect ctl={ctl} k="siteLabel" rows={rows} label="sites" />
          <span className="text-[11px] text-ink-faint tnum">{fmtNum(ctl.rows.length)} device(s)</span>
          <span className="ml-auto"><CsvExportButton filename="cisco-devices" columns={CSV_COLUMNS} rows={ctl.rows} /></span>
        </div>

        {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
        {shapeBad && <p className="text-sm text-status-warn mb-3">{OLDER_VERSION}</p>}

        {loading ? <LoadingPanel label="Loading Cisco devices..." height={200} /> : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">
            {error || shapeBad ? '' : 'No Cisco or Meraki devices yet. They appear once the LogicMonitor inventory tick classifies a device as Cisco or Meraki.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <SortTh k="name" label="Device" ctl={ctl} />
                  <SortTh k="familyText" label="Family" ctl={ctl} />
                  <SortTh k="kindText" label="Kind" ctl={ctl} />
                  <SortTh k="stateRank" label="State" ctl={ctl} />
                  <SortTh k="reasonText" label="Why" ctl={ctl} />
                  <SortTh k="siteLabel" label="Site" ctl={ctl} />
                  <SortTh k="model" label="Model" ctl={ctl} />
                  <SortTh k="version" label="Version" ctl={ctl} />
                  <SortTh k="openAlerts" label="Open alerts" ctl={ctl} align="right" />
                </tr></thead>
                <tbody>
                  {ctl.pageRows.map((r) => (
                    <tr key={`${r.sourceId}-${r.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setOpen(r)}>
                      <td className="py-2 pr-3 text-ink text-[12px]">{r.name}</td>
                      <td className="py-2 pr-3"><Badge tone={r.vendorKey === 'meraki' ? 'info' : 'neutral'}>{r.familyText}</Badge></td>
                      <td className="py-2 pr-3"><Badge tone="neutral">{r.kindText}</Badge></td>
                      <td className="py-2 pr-3 text-[12px]">
                        <span className="inline-flex items-center gap-2"><StateDot state={r.state} />{r.stateText}</span>
                      </td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] max-w-[320px] truncate" title={r.reasonText}>{r.reasonText || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.siteLabel || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.model || DASH}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.version || DASH}</td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.openAlerts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TablePager ctl={ctl} />
          </>
        )}
      </div>

      {open && (
        <LmDevice360 deviceId={open.id} sourceId={open.sourceId} onClose={() => setOpen(null)}
          onSwitchDevice={(id) => setOpen((cur) => ({ ...cur, id }))} />
      )}
    </div>
  );
}
