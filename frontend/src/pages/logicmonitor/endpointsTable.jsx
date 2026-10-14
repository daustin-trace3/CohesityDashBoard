// Switch port to endpoint rows (governance.endpoints and device 360
// endpoints[]). The endpoint cell opens Server 360; the switch cell opens
// Device 360 through onDevice.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, FilterSelect, TablePager } from '../../components/ui/tableTools';
import { fmtNum, fmtWhen, statusTextTone, platformLabel, confidenceTone } from './helpers';
import { headRow, UtilBar } from './ui';

export default function EndpointsTable({ rows, showSwitch = true, onDevice, emptyText = 'No endpoints matched to switch ports yet.' }) {
  const list = useMemo(() => (Array.isArray(rows) ? rows : []).map((r) => ({
    ...r,
    platformLabel: platformLabel(r.endpointPlatform),
    portErrorsNum: r.portErrors == null ? null : Number(r.portErrors),
  })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['deviceName', 'port', 'endpoint', 'nic', 'protocol'],
    defaultSortKey: showSwitch ? 'deviceName' : 'port', paginate: true,
  });
  if (!list.length) return <p className="text-sm text-ink-muted py-6 text-center">{emptyText}</p>;
  const cell = 'py-1.5 pr-3 text-[12px]';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <TableSearch ctl={ctl} placeholder="Search switch, port, endpoint or NIC..." />
        <FilterSelect ctl={ctl} k="platformLabel" rows={list} label="platforms" />
        {showSwitch && <FilterSelect ctl={ctl} k="deviceName" rows={list} label="switches" />}
        <span className="text-[11px] text-ink-faint ml-auto tnum">{fmtNum(ctl.rows.length)} row(s)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            {showSwitch && <SortTh k="deviceName" label="Switch" ctl={ctl} />}
            <SortTh k="port" label="Port" ctl={ctl} />
            <SortTh k="portStatusText" label="Port status" ctl={ctl} />
            <SortTh k="portInUtilPct" label="In %" ctl={ctl} />
            <SortTh k="portOutUtilPct" label="Out %" ctl={ctl} />
            <SortTh k="portErrorsNum" label="Errors" ctl={ctl} align="right" />
            <SortTh k="endpoint" label="Endpoint" ctl={ctl} />
            <SortTh k="platformLabel" label="Platform" ctl={ctl} />
            <SortTh k="nic" label="NIC" ctl={ctl} />
            <SortTh k="protocol" label="Protocol" ctl={ctl} />
            <SortTh k="confidence" label="Confidence" ctl={ctl} />
            <SortTh k="lastSeen" label="Last seen" ctl={ctl} />
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r, i) => (
              <tr key={`${r.sourceId}-${r.deviceId}-${r.port}-${r.endpoint}-${r.nic || ''}-${i}`} className="border-b border-cohesity-border/50">
                {showSwitch && (
                  <td className={cell}>
                    {r.deviceId && onDevice
                      ? <button onClick={() => onDevice(r.deviceId, r.sourceId)} className="text-brand hover:underline cursor-pointer text-left">{r.deviceName || `Device ${r.deviceId}`}</button>
                      : <span className="text-ink">{r.deviceName || '-'}</span>}
                  </td>
                )}
                <td className={`${cell} text-ink font-mono text-[11px]`}>{r.port || '-'}</td>
                <td className={cell}>{r.portStatusText ? <Badge tone={statusTextTone(r.portStatusText)}>{r.portStatusText}</Badge> : <span className="text-ink-faint">-</span>}</td>
                <td className={cell}><UtilBar pct={r.portInUtilPct} /></td>
                <td className={cell}><UtilBar pct={r.portOutUtilPct} /></td>
                <td className={`${cell} text-right tnum text-ink-muted`}>{fmtNum(r.portErrors)}</td>
                <td className={cell}>
                  {r.endpoint
                    ? <Link to={`/ops/server360?name=${encodeURIComponent(r.endpoint)}`} className="text-brand hover:underline" title="Open Server 360">{r.endpoint}</Link>
                    : <span className="text-ink-faint">-</span>}
                </td>
                <td className={cell}>{r.endpointPlatform ? <Badge tone="info">{r.platformLabel}</Badge> : '-'}</td>
                <td className={`${cell} text-ink-muted font-mono text-[11px]`}>{r.nic || '-'}</td>
                <td className={`${cell} text-ink-muted`}>{r.protocol ? String(r.protocol).toUpperCase() : '-'}</td>
                <td className={cell}>{r.confidence ? <Badge tone={confidenceTone(r.confidence)}>{r.confidence}</Badge> : '-'}</td>
                <td className={`${cell} text-ink-faint text-[11px] tnum whitespace-nowrap`}>{fmtWhen(r.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} />
    </>
  );
}
