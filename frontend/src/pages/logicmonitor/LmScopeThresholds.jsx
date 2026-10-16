import { useEffect, useState, useMemo } from 'react';
import { FolderTree } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { fmtNum } from './helpers';
import { SectionPanel, inp, sel, btnPrimary } from './ui';

const NETWORK_ROLES = [
  ['switch', 'Switches'], ['router', 'Routers'], ['firewall', 'Firewalls'], ['load-balancer', 'Load balancers'], ['wireless', 'Wireless'],
];

// DataSource metric families the metrics tier can collect (ids match the
// backend catalog FAMILIES). Labels and counts from /metrics/families override
// these when the route answers.
const METRIC_FAMILIES = [
  ['firewall', 'Firewalls', 'Palo Alto, Cisco ASA and Meraki: sessions, HA, tunnels, GlobalProtect, load.'],
  ['loadbalancer', 'Load balancers', 'F5 BIG-IP and GTM: failover, pools, wide IPs, daemons, certificates.'],
  ['health', 'Device health', 'CPU, memory, power supplies, fans, temperature, line cards, PoE, filesystems.'],
  ['optics', 'Optics', 'Transceiver receive and transmit power, temperature, current and voltage.'],
  ['routing', 'Routing', 'BGP peers, OSPF neighbours and EIGRP peers.'],
  ['ipsla', 'IP SLA', 'Round-trip time, jitter, loss and MOS from IP SLA operations.'],
  ['voice', 'Voice', 'SIP counters, session border controller health and ISDN channels.'],
  ['wireless', 'Wireless', 'Controller HA, APs, radios and RF, SSID clients, RADIUS, mobility and AP uplinks.'],
  ['cloud', 'Cloud circuits', 'AWS Direct Connect connections and virtual interfaces, Azure ExpressRoute circuits: state, BGP and throughput.'],
  ['cohesity', 'Cohesity (via LogicMonitor)', 'Cohesity clusters LogicMonitor monitors: cluster health, capacity, nodes, services, fans and power supplies.'],
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
  const [families, setFamilies] = useState(null); // null = every family on
  const [famInfo, setFamInfo] = useState({});

  const source = (sources || []).find((s) => String(s.id) === String(sourceId)) || (sources || [])[0];

  useEffect(() => {
    if (!source) return;
    setSourceId(String(source.id));
    setPicked(new Set((source.groupFilter || []).map(Number)));
    setRoles(Array.isArray(source.interfaceCategories) ? source.interfaceCategories : null);
    setFamilies(Array.isArray(source.metricsFamilies) ? source.metricsFamilies : null);
    setGroups(null);
    const rule = readSiteRule(source);
    setSiteRoots(rule.roots);
    setSiteProperty(rule.property);
    setSiteHostname(rule.fromHostname);
    setRuleTouched(false);
    client.get(`/logicmonitor/sources/${source.id}/groups`)
      .then(({ data }) => setGroups((Array.isArray(data) ? data : []).slice().sort((a, b) => String(a.fullPath || a.name).localeCompare(String(b.fullPath || b.name)))))
      .catch(() => setGroups([]));
    client.get('/logicmonitor/metrics/families', { params: { sourceId: source.id } })
      .then(({ data }) => setFamInfo(Object.fromEntries((Array.isArray(data) ? data : []).filter((f) => f && f.family).map((f) => [f.family, f]))))
      .catch(() => setFamInfo({}));
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

  const toggleFamily = (id) => setFamilies((cur) => {
    const base = cur || METRIC_FAMILIES.map(([v]) => v);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    return next.length === METRIC_FAMILIES.length ? null : next;
  });

  const save = async () => {
    if (!source) return;
    setSaving(true);
    try {
      const body = { groupFilter: [...picked], interfaceCategories: roles, metricsFamilies: families };
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
        <p className="text-xs font-semibold text-ink mb-1">Metric families</p>
        <p className="text-[11px] text-ink-muted mb-3 leading-relaxed">The DataSource metrics tier reads one data call per device and DataSource for every family ticked here. Untick a family to stop collecting it; values already stored stay until they age out. {families == null ? 'All families are collected.' : `${families.length} of ${METRIC_FAMILIES.length} families collected.`}</p>
        <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-2">
          {METRIC_FAMILIES.map(([id, label, blurb]) => {
            const info = famInfo[id];
            return (
              <label key={id} className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={families == null || families.includes(id)} onChange={() => toggleFamily(id)} />
                <span>
                  <span className="font-semibold">{info?.label || label}</span>
                  {info && info.instances != null ? <span className="text-ink-faint tnum"> ({fmtNum(info.datasources)} DataSources, {fmtNum(info.instances)} instances)</span> : null}
                  <span className="block text-[11px] text-ink-faint leading-snug">{blurb}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="mt-5 pt-4 border-t border-cohesity-border/50">
        <p className="text-xs font-semibold text-ink mb-1">Site rules</p>
        <p className="text-[11px] text-ink-faint mb-1">Site rules are set here only.</p>
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
