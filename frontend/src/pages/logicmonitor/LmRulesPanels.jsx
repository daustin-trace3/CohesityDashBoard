import { useCallback, useEffect, useState } from 'react';
import { Activity, Server, Globe, Cable, Archive, Plus, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { SettingRow, SettingGroup, Toggle, TabSaveBar, numberCls, inputCls } from '../../components/settings/SettingRow';
import { SectionPanel, btnGhost } from './ui';

// Shared load / dirty / save / reset for one panel's keys. Values are held as
// typed (strings); only changed keys go to PUT /logicmonitor/config.
function useLmConfig(keys) {
  const { toast } = useToast();
  const [saved, setSaved] = useState(null);
  const [values, setValues] = useState(null);
  const [ranges, setRanges] = useState({});
  const [saving, setSaving] = useState(false);

  const take = useCallback((data) => {
    const next = {};
    for (const k of keys) next[k] = data?.thresholds?.[k] == null ? '' : String(data.thresholds[k]);
    setSaved(next);
    setValues(next);
    setRanges(data?.ranges || {});
  }, [keys]);

  useEffect(() => {
    client.get('/logicmonitor/config').then(({ data }) => take(data)).catch(() => { setSaved({}); setValues({}); });
  }, [take]);

  const set = (k, v) => setValues((cur) => ({ ...cur, [k]: String(v) }));
  const isDirty = (k) => values != null && saved != null && String(values[k] ?? '') !== String(saved[k] ?? '');
  const dirtyKeys = values ? keys.filter(isDirty) : [];
  const defaultOf = (k) => (ranges[k]?.default != null ? String(ranges[k].default) : null);
  const reset = (k) => { const d = defaultOf(k); if (d != null) set(k, d); };

  const save = async () => {
    if (!dirtyKeys.length) return;
    setSaving(true);
    try {
      const body = {};
      for (const k of dirtyKeys) body[k] = String(values[k]).trim();
      const { data } = await client.put('/logicmonitor/config', body);
      const clamped = dirtyKeys.some((k) => data?.thresholds?.[k] != null && String(data.thresholds[k]) !== body[k]);
      take(data);
      toast({ type: 'success', title: 'Saved', message: clamped ? 'Some values were clamped to their limits' : 'Applies from the next poll.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  return { values, ranges, set, isDirty, dirty: dirtyKeys.length > 0, defaultOf, reset, save, saving };
}

// One numeric row: input with a unit suffix, a faint range line and a reset link.
function NumRow({ cfg, k, label, unit, tip }) {
  const r = cfg.ranges[k] || {};
  const def = cfg.defaultOf(k);
  const differs = def != null && String(cfg.values[k] ?? '') !== def;
  const rangeText = [r.min != null && r.max != null ? `range ${r.min} to ${r.max}` : null, def != null ? `default ${def}` : null].filter(Boolean).join(', ');
  return (
    <SettingRow label={label} htmlFor={`lm-${k}`} dirty={cfg.isDirty(k)}
      tip={<>{tip}{def != null && <> Default {def}{unit ? ` ${unit}` : ''}.</>}</>}>
      <div className="flex items-center gap-2">
        <input id={`lm-${k}`} type="number" min={r.min} max={r.max} value={cfg.values[k] ?? ''} onChange={(e) => cfg.set(k, e.target.value)} className={numberCls} />
        {unit && <span className="text-xs text-ink-muted">{unit}</span>}
      </div>
      <div className="flex items-center gap-3 mt-1">
        {rangeText && <span className="text-[10px] text-ink-faint">{rangeText}</span>}
        {differs && <button type="button" onClick={() => cfg.reset(k)} className="text-[10px] text-brand hover:underline cursor-pointer">Reset to default</button>}
      </div>
    </SettingRow>
  );
}

function ToggleRow({ cfg, k, label, tip }) {
  const on = cfg.values[k] === '' || cfg.values[k] == null ? true : !!Number(cfg.values[k]);
  return (
    <SettingRow label={label} htmlFor={`lm-${k}`} dirty={cfg.isDirty(k)} tip={tip}>
      <Toggle id={`lm-${k}`} checked={on} onChange={(v) => cfg.set(k, v ? '1' : '0')} />
    </SettingRow>
  );
}

const Lead = ({ children }) => <p className="text-[11px] text-ink-muted leading-relaxed mt-2 mb-1">{children}</p>;

function PanelShell({ icon, title, blurb, cfg, children }) {
  return (
    <SectionPanel icon={icon} title={title} blurb={blurb}>
      {cfg.values == null ? <LoadingPanel label="Loading..." height={100} /> : (
        <>
          {children}
          <TabSaveBar onSave={cfg.save} saving={cfg.saving} dirty={cfg.dirty} />
        </>
      )}
    </SectionPanel>
  );
}

const IF_KEYS = ['lm_if_util_warn_pct', 'lm_if_err_warn', 'lm_if_flap_warn', 'lm_if_baseline_days', 'lm_if_baseline_min_samples',
  'lm_if_anomaly_k', 'lm_if_anomaly_util_min_pct', 'lm_if_anomaly_err_min', 'lm_backup_overlay_util_pct'];

export function LmInterfacesRulesPanel() {
  const cfg = useLmConfig(IF_KEYS);
  return (
    <PanelShell icon={Activity} cfg={cfg} title="Interfaces"
      blurb="Raises interface-utilization-high, interface-errors-growing, interface-flapping, interface-util-anomaly and interface-error-anomaly issues. They show on the Issues page, Service Status, the Ops Agent and in alert email.">
      <SettingGroup title="Warnings">
        <NumRow cfg={cfg} k="lm_if_util_warn_pct" label="Utilization warning" unit="%"
          tip="An interface raises interface-utilization-high when the larger of its in and out utilization is at or above this value for each of its last 3 samples. The Interfaces page high-utilization filter uses the same value." />
        <NumRow cfg={cfg} k="lm_if_err_warn" label="Errors in 24 hours" unit="errors"
          tip="An interface raises interface-errors-growing when its in plus out errors over 24 hours exceed this number and each of its last 3 samples still shows errors." />
        <NumRow cfg={cfg} k="lm_if_flap_warn" label="Status changes in 24 hours" unit="changes"
          tip="An interface raises interface-flapping when its status changed at least this many times in 24 hours." />
      </SettingGroup>
      <SettingGroup title="Anomaly detection">
        <Lead>Each interface gets a baseline per hour of day: the median and the MAD (median absolute deviation) of its utilization and errors over the window. A sample is flagged when it is more than k x MAD above the median, and only once the interface has the minimum number of samples.</Lead>
        <NumRow cfg={cfg} k="lm_if_baseline_days" label="Baseline window" unit="days"
          tip="How many days of interface history feed the baseline. Network devices only; the current hour is left out." />
        <NumRow cfg={cfg} k="lm_if_baseline_min_samples" label="Samples before judging" unit="samples"
          tip="An interface needs this many history rows in the baseline window before its baseline is built; until then no anomaly issue is raised for it." />
        <NumRow cfg={cfg} k="lm_if_anomaly_k" label="Spread multiplier (k)" unit="x MAD"
          tip="Raises interface-util-anomaly or interface-error-anomaly when the mean of the last 3 samples is above the hour's median by this many MADs. Utilization uses a MAD of at least 2 and errors a MAD of at least 1. A utilization anomaly is skipped when interface-utilization-high already fired. The Correlation page backup overlay uses the same multiplier." />
        <NumRow cfg={cfg} k="lm_if_anomaly_util_min_pct" label="Ignore utilization below" unit="%"
          tip="A utilization anomaly is only raised when the mean utilization is also above this value, so a quiet port moving from 1% to 6% stays silent." />
        <NumRow cfg={cfg} k="lm_if_anomaly_err_min" label="Ignore errors below" unit="errors"
          tip="An error anomaly is only raised when the mean errors per sample are also above this number." />
      </SettingGroup>
      <SettingGroup title="Backup overlay">
        <NumRow cfg={cfg} k="lm_backup_overlay_util_pct" label="Port counted as saturated by a backup at" unit="%"
          tip="On the Correlation page, a Cohesity backup run is marked as saturating a switch port when the port's mean utilization during the run reaches this value. Runs above the port's baseline by k x MAD are marked elevated. This raises no issue." />
      </SettingGroup>
    </PanelShell>
  );
}

const DEV_KEYS = ['lm_dead_grace_min', 'lm_new_device_days', 'lm_alert_storm_count', 'lm_shadow_enabled', 'lm_path_max_hops'];

export function LmDevicesRulesPanel() {
  const cfg = useLmConfig(DEV_KEYS);
  return (
    <PanelShell icon={Server} cfg={cfg} title="Devices and alerts"
      blurb="Raises device-dead, device-new and alert-storm issues, and decides which LogicMonitor alerts are held back behind an upstream failure. They show on the Issues page, Service Status, the Ops Agent and in alert email.">
      <SettingGroup title="Devices">
        <NumRow cfg={cfg} k="lm_dead_grace_min" label="Dead device grace" unit="min"
          tip="A device LogicMonitor reports as dead raises device-dead only after it has been dead this long. Network devices and check targets are critical, other devices warning. 0 raises it at once." />
        <NumRow cfg={cfg} k="lm_new_device_days" label="New device notice" unit="days"
          tip="A device first seen in the last N days raises an info device-new issue. 0 turns the notice off. Nothing is raised until a portal has been polled for longer than this window, so a first poll does not flag the whole inventory." />
      </SettingGroup>
      <SettingGroup title="Alerts">
        <NumRow cfg={cfg} k="lm_alert_storm_count" label="Alert storm" unit="alerts"
          tip="A portal that opens more than this many alerts in 15 minutes raises an info alert-storm issue." />
        <ToggleRow cfg={cfg} k="lm_shadow_enabled" label="Hold back alerts behind a failed upstream device"
          tip="When on, a dead device or alert behind a dead switch or a down uplink is treated as a consequence: the alert is marked shadowed, the culprit shows a +N count, and a shadowed dead device raises no device-dead issue of its own. Default on." />
      </SettingGroup>
      <SettingGroup title="Server path">
        <NumRow cfg={cfg} k="lm_path_max_hops" label="Maximum hops from a server" unit="hops"
          tip="How many switch, router or firewall hops ICC follows from a server toward the WAN edge when it builds a server path and picks the likely hop." />
      </SettingGroup>
    </PanelShell>
  );
}

const RCH_KEYS = ['lm_check_baseline_days', 'lm_check_baseline_min_samples', 'lm_check_latency_k', 'lm_check_latency_floor_ms',
  'lm_check_latency_min_ms', 'lm_check_loss_min_pct', 'lm_check_loss_crit_pct', 'lm_check_location_fold', 'lm_check_data_calls_per_tick'];

export function LmReachabilityRulesPanel() {
  const cfg = useLmConfig(RCH_KEYS);
  return (
    <PanelShell icon={Globe} cfg={cfg} title="Site reachability"
      blurb="Raises check-down, check-location-down, latency-anomaly, packet-loss-anomaly and location-degraded issues from LogicMonitor ping and website checks. They show on the Issues page, Service Status, the Ops Agent and in alert email.">
      <SettingGroup title="Latency baseline">
        <Lead>Each check location gets a baseline per hour of day: the median and MAD (median absolute deviation) of round-trip time and loss. The mean of the last 3 samples is flagged when it is more than k x MAD above the median, and only once the location has the minimum number of samples for that hour.</Lead>
        <NumRow cfg={cfg} k="lm_check_baseline_days" label="Baseline window" unit="days"
          tip="How many days of check history feed the baseline." />
        <NumRow cfg={cfg} k="lm_check_baseline_min_samples" label="Samples per hour before judging" unit="samples"
          tip="A location needs this many samples in its baseline for the current hour of day before latency-anomaly or packet-loss-anomaly can be raised." />
        <NumRow cfg={cfg} k="lm_check_latency_k" label="Spread multiplier (k)" unit="x MAD"
          tip="Latency is flagged when the mean RTT is above the hour's median by this many MADs. The same multiplier is applied to the loss baseline." />
        <NumRow cfg={cfg} k="lm_check_latency_floor_ms" label="Smallest spread counted" unit="ms"
          tip="The MAD used in the latency test is never smaller than this, so a very steady link does not flag on a few milliseconds of jitter." />
        <NumRow cfg={cfg} k="lm_check_latency_min_ms" label="Ignore latency below" unit="ms"
          tip="A latency anomaly is only raised when the mean RTT is also above this value." />
      </SettingGroup>
      <SettingGroup title="Packet loss">
        <NumRow cfg={cfg} k="lm_check_loss_min_pct" label="Ignore loss below" unit="%"
          tip="A packet-loss-anomaly is only raised when the mean loss is also at or above this value." />
        <NumRow cfg={cfg} k="lm_check_loss_crit_pct" label="Loss is critical at" unit="%"
          tip="A packet-loss-anomaly at or above this mean loss is critical; below it the issue is a warning." />
      </SettingGroup>
      <SettingGroup title="Folding and polling">
        <NumRow cfg={cfg} k="lm_check_location_fold" label="Checks failing at one location to fold" unit="checks"
          tip="When this many checks are anomalous or down at the same checkpoint location, ICC raises one critical location-degraded issue and suppresses the per-check issues at that location." />
        <NumRow cfg={cfg} k="lm_check_data_calls_per_tick" label="Check data calls per poll" unit="calls"
          tip="Cap on LogicMonitor data calls the check poll makes each round, oldest sample first. A website checkpoint costs one call; an uptime DataSource is one call for all its instances. Raise it if checks fall behind, at the cost of more API load." />
      </SettingGroup>
    </PanelShell>
  );
}

// Stored format "dev:port,!dev:port" (see parseWanOverrides in
// backend/services/logicmonitorPath.js) <-> list rows { entry, exclude }.
function parseWan(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (
    x.startsWith('!') ? { entry: x.slice(1), exclude: true } : { entry: x, exclude: false }));
}
const serializeWan = (rows) => rows.filter((r) => String(r.entry || '').trim())
  .map((r) => `${r.exclude ? '!' : ''}${String(r.entry).trim()}`).join(',');

const CIRC_KEYS = ['lm_circuit_sat_pct', 'lm_circuit_crit_pct', 'lm_circuit_sat_days', 'lm_wan_overrides'];

export function LmCircuitsRulesPanel() {
  const cfg = useLmConfig(CIRC_KEYS);
  const stored = cfg.values?.lm_wan_overrides;
  const [rows, setRows] = useState([]);

  // The list keeps blank rows the stored text cannot hold; reload it only when
  // the stored text changed from outside the list (load, save, reset).
  useEffect(() => {
    if (stored == null) return;
    setRows((cur) => (serializeWan(cur) === stored ? cur : parseWan(stored)));
  }, [stored]);

  const change = (next) => { setRows(next); cfg.set('lm_wan_overrides', serializeWan(next)); };
  const update = (i, patch) => change(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <PanelShell icon={Cable} cfg={cfg} title="Circuits"
      blurb="Raises circuit-saturated issues for WAN circuits. They show on the Issues page, the Circuits page, Service Status, the Ops Agent and in alert email.">
      <SettingGroup title="Saturation">
        <NumRow cfg={cfg} k="lm_circuit_sat_pct" label="Saturated at p95 of" unit="%"
          tip="A WAN circuit raises a warning circuit-saturated issue when its p95 utilization (higher of in and out) over the saturation window reaches this value." />
        <NumRow cfg={cfg} k="lm_circuit_crit_pct" label="Critical when the daily peak reaches" unit="%"
          tip="A circuit turns critical when its daily peak utilization is at or above this value on 3 days in a row." />
        <NumRow cfg={cfg} k="lm_circuit_sat_days" label="Saturation window" unit="days"
          tip="How many days of interface history the p95 is taken over." />
      </SettingGroup>
      <SettingGroup title="WAN port overrides">
        <Lead>ICC marks WAN ports by rule (router and firewall ports whose description names a carrier, unresolved uplinks, circuit IDs). List a port here to force it in, or tick Exclude to keep it out. Circuits are recomputed from the Circuits page.</Lead>
        <SettingRow label="Ports" dirty={cfg.isDirty('lm_wan_overrides')}
          tip="One entry per port, written device:port, matched case-insensitively against the device name and the interface name. An Exclude entry wins over a rule match. Stored as a comma list with ! in front of excluded ports.">
          <div className="flex flex-col gap-2 md:pt-1">
            {rows.length === 0 && <p className="text-xs text-ink-muted">No overrides. The rules decide.</p>}
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-3 flex-wrap">
                <input type="text" value={r.entry} onChange={(e) => update(i, { entry: e.target.value })} placeholder="device:port" spellCheck={false}
                  aria-label="Device and port" className={`${inputCls} max-w-xs`} />
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted cursor-pointer">
                  <input type="checkbox" className="accent-brand" checked={r.exclude} onChange={(e) => update(i, { exclude: e.target.checked })} /> Exclude
                </label>
                <button type="button" onClick={() => change(rows.filter((_, j) => j !== i))} aria-label="Remove port"
                  className="text-ink-faint hover:text-red-400 cursor-pointer"><Trash2 size={14} /></button>
              </div>
            ))}
            <div>
              <button type="button" onClick={() => setRows([...rows, { entry: '', exclude: false }])}
                className={`${btnGhost} !px-3 !py-1.5 !text-xs inline-flex items-center gap-1.5`}>
                <Plus size={13} /> Add port
              </button>
            </div>
          </div>
        </SettingRow>
      </SettingGroup>
    </PanelShell>
  );
}

const RET_KEYS = ['lm_alert_retention_days', 'lm_interface_history_days', 'lm_check_history_days', 'lm_webhook_rate_per_min'];

export function LmRetentionPanel() {
  const cfg = useLmConfig(RET_KEYS);
  return (
    <PanelShell icon={Archive} cfg={cfg} title="Retention and limits"
      blurb="How long ICC keeps the LogicMonitor history it collects, and how many webhook deliveries it accepts. These raise no issues.">
      <SettingGroup title="Retention">
        <NumRow cfg={cfg} k="lm_alert_retention_days" label="Cleared alerts" unit="days"
          tip="Cleared LogicMonitor alerts older than this are deleted when a poll prunes history. Open alerts are not deleted." />
        <NumRow cfg={cfg} k="lm_interface_history_days" label="Interface history" unit="days"
          tip="Interface samples older than this are deleted. Interface baselines and the circuit saturation window can only use the history that is kept." />
        <NumRow cfg={cfg} k="lm_check_history_days" label="Check history" unit="days"
          tip="Ping and website check samples older than this are deleted. The latency baseline can only use the history that is kept." />
      </SettingGroup>
      <SettingGroup title="Limits">
        <NumRow cfg={cfg} k="lm_webhook_rate_per_min" label="Webhook deliveries accepted" unit="per minute"
          tip="Rate limit on the webhook ingest endpoint, counted per portal. Deliveries above it are refused until the limit window rolls over." />
      </SettingGroup>
    </PanelShell>
  );
}
