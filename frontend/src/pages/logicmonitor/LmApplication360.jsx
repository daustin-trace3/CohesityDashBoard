import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppWindow } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager } from '../../components/ui/tableTools';
import {
  DASH, arr, fmtNum, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel,
} from './helpers';
import { Modal, SectionPanel, Fact, headRow } from './ui';
import { TrendLine, IssuesList, num } from './LmFirewall360';
import { DeviceDatasourcesTab } from './LmRawDatasources';

const HISTORY_TITLES = {
  sql_connections: ['SQL connections, 24 hours', false],
  sql_batch_rate: ['SQL batch requests, 24 hours', false],
  splunk_license_used_pct: ['Splunk license used, 24 hours', true],
  emc_cap_used_pct: ['EMC capacity used, 24 hours', true],
  hv_cpu_pct: ['Hyper-V CPU, 24 hours', true],
  esa_queue: ['IronPort work queue, 24 hours', false],
};

// A state metric holds a raw number whose enum is unverified: show the number.
function cell(m) {
  if (!m || m.value == null) return DASH;
  const v = Number(m.value);
  const shown = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(+v.toFixed(2));
  return m.unit && m.kind !== 'state' ? `${shown} ${m.unit}` : shown;
}

function DatasourceTable({ ds }) {
  const cols = useMemo(() => {
    const seen = new Map();
    for (const i of ds.instances) for (const [k, m] of Object.entries(i.metrics || {})) if (!seen.has(k)) seen.set(k, m.label || k);
    return [...seen.entries()];
  }, [ds]);
  const rows = useMemo(() => ds.instances.map((i) => ({ name: i.name, ...Object.fromEntries(cols.map(([k]) => [k, num(i.metrics?.[k]?.value)])), _m: i.metrics })), [ds, cols]);
  const ctl = useTableControls(rows, { searchKeys: ['name'], paginate: true, defaultPageSize: 10, deepLink: false });
  return (
    <SectionPanel title={ds.label} blurb={ds.label !== ds.name ? ds.name : undefined}
      right={<span className="text-[11px] text-ink-faint tnum">{fmtNum(ds.instanceCount)} instance(s){ds.truncated ? ', first 500 shown' : ''}</span>}>
      {rows.length > 10 && <div className="mb-2"><TableSearch ctl={ctl} placeholder="Search instance..." /></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className={headRow}>
            <SortTh k="name" label="Instance" ctl={ctl} />
            {cols.map(([k, label]) => <SortTh key={k} k={k} label={label} ctl={ctl} align="right" />)}
          </tr></thead>
          <tbody>
            {ctl.pageRows.map((r) => (
              <tr key={r.name} className="border-b border-cohesity-border/40">
                <td className="py-1.5 pr-3 text-ink text-[12px] truncate max-w-[260px]" title={r.name}>{r.name}</td>
                {cols.map(([k]) => <td key={k} className="py-1.5 pr-3 text-right tnum text-ink-muted text-[12px]">{cell(r._m?.[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </SectionPanel>
  );
}

export default function LmApplication360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`/logicmonitor/applications/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Application not found. It may have been removed or has no application data.' : 'Failed to load the application.'));
  }, [deviceId, sourceId]);

  const s = data?.summary || {};
  const d = data?.device || {};
  const hist = data?.history || {};
  const histKeys = Object.keys(HISTORY_TITLES).filter((k) => arr(hist[k]).length);

  return (
    <Modal icon={AppWindow} title={s.deviceName || d.displayName || `Application ${deviceId}`} subtitle={[s.vendor, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading application..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            {arr(s.kindLabels).map((k) => <Badge key={k} tone="info">{k}</Badge>)}
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Fact label="Site">{s.siteName || s.siteKey}</Fact>
            <Fact label="Instances">{fmtNum(s.instances)}</Fact>
            <Fact label="Down">{fmtNum(s.downCount)}</Fact>
            <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
          </div>
          {s.headline ? <p className="text-[12px] text-ink-muted">{s.headline}</p> : null}

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          {histKeys.length > 0 && (
            <div className="grid lg:grid-cols-2 gap-4">
              {histKeys.map((k) => (
                <SectionPanel key={k} title={HISTORY_TITLES[k][0]}>
                  <TrendLine pct={HISTORY_TITLES[k][1]} series={[{ label: HISTORY_TITLES[k][0], points: hist[k] }]} />
                </SectionPanel>
              ))}
            </div>
          )}

          {arr(data.datasources).map((ds) => <DatasourceTable key={`${ds.hdsId}|${ds.name}`} ds={ds} />)}

          <SectionPanel title="Raw datapoints" blurb="Every DataSource LogicMonitor holds for this device, stored as read. Pick one to see its instances and datapoints.">
            <DeviceDatasourcesTab deviceId={deviceId} sourceId={sourceId} />
          </SectionPanel>
        </div>
      )}
    </Modal>
  );
}
