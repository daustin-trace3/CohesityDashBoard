import { useCallback, useEffect, useState } from 'react';
import { Activity, Server, Globe, Cable, Archive, Layers, Plus, Trash2, ListChecks } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel, Badge } from '../../components/ui/primitives';
import { SettingRow, SettingGroup, Toggle, TabSaveBar, numberCls, inputCls } from '../../components/settings/SettingRow';
import { SectionPanel, btnGhost, btnPrimary, headRow, sel, inp } from './ui';
import { severityTone, fmtNum, arr } from './helpers';

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
function NumRow({ cfg, k, label, unit, tip, step }) {
  const r = cfg.ranges[k] || {};
  const def = cfg.defaultOf(k);
  const differs = def != null && String(cfg.values[k] ?? '') !== def;
  const rangeText = [r.min != null && r.max != null ? `range ${r.min} to ${r.max}` : null, def != null ? `default ${def}` : null].filter(Boolean).join(', ');
  return (
    <SettingRow label={label} htmlFor={`lm-${k}`} dirty={cfg.isDirty(k)}
      tip={<>{tip}{def != null && <> Default {def}{unit ? ` ${unit}` : ''}.</>}</>}>
      <div className="flex items-center gap-2">
        <input id={`lm-${k}`} type="number" step={step} min={r.min} max={r.max} value={cfg.values[k] ?? ''} onChange={(e) => cfg.set(k, e.target.value)} className={numberCls} />
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
  'lm_check_latency_min_ms', 'lm_check_loss_min_pct', 'lm_check_loss_crit_pct', 'lm_check_location_fold', 'lm_check_data_calls_per_tick',
  'lm_watch_sustain_minutes', 'lm_watch_trend_windows', 'lm_watch_severe_ratio', 'lm_watch_clear_samples', 'lm_watch_repeat_days',
  'lm_watch_repeat_min', 'lm_watch_drift_pct', 'lm_watch_drift_crit_pct', 'lm_watch_reference_days', 'lm_issue_clear_absences'];

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
      <SettingGroup title="Latency watch">
        <Lead>An anomaly opens an episode that is watched, not alerted. A one-off spike that clears on its own stays on the Site Reachability page. An episode that lasts, climbs or is severe becomes a latency-degrading issue; spikes that keep coming back raise latency-pattern; a slow rise in the baseline itself raises latency-drift.</Lead>
        <NumRow cfg={cfg} k="lm_watch_sustain_minutes" label="Sustained after" unit="min"
          tip="An episode that stays elevated this long is promoted and raises a latency-degrading issue (loss-degrading for packet loss). It becomes critical when the severe level holds for this long or the location goes down." />
        <NumRow cfg={cfg} k="lm_watch_trend_windows" label="Rising trend windows" unit="windows"
          tip="An episode is promoted early when its rolling median rises across this many consecutive windows. Raises latency-degrading before the sustain time passes." />
        <NumRow cfg={cfg} k="lm_watch_severe_ratio" label="Severe spike ratio over baseline" unit="x" step="0.1"
          tip="Two consecutive samples this many times the baseline median promote the episode at once. Raises latency-degrading." />
        <NumRow cfg={cfg} k="lm_watch_clear_samples" label="Normal samples to close" unit="samples"
          tip="An episode closes after this many consecutive normal samples. It is recorded as one-off, sustained or escalated depending on how far it got." />
        <NumRow cfg={cfg} k="lm_issue_clear_absences" label="Polls an anomaly must be absent before its issue clears" unit="polls"
          tip="Hysteresis for latency-anomaly, packet-loss-anomaly, interface anomaly, latency-degrading and loss-degrading issues: one clean poll does not resolve them." />
      </SettingGroup>
      <SettingGroup title="Repeating spikes and drift">
        <NumRow cfg={cfg} k="lm_watch_repeat_days" label="Repeat window" unit="days"
          tip="One-off episodes on the same check location are counted over this many days for the latency-pattern issue." />
        <NumRow cfg={cfg} k="lm_watch_repeat_min" label="One-offs that make a pattern" unit="items"
          tip="This many one-off episodes inside the repeat window raise a latency-pattern warning, unless a degrading episode is already open on the same location." />
        <NumRow cfg={cfg} k="lm_watch_drift_pct" label="Baseline drift, info at" unit="%"
          tip="The live baseline median sits this far above the reference in at least 16 of 24 hours: latency-drift is raised as info." />
        <NumRow cfg={cfg} k="lm_watch_drift_crit_pct" label="Baseline drift, warning at" unit="%"
          tip="Drift at or above this percentage raises latency-drift as a warning instead of info." />
        <NumRow cfg={cfg} k="lm_watch_reference_days" label="Reference window" unit="days"
          tip="Days of check history behind the long-term reference the live baseline is compared with. The newest 7 days are left out, so a recent rise does not hide itself." />
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

const CIRC_KEYS = ['lm_circuit_sat_pct', 'lm_circuit_crit_pct', 'lm_circuit_sat_days', 'lm_wan_overrides', 'lm_carrier_aliases'];

const BUILTIN_ALIASES = 'VZB Verizon, CTL and L3 Lumen, CGT Cogent, ECX Equinix, ZYO Zayo, ATT AT&T';

function UnknownCarriers({ refreshKey }) {
  const [list, setList] = useState(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    client.get('/logicmonitor/circuits/unknown-carriers', { params: { _: Date.now() } })
      .then(({ data }) => {
        const rows = Array.isArray(data) ? data : arr(data?.items);
        if (alive) setList(rows);
      })
      .catch(() => { if (alive) setList([]); });
    return () => { alive = false; };
  }, [refreshKey]);
  if (list == null) return <LoadingPanel label="Loading circuits..." height={60} />;
  const cap = showAll ? list.length : 50;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-ink mb-1">{`Circuits with no carrier (${fmtNum(list.length)})`}</p>
      {list.length === 0 ? <p className="text-xs text-ink-muted">Every WAN circuit has a carrier.</p> : (
        <>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead><tr className={headRow}><th className="py-1.5 pr-3">Device</th><th className="py-1.5 pr-3">Port</th><th className="py-1.5 pr-3">Label</th></tr></thead>
              <tbody>
                {list.slice(0, cap).map((r, i) => (
                  <tr key={i} className="border-b border-cohesity-border/40">
                    <td className="py-1 pr-3 text-[12px] text-ink">{r.deviceName || '-'}</td>
                    <td className="py-1 pr-3 text-[12px] text-ink-muted">{r.port || '-'}</td>
                    <td className="py-1 pr-3 text-[11px] text-ink-faint truncate max-w-[480px]" title={r.label || ''}>{r.label || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.length > 50 && !showAll && (
            <button type="button" onClick={() => setShowAll(true)} className="text-[11px] text-brand hover:underline cursor-pointer mt-1">{`and ${fmtNum(list.length - 50)} more`}</button>
          )}
        </>
      )}
    </div>
  );
}

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
      <SettingGroup title="Carrier aliases">
        <SettingRow label="Aliases" htmlFor="lm-lm_carrier_aliases" dirty={cfg.isDirty('lm_carrier_aliases')}
          tip="Written token=Carrier, token2=Other. Tokens are whole words, case does not matter, and your entries win over the built-in list. Applies from the next circuit recompute.">
          <input id="lm-lm_carrier_aliases" type="text" value={cfg.values?.lm_carrier_aliases ?? ''} onChange={(e) => cfg.set('lm_carrier_aliases', e.target.value)}
            placeholder="token=Carrier, token2=Other" spellCheck={false} maxLength={2000} className={inputCls} />
          <p className="text-[10px] text-ink-faint mt-1">token=Carrier, token2=Other; tokens are whole words, case does not matter; your entries win over the built-in list</p>
        </SettingRow>
        <p className="text-[11px] text-ink-muted mt-1">{`Built in: ${BUILTIN_ALIASES}.`}</p>
        <UnknownCarriers refreshKey={cfg.saving ? 'saving' : 'idle'} />
      </SettingGroup>
    </PanelShell>
  );
}

const SVC_KEYS = ['lm_fw_session_warn_pct', 'lm_tunnel_fold', 'lm_cert_warn_days', 'lm_cpu_warn_pct', 'lm_mem_warn_pct',
  'lm_wlan_chan_util_warn_pct', 'lm_wlan_client_cap_warn_pct', 'lm_wlan_ap_avail_warn_pct', 'lm_wlan_ap_fold',
  'lm_fs_warn_pct', 'lm_fs_crit_pct', 'lm_cohesity_cap_warn_pct', 'lm_cohesity_cap_crit_pct'];

export function LmServicesRulesPanel() {
  const cfg = useLmConfig(SVC_KEYS);
  return (
    <PanelShell icon={Layers} cfg={cfg} title="Services"
      blurb="Thresholds for the issues raised from the DataSource metrics tier: firewalls, load balancers, wireless and device health. They show on the Issues page, the Firewalls, Load Balancers and Wireless pages, Service Status, the Ops Agent and in alert email.">
      <SettingGroup title="Firewalls">
        <NumRow cfg={cfg} k="lm_fw_session_warn_pct" label="Session table warning" unit="%"
          tip="A firewall raises a warning fw-session-high issue when its session table utilization is at or above this value." />
        <NumRow cfg={cfg} k="lm_tunnel_fold" label="Tunnels down before folding" unit="tunnels"
          tip="Each IPSec tunnel that is down raises its own fw-tunnel-down warning. When more tunnels than this are down on one firewall, ICC raises a single warning (N of M IPSec tunnels down) instead." />
      </SettingGroup>
      <SettingGroup title="Load balancers">
        <NumRow cfg={cfg} k="lm_cert_warn_days" label="Certificate expiry warning" unit="days"
          tip="An F5 certificate raises a lb-cert-expiring warning when it has fewer days left than this, and turns critical under 7 days." />
      </SettingGroup>
      <SettingGroup title="Wireless">
        <NumRow cfg={cfg} k="lm_wlan_chan_util_warn_pct" label="Radio channel utilization warning" unit="%"
          tip="An AP radio raises a wlan-channel-util-high warning when its channel utilization is at or above this value. It also marks the radio as hot on the RF Analytics page." />
        <NumRow cfg={cfg} k="lm_wlan_client_cap_warn_pct" label="Controller client capacity warning" unit="%"
          tip="An AireOS controller raises a wlan-client-capacity-high warning when its clients use this share of its maximum." />
        <NumRow cfg={cfg} k="lm_wlan_ap_avail_warn_pct" label="Controller AP availability warning" unit="%"
          tip="A controller with the AP status check raises a wlan-ap-availability-low warning below this share of APs available, critical below half of it." />
        <NumRow cfg={cfg} k="lm_wlan_ap_fold" label="APs or radios before folding" unit="items"
          tip="Each down AP, down radio, hot radio or erroring AP uplink raises its own issue. Above this many on one controller ICC raises one issue for the controller instead." />
      </SettingGroup>
      <SettingGroup title="Servers">
        <NumRow cfg={cfg} k="lm_fs_warn_pct" label="Filesystem warning" unit="%"
          tip="A server filesystem raises a warning server-filesystem-full issue at or above this value (pseudo filesystems such as /proc, /sys, /dev, /run and tmpfs are skipped)." />
        <NumRow cfg={cfg} k="lm_fs_crit_pct" label="Filesystem critical" unit="%"
          tip="The same issue turns critical at or above this value." />
      </SettingGroup>
      <SettingGroup title="Cohesity via LogicMonitor">
        <NumRow cfg={cfg} k="lm_cohesity_cap_warn_pct" label="Cluster capacity warning" unit="%"
          tip="A Cohesity cluster polled through LogicMonitor raises a warning cohesity-capacity-high issue at or above this value." />
        <NumRow cfg={cfg} k="lm_cohesity_cap_crit_pct" label="Cluster capacity critical" unit="%"
          tip="The same issue turns critical at or above this value." />
      </SettingGroup>
      <SettingGroup title="Device health">
        <Lead>The metrics tier samples every 30 minutes by default, so these use the latest value rather than a run of samples.</Lead>
        <NumRow cfg={cfg} k="lm_cpu_warn_pct" label="CPU warning" unit="%"
          tip="A device raises a warning device-cpu-high issue when its latest CPU reading is at or above this value." />
        <NumRow cfg={cfg} k="lm_mem_warn_pct" label="Memory warning" unit="%"
          tip="A device raises a warning device-memory-high issue when its latest memory reading is at or above this value." />
      </SettingGroup>
    </PanelShell>
  );
}

const RET_KEYS = ['lm_alert_retention_days', 'lm_interface_history_days', 'lm_check_history_days', 'lm_ds_history_days', 'lm_webhook_rate_per_min', 'lm_metrics_data_calls_per_tick'];

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
        <NumRow cfg={cfg} k="lm_ds_history_days" label="DataSource metric history" unit="days"
          tip="History samples from the DataSource metrics tier (session counts, CPU, memory and similar) older than this are deleted. Latest values are always kept." />
      </SettingGroup>
      <SettingGroup title="Limits">
        <NumRow cfg={cfg} k="lm_webhook_rate_per_min" label="Webhook deliveries accepted" unit="per minute"
          tip="Rate limit on the webhook ingest endpoint, counted per portal. Deliveries above it are refused until the limit window rolls over." />
        <NumRow cfg={cfg} k="lm_metrics_data_calls_per_tick" label="Metric data calls per poll" unit="calls"
          tip="Cap on LogicMonitor data calls the DataSource metrics tier makes each round, least recently polled first. One call reads all instances of one DataSource on one device. Raise it if devices fall behind, at the cost of more API load." />
      </SettingGroup>
    </PanelShell>
  );
}

// ---- Raw datapoint rules (round 12) ------------------------------------------------
const OPS = ['>', '>=', '<', '<=', '==', '!='];
const SEVS = ['info', 'warning', 'critical'];
const blankRule = { datasource: '', datapoint: '', op: '>', value: '', severity: 'warning', label: '', instanceMatch: '', deviceMatch: '' };

export function LmRawRulesPanel() {
  const { toast } = useToast();
  const [params] = useSearchParams();
  const [rules, setRules] = useState(null);
  const [saved, setSaved] = useState('[]');
  const [saving, setSaving] = useState(false);
  const [datasources, setDatasources] = useState([]);
  const [datapoints, setDatapoints] = useState([]);
  const [form, setForm] = useState({ ...blankRule, datasource: params.get('datasource') || '', datapoint: params.get('datapoint') || '' });
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [counts, setCounts] = useState({});
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    client.get('/logicmonitor/raw-rules', { params: { _: Date.now() } })
      .then(({ data }) => { const r = arr(data?.rules); setRules(r); setSaved(JSON.stringify(r)); })
      .catch(() => { setLoadError(true); setRules([]); });
    client.get('/logicmonitor/datasources').then(({ data }) => setDatasources(arr(data))).catch(() => setDatasources([]));
  }, []);

  useEffect(() => {
    if (!form.datasource) { setDatapoints([]); return; }
    client.get(`/logicmonitor/datasources/${encodeURIComponent(form.datasource)}/datapoints`)
      .then(({ data }) => setDatapoints(arr(data))).catch(() => setDatapoints([]));
  }, [form.datasource]);

  const dirty = rules != null && JSON.stringify(rules) !== saved;
  const setF = (patch) => { setForm((f) => ({ ...f, ...patch })); setPreview(null); };
  const valueOk = form.value !== '' && Number.isFinite(Number(form.value));
  const formOk = form.datasource && form.datapoint && valueOk;

  const ruleBody = (f) => {
    const r = { datasource: f.datasource, datapoint: f.datapoint, op: f.op, value: Number(f.value), severity: f.severity, enabled: true };
    if (f.label.trim()) r.label = f.label.trim();
    if (f.instanceMatch.trim()) r.instanceMatch = f.instanceMatch.trim();
    if (f.deviceMatch.trim()) r.deviceMatch = f.deviceMatch.trim();
    return r;
  };

  const runPreview = async (rule) => {
    try {
      const { data } = await client.post('/logicmonitor/raw-rules/preview', { rule });
      return data || { matches: 0, sample: [] };
    } catch (err) {
      if (err?.response?.status === 403) toast({ type: 'error', title: 'The demo refuses changes' });
      else toast({ type: 'error', title: 'Preview failed', message: err?.response?.data?.error });
      return null;
    }
  };

  const doPreview = async () => {
    setPreviewing(true);
    const r = await runPreview(ruleBody(form));
    if (r) setPreview(r);
    setPreviewing(false);
  };

  const countFor = async (rule) => {
    setCounts((c) => ({ ...c, [rule.id]: '...' }));
    const r = await runPreview(rule);
    setCounts((c) => ({ ...c, [rule.id]: r ? r.matches : '-' }));
  };

  const add = () => {
    const rule = { id: `r-${Date.now().toString(36)}`, ...ruleBody(form) };
    setRules((cur) => [...(cur || []), rule]);
    setForm({ ...blankRule });
    setPreview(null);
  };

  const patchRule = (id, patch) => setRules((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (r) => {
    if (!window.confirm(`Delete the rule on ${r.datasource} / ${r.datapoint}? It applies when you press Save.`)) return;
    setRules((cur) => cur.filter((x) => x.id !== r.id));
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await client.put('/logicmonitor/raw-rules', { rules });
      const next = Array.isArray(data?.rules) ? data.rules : rules;
      setRules(next); setSaved(JSON.stringify(next)); setCounts({});
      toast({ type: 'success', title: 'Raw rules saved', message: 'Issues were re-evaluated.' });
    } catch (err) {
      if (err?.response?.status === 403) toast({ type: 'error', title: 'The demo refuses changes' });
      else toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const dpRow = datapoints.find((d) => d.datapoint === form.datapoint);

  return (
    <SectionPanel icon={ListChecks} title="Raw datapoints"
      blurb="Raise an ICC issue from any datapoint in the raw store, no catalog change needed.">
      {rules == null ? <LoadingPanel label="Loading rules..." height={100} /> : (
        <>
          {loadError && <p className="text-xs text-ink-muted mb-2">Rules are not available until the backend is updated.</p>}
          <p className="text-xs font-semibold text-ink mb-1">{`Saved rules (${rules.length})`}</p>
          {rules.length === 0 ? <p className="text-xs text-ink-muted mb-3">No rules yet.</p> : (
            <div className="overflow-x-auto mb-3">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <th className="py-1.5 pr-3">On</th><th className="py-1.5 pr-3">DataSource</th><th className="py-1.5 pr-3">Datapoint</th>
                  <th className="py-1.5 pr-3">Condition</th><th className="py-1.5 pr-3">Severity</th><th className="py-1.5 pr-3">Label</th>
                  <th className="py-1.5 pr-3 text-right">Matches</th><th className="py-1.5 pr-3"></th>
                </tr></thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-b border-cohesity-border/40">
                      <td className="py-1.5 pr-3"><input type="checkbox" className="accent-brand cursor-pointer" checked={r.enabled !== false} onChange={(e) => patchRule(r.id, { enabled: e.target.checked })} aria-label="Enabled" /></td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink truncate max-w-[220px]" title={r.datasource}>{r.datasource}</td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink-muted font-mono">{r.datapoint}</td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink tnum whitespace-nowrap">{`${r.op} ${r.value}`}</td>
                      <td className="py-1.5 pr-3"><Badge tone={severityTone(r.severity)}>{r.severity}</Badge></td>
                      <td className="py-1.5 pr-3 text-[12px] text-ink-muted truncate max-w-[200px]" title={r.label || ''}>{r.label || '-'}</td>
                      <td className="py-1.5 pr-3 text-right text-[12px] tnum text-ink-muted">
                        {counts[r.id] != null ? counts[r.id] : <button type="button" onClick={() => countFor(r)} className="text-brand hover:underline cursor-pointer">Check</button>}
                      </td>
                      <td className="py-1.5 pr-3 text-right"><button type="button" onClick={() => remove(r)} aria-label="Delete rule" className="text-ink-faint hover:text-red-400 cursor-pointer"><Trash2 size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="border-t border-cohesity-border/50 pt-3">
            <p className="text-xs font-semibold text-ink mb-2">Add a rule</p>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-ds">DataSource</label>
                <select id="rr-ds" value={form.datasource} onChange={(e) => setF({ datasource: e.target.value, datapoint: '' })} className={`${sel} w-full`}>
                  <option value="">Pick a DataSource...</option>
                  {form.datasource && !datasources.some((d) => d.name === form.datasource) && <option value={form.datasource}>{form.datasource}</option>}
                  {datasources.map((d) => <option key={d.name} value={d.name}>{`${d.name} (${fmtNum(d.instances)} instances)`}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-dp">Datapoint</label>
                <select id="rr-dp" value={form.datapoint} onChange={(e) => setF({ datapoint: e.target.value })} className={`${sel} w-full`} disabled={!form.datasource}>
                  <option value="">Pick a datapoint...</option>
                  {form.datapoint && !dpRow && <option value={form.datapoint}>{form.datapoint}</option>}
                  {datapoints.map((d) => (
                    <option key={d.datapoint} value={d.datapoint}>
                      {`${d.datapoint} (sample: ${arr(d.samples).join(', ') || '-'})${d.catalogMetric ? ' - in catalog' : ''}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="w-28">
                  <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-op">Operator</label>
                  <select id="rr-op" value={form.op} onChange={(e) => setF({ op: e.target.value })} className={`${sel} w-full`}>
                    {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-val">Value</label>
                  <input id="rr-val" type="number" step="any" value={form.value} onChange={(e) => setF({ value: e.target.value })} className={inp} />
                </div>
                <div className="w-32">
                  <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-sev">Severity</label>
                  <select id="rr-sev" value={form.severity} onChange={(e) => setF({ severity: e.target.value })} className={`${sel} w-full`}>
                    {SEVS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-label">Label (optional)</label>
                <input id="rr-label" type="text" value={form.label} onChange={(e) => setF({ label: e.target.value })} className={inp} maxLength={120} placeholder="Shown in the issue message" />
              </div>
              <div>
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-inst">Instance regex (optional)</label>
                <input id="rr-inst" type="text" value={form.instanceMatch} onChange={(e) => setF({ instanceMatch: e.target.value })} className={inp} spellCheck={false} />
              </div>
              <div>
                <label className="block text-[11px] text-ink-faint mb-1" htmlFor="rr-dev">Device regex (optional)</label>
                <input id="rr-dev" type="text" value={form.deviceMatch} onChange={(e) => setF({ deviceMatch: e.target.value })} className={inp} spellCheck={false} />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <button type="button" onClick={doPreview} disabled={!formOk || previewing} className={btnGhost}>{previewing ? 'Previewing...' : 'Preview'}</button>
              <button type="button" onClick={add} disabled={!formOk} className={btnGhost}><Plus size={13} className="inline mr-1" />Add rule</button>
              {preview && <span className="text-xs text-ink-muted tnum">{`${fmtNum(preview.matches)} match${preview.matches === 1 ? '' : 'es'}`}</span>}
            </div>
            {preview && arr(preview.sample).length > 0 && (
              <div className="overflow-x-auto max-h-56 overflow-y-auto mt-2">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}><th className="py-1 pr-3">Device</th><th className="py-1 pr-3">Instance</th><th className="py-1 pr-3 text-right">Value</th></tr></thead>
                  <tbody>
                    {preview.sample.map((r, i) => (
                      <tr key={i} className="border-b border-cohesity-border/40">
                        <td className="py-1 pr-3 text-[12px] text-ink">{r.deviceName}</td>
                        <td className="py-1 pr-3 text-[12px] text-ink-muted">{r.instanceName || '-'}</td>
                        <td className="py-1 pr-3 text-right text-[12px] tnum text-ink-muted">{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="mt-4">
            <button type="button" onClick={save} disabled={saving || !dirty} className={btnPrimary}>{saving ? 'Saving...' : 'Save rules'}</button>
            {dirty && <span className="text-[10px] text-amber-400 ml-2">unsaved</span>}
          </div>
        </>
      )}
    </SectionPanel>
  );
}
