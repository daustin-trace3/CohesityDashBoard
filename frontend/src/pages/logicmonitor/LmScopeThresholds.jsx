import { useEffect, useState, useMemo } from 'react';
import { FolderTree, Gauge } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { fmtNum } from './helpers';
import { SectionPanel, inp, sel, btnPrimary } from './ui';

const NETWORK_ROLES = [
  ['switch', 'Switches'], ['router', 'Routers'], ['firewall', 'Firewalls'], ['load-balancer', 'Load balancers'], ['wireless', 'Wireless'],
];

// The per-portal site rule arrives as an object (siteRule) or its JSON text.
function readSiteRule(source) {
  let r = source?.siteRule ?? source?.siteRuleJson ?? source?.site_rule_json ?? null;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
  r = r && typeof r === 'object' ? r : {};
  const roots = r.roots ?? r.site_group_roots;
  return {
    roots: Array.isArray(roots) ? roots.join(',') : (typeof roots === 'string' ? roots : ''),
    property: r.property ?? r.site_property ?? '',
    fromHostname: (r.fromHostname ?? r.site_from_hostname) !== false,
  };
}

export function LmScopePanel({ sources, reload }) {
  const { toast } = useToast();
  const [sourceId, setSourceId] = useState('');
  const [groups, setGroups] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [roles, setRoles] = useState(null); // null = all
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  const [siteRoots, setSiteRoots] = useState('');
  const [siteProperty, setSiteProperty] = useState('');
  const [siteHostname, setSiteHostname] = useState(true);
  const [ruleTouched, setRuleTouched] = useState(false);

  const source = (sources || []).find((s) => String(s.id) === String(sourceId)) || (sources || [])[0];

  useEffect(() => {
    if (!source) return;
    setSourceId(String(source.id));
    setPicked(new Set((source.groupFilter || []).map(Number)));
    setRoles(Array.isArray(source.interfaceCategories) ? source.interfaceCategories : null);
    setGroups(null);
    const rule = readSiteRule(source);
    setSiteRoots(rule.roots);
    setSiteProperty(rule.property);
    setSiteHostname(rule.fromHostname);
    setRuleTouched(false);
    client.get(`/logicmonitor/sources/${source.id}/groups`)
      .then(({ data }) => setGroups((Array.isArray(data) ? data : []).slice().sort((a, b) => String(a.fullPath || a.name).localeCompare(String(b.fullPath || b.name)))))
      .catch(() => setGroups([]));
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (groups || []).filter((g) => !term || String(g.fullPath || g.name).toLowerCase().includes(term));
  }, [groups, q]);

  // LM's hostGroupIds lists a device's direct groups only, so ticking a
  // group ticks every group under it too; otherwise a device that sits in a
  // subgroup would fall out of scope.
  const toggle = (g) => {
    const path = String(g.fullPath || g.name);
    const under = (groups || []).filter((x) => String(x.fullPath || x.name) === path || String(x.fullPath || x.name).startsWith(`${path}/`)).map((x) => Number(x.id));
    setPicked((cur) => {
      const next = new Set(cur);
      if (cur.has(Number(g.id))) under.forEach((id) => next.delete(id)); else under.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleRole = (r) => setRoles((cur) => {
    const base = cur || NETWORK_ROLES.map(([v]) => v);
    const next = base.includes(r) ? base.filter((x) => x !== r) : [...base, r];
    return next.length === NETWORK_ROLES.length ? null : next;
  });

  const save = async () => {
    if (!source) return;
    setSaving(true);
    try {
      const body = { groupFilter: [...picked], interfaceCategories: roles };
      if (ruleTouched) {
        body.siteRule = {
          roots: siteRoots.split(',').map((x) => x.trim()).filter(Boolean),
          property: siteProperty.trim(),
          fromHostname: siteHostname,
        };
      }
      await client.put(`/logicmonitor/sources/${source.id}`, body);
      toast({ type: 'success', title: 'Scope saved', message: 'Applies from the next poll.' });
      await reload();
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  if (sources == null) return <LoadingPanel label="Loading..." height={100} />;
  if (!source) return <SectionPanel icon={FolderTree} title="Scope"><p className="text-sm text-ink-muted py-4 text-center">Connect a portal first.</p></SectionPanel>;

  return (
    <SectionPanel icon={FolderTree} title="Scope"
      blurb="Limit which devices ICC collects. With no group ticked the whole portal is collected. The interface roles decide which network devices the interface poll reads (one data call per device per interval).">
      {sources.length > 1 && (
        <div className="mb-3">
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={sel}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}
      <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs font-semibold text-ink">Device groups</p>
            <span className="text-[11px] text-ink-faint">{picked.size ? `${picked.size} selected` : 'whole portal'}</span>
            {picked.size > 0 && <button onClick={() => setPicked(new Set())} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Clear (whole portal)</button>}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter groups..." className={`${inp} mb-2`} spellCheck={false} />
          {groups == null ? <LoadingPanel label="Loading groups..." height={80} /> : groups.length === 0 ? (
            <p className="text-sm text-ink-muted py-3">No groups stored yet. They arrive with the first poll.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto border border-cohesity-border rounded-lg p-2">
              {shown.map((g) => {
                const path = String(g.fullPath || g.name);
                const depth = path.split('/').length - 1;
                return (
                  <label key={g.id} className="flex items-center gap-2 py-0.5 text-xs text-ink cursor-pointer hover:bg-surface-overlay/60 rounded" style={{ paddingLeft: depth * 16 }}>
                    <input type="checkbox" checked={picked.has(Number(g.id))} onChange={() => toggle(g)} />
                    <span className="truncate">{g.name || path}</span>
                    <span className="text-[10px] text-ink-faint tnum ml-auto pr-1">{fmtNum(g.numOfHosts)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold text-ink mb-2">Interface poll roles</p>
          <div className="flex flex-col gap-1.5">
            {NETWORK_ROLES.map(([v, l]) => (
              <label key={v} className="flex items-center gap-2 text-xs text-ink cursor-pointer">
                <input type="checkbox" checked={roles == null || roles.includes(v)} onChange={() => toggleRole(v)} /> {l}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-ink-faint mt-2">{roles == null ? 'All network roles are polled.' : `${roles.length} of ${NETWORK_ROLES.length} roles polled.`}</p>
        </div>
      </div>
      <div className="mt-5 pt-4 border-t border-cohesity-border/50">
        <p className="text-xs font-semibold text-ink mb-1">Site rules</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">A device's site comes from the first rule that matches: a device group under one of the roots below (the next folder is the site), then the device property, then the hostname prefix before the first dash. Leave a field blank to use the global default.</p>
        <div className="grid md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Group roots (comma list)</label>
            <input value={siteRoots} onChange={(e) => { setSiteRoots(e.target.value); setRuleTouched(true); }} placeholder="Network,Sites,Locations,Branch" className={inp} spellCheck={false} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1">Site property</label>
            <input value={siteProperty} onChange={(e) => { setSiteProperty(e.target.value); setRuleTouched(true); }} placeholder="site" className={inp} spellCheck={false} />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink cursor-pointer self-end h-[38px]">
            <input type="checkbox" checked={siteHostname} onChange={(e) => { setSiteHostname(e.target.checked); setRuleTouched(true); }} /> Use the hostname prefix as the last resort
          </label>
        </div>
      </div>
      <button onClick={save} disabled={saving} className={`${btnPrimary} mt-4`}>{saving ? 'Saving...' : 'Save scope'}</button>
    </SectionPanel>
  );
}

const THRESHOLD_GROUPS = [
  { title: 'Interfaces', keys: [
    ['lm_if_util_warn_pct', 'Utilization warning (%)'],
    ['lm_if_err_warn', 'Errors in 24 h before warning'],
    ['lm_if_flap_warn', 'Status changes in 24 h counted as flapping'],
  ] },
  { title: 'Devices and alerts', keys: [
    ['lm_dead_grace_min', 'Dead device grace (minutes)'],
    ['lm_alert_storm_count', 'Alerts in 15 minutes counted as a storm'],
    ['lm_new_device_days', 'New device window (days)'],
  ] },
  { title: 'Site reachability', keys: [
    ['lm_check_baseline_days', 'Baseline window (days)'],
    ['lm_check_baseline_min_samples', 'Samples before anomalies are judged'],
    ['lm_check_latency_k', 'Latency spread multiplier (k x MAD)'],
    ['lm_check_latency_floor_ms', 'Latency MAD floor (ms)'],
    ['lm_check_latency_min_ms', 'Ignore latency below (ms)'],
    ['lm_check_loss_min_pct', 'Loss anomaly minimum (%)'],
    ['lm_check_loss_crit_pct', 'Loss critical at (%)'],
    ['lm_check_location_fold', 'Checks failing at one location to fold into one issue'],
    ['lm_check_data_calls_per_tick', 'Check data calls per poll'],
  ] },
  { title: 'Sites and path', keys: [
    ['lm_site_group_roots', 'Group roots that name a site (comma list)', 'text'],
    ['lm_site_property', 'Device property that names a site', 'text'],
    ['lm_site_from_hostname', 'Use the hostname prefix when nothing else names a site', 'toggle'],
    ['lm_path_max_hops', 'Maximum hops in a server path'],
    ['lm_shadow_enabled', 'Hold back alerts behind a failed upstream device', 'toggle'],
  ] },
  { title: 'Circuits', keys: [
    ['lm_circuit_sat_pct', 'Saturated at p95 of (%)'],
    ['lm_circuit_crit_pct', 'Critical when the daily max reaches (%) three days running'],
    ['lm_circuit_sat_days', 'Saturation window (days)'],
    ['lm_wan_overrides', 'Force or exclude WAN ports (device:port list, ! prefix excludes)', 'text'],
  ] },
  { title: 'Interface anomalies', keys: [
    ['lm_if_baseline_days', 'Baseline window (days)'],
    ['lm_if_baseline_min_samples', 'Samples before anomalies are judged'],
    ['lm_if_anomaly_k', 'Spread multiplier (k x MAD)'],
    ['lm_if_anomaly_util_min_pct', 'Ignore utilization below (%)'],
    ['lm_if_anomaly_err_min', 'Ignore errors below'],
    ['lm_backup_overlay_util_pct', 'Backup run counted as saturating a port at (%)'],
  ] },
  { title: 'Webhook', keys: [
    ['lm_webhook_rate_per_min', 'Webhook deliveries accepted per minute'],
  ] },
  { title: 'Retention', keys: [
    ['lm_alert_retention_days', 'Cleared alerts (days)'],
    ['lm_interface_history_days', 'Interface history (days)'],
    ['lm_check_history_days', 'Check history (days)'],
  ] },
];

const TEXT_KEYS = new Set(THRESHOLD_GROUPS.flatMap((g) => g.keys.filter((k) => k[2] === 'text').map((k) => k[0])));
const TOGGLE_KEYS = new Set(THRESHOLD_GROUPS.flatMap((g) => g.keys.filter((k) => k[2] === 'toggle').map((k) => k[0])));

export function LmThresholdsPanel() {
  const { toast } = useToast();
  const [values, setValues] = useState(null);
  const [ranges, setRanges] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client.get('/logicmonitor/config')
      .then(({ data }) => { setValues({ ...(data?.thresholds || {}) }); setRanges(data?.ranges || {}); })
      .catch(() => setValues({}));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === '' || v == null) continue;
        if (TEXT_KEYS.has(k)) body[k] = String(v);
        else if (TOGGLE_KEYS.has(k)) body[k] = typeof v === 'string' ? (Number(v) ? '1' : '0') : (Number(v) ? 1 : 0);
        else body[k] = Number(v);
      }
      const { data } = await client.put('/logicmonitor/config', body);
      if (data?.thresholds) setValues({ ...data.thresholds });
      toast({ type: 'success', title: 'Thresholds saved', message: 'Out-of-range values were clamped to their limits.' });
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionPanel icon={Gauge} title="Thresholds"
      blurb="Rules ICC uses to raise LogicMonitor issues (Issues page, Service Status, Ops Agent and email). These are ICC's own rules on top of LogicMonitor's alerts.">
      {values == null ? <LoadingPanel label="Loading..." height={100} /> : (
        <>
          {THRESHOLD_GROUPS.map((grp) => (
            <div key={grp.title} className="mb-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">{grp.title}</p>
              <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
                {grp.keys.map(([k, label, kind]) => {
                  const r = ranges[k] || {};
                  if (kind === 'toggle') {
                    return (
                      <label key={k} className="flex items-center gap-2 text-xs font-semibold text-ink cursor-pointer self-end h-[38px]">
                        <input type="checkbox" checked={values[k] == null || values[k] === '' ? true : !!Number(values[k])} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.checked ? '1' : '0' }))} /> {label}
                      </label>
                    );
                  }
                  if (kind === 'text') {
                    return (
                      <div key={k}>
                        <label className="block text-xs font-semibold text-ink mb-1">{label}</label>
                        <input type="text" value={values[k] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} className={inp} spellCheck={false} />
                      </div>
                    );
                  }
                  return (
                    <div key={k}>
                      <label className="block text-xs font-semibold text-ink mb-1">{label}</label>
                      <input type="number" min={r.min} max={r.max} value={values[k] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} className={inp} />
                      {(r.min != null || r.default != null) && (
                        <p className="text-[10px] text-ink-faint mt-0.5">{r.min != null ? `${r.min} to ${r.max}` : ''}{r.default != null ? `, default ${r.default}` : ''}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving...' : 'Save thresholds'}</button>
        </>
      )}
    </SectionPanel>
  );
}
