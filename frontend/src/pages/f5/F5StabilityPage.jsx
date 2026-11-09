import { useState } from 'react';
import { Cpu, Thermometer, Network, RotateCcw, ShieldAlert } from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, chipBtn } from '../logicmonitor/ui';
import { useF5Get } from './f5Shared';
import { PageError, CtlTable, n1 } from './f5Kit';

const DAYS = [7, 30, 90];
const STATE_TONE = { ok: 'ok', degraded: 'warn', failed: 'crit', unknown: 'neutral' };

export default function F5StabilityPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/stability', 'F5 stability', { params: { days } });
  const fleet = useF5Get('/f5/fleet', 'F5 fleet hygiene', { params: { days } });
  const daemons = Array.isArray(data?.daemons) ? data.daemons : [];
  const comps = Array.isArray(data?.hardware?.components) ? data.hardware.components : [];
  const derived = data?.hardware?.derived || {};
  const lost = Array.isArray(derived.redundancyLost) ? derived.redundancyLost : [];
  const hot = Array.isArray(derived.thermalOutliers) ? derived.thermalOutliers : [];
  const reboots = Array.isArray(data?.reboots) ? data.reboots : [];
  const f = fleet.data || {};
  const avail = f.availability && Array.isArray(f.availability.devices) ? f.availability.devices : (Array.isArray(f.availability) ? f.availability : []);
  const noise = f.alertNoise || {};

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Cpu} title="Stability" description="Daemon flaps, hardware, interface errors and reboots, with fleet hygiene beneath">
        <div className="flex items-center gap-1.5">
          {DAYS.map((d) => <button key={d} className={chipBtn(days === d)} onClick={() => setDays(d)}>{d} d</button>)}
        </div>
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={() => { reload(); fleet.reload(); }} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={RotateCcw} label="Daemon flaps" value={fmtNum(daemons.filter((d) => (d.nonZeroDays || 0) > 0).length)} tone={daemons.some((d) => d.nonZeroDays) ? 'warn' : 'ok'} sub={`non-zero days in ${days} d`} loading={loading} />
        <StatCard icon={ShieldAlert} label="Redundancy lost" value={fmtNum(lost.length)} tone={lost.length ? 'crit' : 'ok'} sub="PSU or fan" loading={loading} />
        <StatCard icon={Thermometer} label="Thermal outliers" value={fmtNum(hot.length)} tone={hot.length ? 'warn' : 'ok'} loading={loading} />
        <StatCard icon={Network} label="Interfaces with errors" value={fmtNum((data?.interfaces?.errors || []).length)} loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading stability data..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="grid xl:grid-cols-2 gap-4">
            <SectionPanel title="Daemon flaps" blurb="mcpd, tmm and the other daemons report an exit code; any non-zero day is shown as an event.">
              <CtlTable rows={daemons} searchKeys={['device', 'daemon']} defaultSortKey="nonZeroDays" defaultSortDir="desc" empty="No daemon exit codes recorded." pageSize={8}
                columns={[
                  { k: 'device', label: 'Unit' }, { k: 'daemon', label: 'Daemon' },
                  { k: 'nonZeroDays', label: 'Non-zero days', align: 'right', render: (r) => <Badge tone={r.nonZeroDays ? 'warn' : 'ok'}>{fmtNum(r.nonZeroDays || 0)}</Badge> },
                  { k: 'events', label: 'Last event', render: (r) => (Array.isArray(r.events) && r.events.length ? String(r.events[r.events.length - 1].day || r.events[r.events.length - 1]) : DASH) },
                ]} />
            </SectionPanel>
            <SectionPanel title="Reboots" blurb="Detected from the uptime counter resetting; F5 only has this when an uptime DataSource is collected.">
              <CtlTable rows={reboots.map((r) => ({ ...r, count: r.events.length, last: r.events.length ? String(r.events[r.events.length - 1].day || '') : '' }))} searchKeys={['device']} defaultSortKey="count" defaultSortDir="desc" empty="No reboots detected, or uptime is not collected for these units." pageSize={8} search={false}
                columns={[{ k: 'device', label: 'Unit' }, { k: 'count', label: 'Reboots', align: 'right' }, { k: 'last', label: 'Last', render: (r) => r.last || DASH }]} />
            </SectionPanel>
          </div>

          <SectionPanel title="Hardware" blurb="Fan, power supply and temperature. Redundancy lost means a unit that is up with one power supply or fan left.">
            {lost.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">{lost.map((l) => <Badge key={`${l.device}-${l.reason}`} tone="crit">{`${l.device}: ${l.reason}`}</Badge>)}</div>
            )}
            <CtlTable rows={comps} searchKeys={['device', 'component', 'instance']} defaultSortKey="state" empty="No hardware sensors collected." pageSize={10}
              columns={[
                { k: 'device', label: 'Unit' },
                { k: 'component', label: 'Component' },
                { k: 'instance', label: 'Instance' },
                { k: 'state', label: 'State', sortValue: (r) => ({ failed: 0, degraded: 1, unknown: 2, ok: 3 }[r.state] ?? 4), render: (r) => <Badge tone={STATE_TONE[r.state] || 'neutral'}>{r.state || DASH}</Badge> },
                { k: 'value', label: 'Value', align: 'right', render: (r) => (r.value == null ? DASH : `${n1(r.value)}${r.unit ? ` ${r.unit}` : ''}`) },
              ]} />
            {hot.length > 0 && (
              <div className="mt-3">
                <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Thermal outliers</p>
                <CtlTable rows={hot} search={false} pageSize={5} empty=""
                  columns={[
                    { k: 'device', label: 'Unit' }, { k: 'sensor', label: 'Sensor' },
                    { k: 'tempC', label: 'Temp C', align: 'right', render: (r) => n1(r.tempC) },
                    { k: 'modelMedian', label: 'Model median', align: 'right', render: (r) => n1(r.modelMedian) },
                    { k: 'suspectedSiteHvac', label: 'Note', render: (r) => (r.suspectedSiteHvac ? <Badge tone="warn">site cooling suspected</Badge> : DASH) },
                  ]} />
              </div>
            )}
          </SectionPanel>

          <div className="grid xl:grid-cols-2 gap-4">
            <SectionPanel title="Interface errors and drops" blurb="Top interfaces by errors and discards over the window, against their own baseline.">
              <CtlTable rows={data?.interfaces?.errors || []} searchKeys={['device', 'ifName']} defaultSortKey="errorsSum" defaultSortDir="desc" empty="No interface errors recorded." pageSize={8}
                columns={[
                  { k: 'device', label: 'Unit' }, { k: 'ifName', label: 'Interface' },
                  { k: 'errorsSum', label: 'Errors', align: 'right', render: (r) => fmtNum(r.errorsSum) },
                  { k: 'discardsSum', label: 'Discards', align: 'right', render: (r) => fmtNum(r.discardsSum) },
                  { k: 'deviates', label: 'Vs baseline', render: (r) => (r.deviates ? <Badge tone="warn">above baseline</Badge> : DASH) },
                ]} />
            </SectionPanel>
            <SectionPanel title="Busiest interfaces" blurb="p95 utilisation over the window.">
              <CtlTable rows={data?.interfaces?.hot || []} searchKeys={['device', 'ifName']} defaultSortKey="p95InUtil" defaultSortDir="desc" empty="No interface utilisation history yet." pageSize={8}
                columns={[
                  { k: 'device', label: 'Unit' }, { k: 'ifName', label: 'Interface' },
                  { k: 'p95InUtil', label: 'In p95', align: 'right', render: (r) => (r.p95InUtil == null ? DASH : `${n1(r.p95InUtil)}%`) },
                  { k: 'p95OutUtil', label: 'Out p95', align: 'right', render: (r) => (r.p95OutUtil == null ? DASH : `${n1(r.p95OutUtil)}%`) },
                ]} />
            </SectionPanel>
          </div>

          <SectionPanel title="Fleet hygiene" blurb={`Software versions, availability over ${days} days (SDT days excluded) and repeat alert offenders.`}>
            {fleet.loading ? <LoadingPanel label="Loading fleet..." height={80} /> : (
              <div className="flex flex-col gap-4">
                <CtlTable rows={Array.isArray(f.versions) ? f.versions : []} searchKeys={['model', 'version']} empty="No version data." pageSize={8}
                  columns={[
                    { k: 'vendorKind', label: 'Kind' }, { k: 'model', label: 'Model' }, { k: 'version', label: 'Version' },
                    { k: 'devices', label: 'Units', align: 'right' },
                    { k: 'dominant', label: 'Dominant', render: (r) => (r.dominant ? <Badge tone="ok">dominant</Badge> : <Badge tone="warn">outlier</Badge>) },
                  ]} />
                <CtlTable rows={avail} searchKeys={['device', 'site']} defaultSortKey="availabilityPct" empty="No availability history yet." pageSize={8}
                  columns={[
                    { k: 'device', label: 'Unit' }, { k: 'site', label: 'Site' },
                    { k: 'availabilityPct', label: 'Availability', align: 'right', render: (r) => (r.availabilityPct == null ? DASH : `${n1(r.availabilityPct)}%`) },
                    { k: 'deadDays', label: 'Dead days', align: 'right' }, { k: 'sdtDays', label: 'SDT days', align: 'right' },
                  ]} />
                <CtlTable rows={Array.isArray(noise.repeatOffenders) ? noise.repeatOffenders : []} search={false} empty="No repeat alert offenders." pageSize={8}
                  columns={[
                    { k: 'device', label: 'Repeat offender' }, { k: 'type', label: 'Alert' },
                    { k: 'count7d', label: 'Count, 7 d', align: 'right' },
                  ]} />
              </div>
            )}
          </SectionPanel>
        </div>
      )}
    </div>
  );
}
