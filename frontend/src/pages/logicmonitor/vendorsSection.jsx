// LogicMonitor Governance: "Vendors in this portal". One row per vendor ICC
// classified from the stored devices (sysoid enterprise number first, then name
// hints, then DataSource names), with where that vendor's data is shown. Fed by
// GET /logicmonitor/governance/vendors. Vendors with their own derived platform
// link to it; the rest say what LogicMonitor shows for them.
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { fmtNum, fmtWhen, arr } from './helpers';
import { SectionPanel, headRow } from './ui';

const kindText = (kinds) => Object.entries(kinds && typeof kinds === 'object' ? kinds : {})
  .filter(([, n]) => n)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k} ${fmtNum(n)}`)
  .join(', ');

const reasonText = (reasons) => Object.entries(reasons && typeof reasons === 'object' ? reasons : {})
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k} (${fmtNum(n)})`)
  .join(', ');

function errorText(e) {
  const status = e?.response?.status;
  const text = e?.response?.data?.error || e?.response?.data?.message || e?.message || '';
  return `Failed to load the vendor census${status ? ` (HTTP ${status})` : ''}${text ? `: ${text}` : ''}`;
}

function WhereCell({ row }) {
  if (row.platform && row.platform !== 'logicmonitor') {
    return <Link to={`/${row.platform}`} className="text-brand hover:underline">{`${row.label || row.vendorKey} platform`}</Link>;
  }
  if (row.platform === 'logicmonitor') return <span>LogicMonitor sections</span>;
  return <span className="text-ink-faint">Inventory and raw values only</span>;
}

export default function VendorsSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/governance/vendors')
    .then(({ data: d }) => { setError(null); setData(d || {}); })
    .catch((e) => { setError(errorText(e)); setData((cur) => cur || {}); }), []);
  useEffect(() => { load(); }, [load]);

  const shapeOk = data && Array.isArray(data.vendors);
  const rows = (shapeOk ? data.vendors : []).map((v) => ({
    ...v,
    vendorName: v.label || v.vendorKey || (reasonText(v.reasons) || 'Unclassified'),
    kindsText: kindText(v.kinds),
    critical: Number(v.openAlerts?.critical) || 0,
    warning: Number(v.openAlerts?.warning) || 0,
    unknownEnterprise: v.vendorKey == null,
  }));
  const known = rows.filter((r) => !r.unknownEnterprise);
  const unknown = rows.filter((r) => r.unknownEnterprise);

  const ctl = useTableControls(known, {
    searchKeys: ['vendorName', 'kindsText', 'platform'], defaultSortKey: 'devices', defaultSortDir: 'desc', paginate: true, deepLink: false,
  });
  const whereText = (r) => (r.platform && r.platform !== 'logicmonitor' ? `${r.platform} platform` : r.platform === 'logicmonitor' ? 'LogicMonitor sections' : 'Inventory and raw values only');
  const csvColumns = [
    { label: 'Vendor', get: (r) => r.vendorName },
    { label: 'Vendor key', get: (r) => r.vendorKey ?? '' },
    { label: 'Devices', get: (r) => r.devices },
    { label: 'Kinds', get: (r) => r.kindsText },
    { label: 'DataSources', get: (r) => r.dsNames },
    { label: 'DataSources with rules', get: (r) => r.dsMatched },
    { label: 'DataSources with no rules', get: (r) => r.dsUnmatched },
    { label: 'Open critical', get: (r) => r.critical },
    { label: 'Open warning', get: (r) => r.warning },
    { label: 'Where', get: whereText },
    { label: 'Classified by', get: (r) => reasonText(r.reasons) },
  ];

  return (
    <SectionPanel title="Vendors in this portal"
      blurb="How ICC classified each device it stores. A vendor with its own platform shows its pages there; for the rest LogicMonitor keeps the inventory and the raw DataSource values. DataSources with no rules are collected but no ICC rule reads them yet."
      right={<CsvExportButton filename="logicmonitor-vendors" columns={csvColumns} rows={rows} />}>
      {data == null ? <LoadingPanel label="Loading vendors..." height={160} /> : (
        <>
          {error && <p className="text-sm text-status-crit mb-3">{error}</p>}
          {!error && !shapeOk && (
            <p className="text-sm text-status-warn mb-3">The service answered with a shape this page does not read. The service may be on an older version.</p>
          )}
          {!error && shapeOk && rows.length === 0 && (
            <p className="text-sm text-ink-muted py-4 text-center">
              No devices carry a vendor key yet. Keys are set when the inventory tick runs (every 5 minutes by default) after the portal has been polled once.
            </p>
          )}
          {known.length > 0 && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <TableSearch ctl={ctl} placeholder="Search vendor or kind..." />
                <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} vendor(s)</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}>
                    <SortTh k="vendorName" label="Vendor" ctl={ctl} />
                    <SortTh k="devices" label="Devices" ctl={ctl} align="right" />
                    <SortTh k="kindsText" label="Kinds" ctl={ctl} />
                    <SortTh k="dsMatched" label="DataSources (with rules / no rules)" ctl={ctl} align="right" />
                    <SortTh k="critical" label="Open alerts" ctl={ctl} align="right" />
                    <th className="py-2 pr-3">Where</th>
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((r) => (
                      <tr key={r.vendorKey} className="border-b border-cohesity-border/50" title={reasonText(r.reasons) ? `Classified by ${reasonText(r.reasons)}` : undefined}>
                        <td className="py-2 pr-3 text-ink text-[12px]">{r.vendorName}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.devices)}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.kindsText || '-'}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{`${fmtNum(r.dsMatched)} / ${fmtNum(r.dsUnmatched)}`}</td>
                        <td className="py-2 pr-3 text-right text-[12px]">
                          {r.critical ? <Badge tone="crit">{`${fmtNum(r.critical)} critical`}</Badge> : null}
                          {r.warning ? <span className="ml-1"><Badge tone="warn">{`${fmtNum(r.warning)} warning`}</Badge></span> : null}
                          {!r.critical && !r.warning ? <span className="text-ink-faint">None</span> : null}
                        </td>
                        <td className="py-2 pr-3 text-[12px] text-ink-muted"><WhereCell row={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePager ctl={ctl} />
            </>
          )}
          {unknown.length > 0 && (
            <div className="mt-5">
              <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Unrecognised enterprise numbers</p>
              <p className="text-[12px] text-ink-muted mb-2">
                The device reports a SNMP enterprise number ICC has no vendor for. Send the number and a model sample and it can be added.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}>
                    <th className="py-2 pr-3">Enterprise</th>
                    <th className="py-2 pr-3 text-right">Devices</th>
                    <th className="py-2 pr-3">Model samples</th>
                  </tr></thead>
                  <tbody>
                    {unknown.map((r, i) => (
                      <tr key={`${reasonText(r.reasons)}-${i}`} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink text-[12px] font-mono">{reasonText(r.reasons) || r.vendorName}</td>
                        <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.devices)}</td>
                        <td className="py-2 pr-3 text-ink-muted text-[12px]">{arr(r.samples || r.models || r.modelSamples).join(', ') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data?.generatedAt && <p className="text-[11px] text-ink-faint mt-3">{`Generated ${fmtWhen(data.generatedAt)}`}</p>}
        </>
      )}
    </SectionPanel>
  );
}
