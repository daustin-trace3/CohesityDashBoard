import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  AppWindow, MonitorSmartphone, Power, Layers, GitCommitVertical, Boxes, Cpu, HelpCircle, ScanSearch,
} from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TablePager, TableControls, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';
import { VmDetailModal } from './VmModals';

const SECTIONS = ['releases', 'versions', 'vms'];
const FAMILY_ORDER = ['windows', 'linux', 'other', 'unknown'];
const FAMILY_LABEL = { windows: 'Windows', linux: 'Linux', other: 'Other', unknown: 'Unknown' };
const FAMILY_BORDER = {
  windows: 'border-l-status-info',
  linux: 'border-l-brand',
  other: 'border-l-ink-faint',
  unknown: 'border-l-ink-faint',
};
const OUTDATED_TOOLS = new Set(['guestToolsNeedUpgrade', 'guestToolsTooOld', 'guestToolsBlacklisted', 'guestToolsSupportedOld']);
const SOURCE_LABEL = { 'tools-detailed': 'Tools detail', tools: 'Tools', configured: 'Configured', none: 'None' };
const SOURCE_TONE = { 'tools-detailed': 'ok', tools: 'info', configured: 'neutral', none: 'neutral' };
const MAX_VC_COLUMNS = 8;

const isOn = (v) => String(v.power_state || '').toUpperCase() === 'POWERED_ON';
const powerLabel = (ps) => {
  const s = String(ps || '').toUpperCase();
  if (s === 'POWERED_ON') return 'On';
  if (s === 'POWERED_OFF') return 'Off';
  if (s === 'SUSPENDED') return 'Suspended';
  return ps ? String(ps) : 'Unknown';
};
const fmtMem = (mb) => {
  if (mb == null) return '-';
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
};
const toolsLabel = (t) => (t ? String(t).replace(/^guestTools/, '') : '-');

function Section({ icon: Icon, title, children }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {children}
    </div>
  );
}

function NavChip({ count }) {
  if (!count) return null;
  return <span className="ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-surface-overlay text-ink-faint">{count}</span>;
}

function SourceBadge({ source }) {
  return <Badge tone={SOURCE_TONE[source] || 'neutral'} className="whitespace-nowrap">{SOURCE_LABEL[source] || source || 'None'}</Badge>;
}

// Per-vCenter counts as text, used when there are too many vCenters for columns.
function vcText(byVc, vcs) {
  return vcs.filter((vc) => byVc[vc.id]).map((vc) => `${vc.name} ${byVc[vc.id]}`).join(', ') || '-';
}

export default function VcGuestOsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detailVmId, setDetailVmId] = useState(null);

  const rawSection = searchParams.get('section');
  const section = SECTIONS.includes(rawSection) ? rawSection : 'releases';
  const vcParam = searchParams.get('vc') || '';
  const osParam = searchParams.get('os') || '';

  const setParam = useCallback((k, v) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set(k, v); else next.delete(k);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const load = useCallback(() => client.get('/vcenter/guest-os', { params: { _: Date.now() } })
    .then(({ data: d }) => {
      if (!d || typeof d !== 'object' || !Array.isArray(d.vms) || !Array.isArray(d.vcenters)) {
        setData({ vms: [], vcenters: [] });
        setLoadError('The server did not return guest OS data. The dashboard service is probably still running the previous version and needs a restart.');
        return;
      }
      setLoadError(null);
      setData(d);
      setLastRefreshed(new Date());
    })
    .catch((err) => {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || 'request failed';
      setData({ vms: [], vcenters: [] });
      setLoadError(`Could not load guest OS data${status ? ` (HTTP ${status})` : ''}: ${detail}`);
      toast({ type: 'error', title: 'Failed to load guest OS data' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const allVcs = useMemo(() => data?.vcenters || [], [data]);
  const allVms = useMemo(() => data?.vms || [], [data]);

  const selected = useMemo(() => {
    const ids = new Set(vcParam.split(',').map((s) => s.trim()).filter(Boolean));
    return new Set(allVcs.filter((vc) => ids.has(String(vc.id))).map((vc) => vc.id));
  }, [vcParam, allVcs]);

  const toggleVc = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setParam('vc', allVcs.filter((vc) => next.has(vc.id)).map((vc) => vc.id).join(','));
  };

  // Groups (settings-managed tags) and sites (capacity sites, read-only). An old backend sends neither.
  const groups = useMemo(() => (Array.isArray(data?.groups) ? data.groups : []), [data]);
  const sites = useMemo(() => (Array.isArray(data?.sites) ? data.sites : []), [data]);
  const knownVcIds = useMemo(() => new Set(allVcs.map((vc) => vc.id)), [allVcs]);
  const memberIdsOf = (g) => (g.vcenterIds || []).filter((id) => knownVcIds.has(id));
  const isLit = (g) => {
    const ids = memberIdsOf(g);
    return selected.size > 0 && ids.length > 0 && ids.every((id) => selected.has(id));
  };
  const pickGroup = (g, e) => {
    const ids = memberIdsOf(g);
    if (!ids.length) return;
    let next;
    if (isLit(g)) {
      next = new Set(selected);
      ids.forEach((id) => next.delete(id));
    } else if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      next = new Set(selected);
      ids.forEach((id) => next.add(id));
    } else {
      next = new Set(ids);
    }
    setParam('vc', allVcs.filter((vc) => next.has(vc.id)).map((vc) => vc.id).join(','));
  };

  const visibleVcs = useMemo(() => (selected.size ? allVcs.filter((vc) => selected.has(vc.id)) : allVcs), [allVcs, selected]);

  const vms = useMemo(() => {
    const list = selected.size ? allVms.filter((v) => selected.has(v.vcenter_id)) : allVms;
    return list.map((v) => ({
      ...v,
      power: powerLabel(v.power_state),
      tools_outdated: OUTDATED_TOOLS.has(v.tools_version_status),
    }));
  }, [allVms, selected]);

  const summary = useMemo(() => {
    const s = { vms: vms.length, poweredOn: 0, windows: 0, linux: 0, other: 0, unknown: 0, detailed: 0, toolsReported: 0, configuredOnly: 0, toolsOutdated: 0 };
    for (const v of vms) {
      if (isOn(v)) s.poweredOn += 1;
      if (v.family === 'windows') s.windows += 1;
      else if (v.family === 'linux') s.linux += 1;
      else if (v.family === 'other') s.other += 1;
      else s.unknown += 1;
      if (v.source === 'tools-detailed') s.detailed += 1;
      else if (v.source === 'tools') s.toolsReported += 1;
      else s.configuredOnly += 1;
      if (v.tools_outdated) s.toolsOutdated += 1;
    }
    return s;
  }, [vms]);

  const releases = useMemo(() => {
    const m = new Map();
    for (const v of vms) {
      const key = v.label || 'Unknown';
      let r = m.get(key);
      if (!r) {
        r = { label: key, family: v.family || 'unknown', product: v.product, vms: 0, poweredOn: 0, toolsOutdated: 0, byVc: {}, versionSet: new Set() };
        m.set(key, r);
      }
      r.vms += 1;
      if (isOn(v)) r.poweredOn += 1;
      if (v.tools_outdated) r.toolsOutdated += 1;
      r.byVc[v.vcenter_id] = (r.byVc[v.vcenter_id] || 0) + 1;
      r.versionSet.add(v.versionLabel || key);
    }
    const famRank = (f) => { const i = FAMILY_ORDER.indexOf(f); return i < 0 ? FAMILY_ORDER.length : i; };
    return [...m.values()]
      .map((r) => {
        const row = { ...r, versionCount: r.versionSet.size, familyLabel: FAMILY_LABEL[r.family] || r.family };
        for (const vc of allVcs) row[`vc_${vc.id}`] = r.byVc[vc.id] || 0;
        return row;
      })
      .sort((a, b) => famRank(a.family) - famRank(b.family) || b.vms - a.vms || a.label.localeCompare(b.label));
  }, [vms, allVcs]);

  const versions = useMemo(() => {
    const m = new Map();
    for (const v of vms) {
      const key = v.versionLabel || v.label || 'Unknown';
      let r = m.get(key);
      if (!r) {
        r = { versionLabel: key, label: v.label || 'Unknown', family: v.family || 'unknown', vms: 0, poweredOn: 0, byVc: {}, detailed: 0, tools: 0, configured: 0 };
        m.set(key, r);
      }
      r.vms += 1;
      if (isOn(v)) r.poweredOn += 1;
      r.byVc[v.vcenter_id] = (r.byVc[v.vcenter_id] || 0) + 1;
      if (v.source === 'tools-detailed') r.detailed += 1;
      else if (v.source === 'tools') r.tools += 1;
      else r.configured += 1;
    }
    return [...m.values()].map((r) => {
      const row = { ...r, familyLabel: FAMILY_LABEL[r.family] || r.family };
      for (const vc of allVcs) row[`vc_${vc.id}`] = r.byVc[vc.id] || 0;
      return row;
    }).sort((a, b) => b.vms - a.vms || a.versionLabel.localeCompare(b.versionLabel));
  }, [vms, allVcs]);

  const relCtl = useTableControls(releases, { defaultSortKey: 'vms', defaultSortDir: 'desc', paginate: true });
  const verCtl = useTableControls(versions, { searchKeys: ['versionLabel', 'label', 'familyLabel'], defaultSortKey: 'vms', defaultSortDir: 'desc', paginate: true });
  const vmCtl = useTableControls(vms, {
    searchKeys: ['name', 'host_name', 'cluster_name', 'label', 'versionLabel'],
    defaultSortKey: 'name', paginate: true,
  });

  // ?os= is the single source of truth for the OS filter: the URL drives the
  // table filter, and the dropdown writes to the URL (never the other way
  // round, which raced on first render and cleared the tile's pick).
  useEffect(() => {
    if ((vmCtl.filters.label || '') !== osParam) vmCtl.setFilter('label', osParam);
  }, [osParam]); // eslint-disable-line react-hooks/exhaustive-deps
  const vmControls = useMemo(() => ({
    ...vmCtl,
    setFilter: (k, v) => { if (k === 'label') setParam('os', v || ''); else vmCtl.setFilter(k, v); },
  }), [vmCtl, setParam]);

  const activeOs = osParam;
  const pickRelease = (label) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (activeOs === label) { next.delete('os'); } else { next.set('os', label); next.set('section', 'vms'); }
      return next;
    }, { replace: true });
  };
  const setSection = (id) => setParam('section', id);

  const detailPct = summary.vms ? summary.detailed / summary.vms : 0;
  const useColumns = visibleVcs.length <= MAX_VC_COLUMNS;

  const nav = [
    { id: 'releases', label: 'Releases', icon: Layers, count: releases.length },
    { id: 'versions', label: 'Versions', icon: GitCommitVertical, count: versions.length },
    { id: 'vms', label: 'Virtual machines', icon: MonitorSmartphone, count: vmCtl.rows.length },
  ];

  const tiles = releases; // already ordered by family then count desc

  if (data == null) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={AppWindow} title="Guest OS" description="Every VM by guest operating system and version, with totals that follow the vCenter selection" />
        <LoadingPanel label="Loading guest OS data..." height={300} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="animate-fade-in">
        <PageHeader icon={AppWindow} title="Guest OS" description="Every VM by guest operating system and version, with totals that follow the vCenter selection">
          <RefreshButton onClick={load} />
        </PageHeader>
        <div className="panel p-8 text-center text-sm text-status-crit" style={{ borderTop: `3px solid ${BRAND}` }}>{loadError}</div>
      </div>
    );
  }

  const vcCountCols = useColumns ? visibleVcs : [];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={AppWindow} title="Guest OS" description="Every VM by guest operating system and version, with totals that follow the vCenter selection">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {allVcs.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-muted" style={{ borderTop: `3px solid ${BRAND}` }}>
          No vCenters are registered yet. Add one under Settings and let it poll.
        </div>
      ) : (
        <>
          <div className="panel p-3 mb-4">
            {groups.length === 0 && sites.length === 0 ? (
              <p className="text-[11px] text-ink-muted mb-3">
                No groups yet. Group vCenters under Settings &gt; Groups.{' '}
                <Link to="/vcenter/settings?section=groups#groups" className="text-brand hover:underline">Manage</Link>
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-cohesity-border/60">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mr-1">Groups</span>
                {[...groups.map((g) => ({ ...g, isSite: false })), ...sites.map((s) => ({ ...s, isSite: true }))].map((g) => {
                  const count = memberIdsOf(g).length;
                  const lit = isLit(g);
                  const empty = count === 0;
                  return (
                    <button
                      key={`${g.isSite ? 'site' : 'group'}-${g.id}`}
                      type="button"
                      aria-pressed={lit}
                      disabled={empty}
                      onClick={(e) => pickGroup(g, e)}
                      title={empty ? 'No vCenters in this group' : 'Click to select its vCenters. Ctrl-click or Shift-click adds to the selection.'}
                      className={`chip transition-colors ${empty ? 'opacity-50 cursor-default' : 'cursor-pointer'} ${lit ? 'bg-brand/15 text-brand border-brand/40 font-semibold' : 'bg-surface-overlay text-ink-muted border-cohesity-border hover:text-ink'}`}
                    >
                      {g.isSite && <span className="text-[9px] uppercase tracking-wide rounded px-1 py-px mr-1.5 bg-surface-base text-ink-faint border border-cohesity-border">Site</span>}
                      <span className="inline-block h-[7px] w-[7px] rounded-full mr-1.5" style={{ background: g.color || BRAND }} />
                      {g.name} <span className="tnum opacity-70 ml-1">{count}</span>
                    </button>
                  );
                })}
                <Link to="/vcenter/settings?section=groups#groups" className="text-[11px] text-brand hover:underline ml-1">Manage</Link>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setParam('vc', '')}
                className={`chip cursor-pointer transition-colors ${selected.size === 0 ? 'bg-brand/15 text-brand border-brand/40 font-semibold' : 'bg-surface-overlay text-ink-muted border-cohesity-border hover:text-ink'}`}
              >
                All vCenters
              </button>
              {allVcs.map((vc) => {
                const on = selected.has(vc.id);
                const bad = vc.lastPollStatus && !/^(success|ok)$/i.test(String(vc.lastPollStatus));
                return (
                  <button
                    key={vc.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleVc(vc.id)}
                    title={bad ? `Last poll: ${vc.lastPollStatus}` : undefined}
                    className={`chip cursor-pointer transition-colors ${on ? 'bg-brand/15 text-brand border-brand/40 font-semibold' : 'bg-surface-overlay text-ink-muted border-cohesity-border hover:text-ink'}`}
                  >
                    {bad && <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-warn mr-1.5" />}
                    {vc.name} <span className="tnum opacity-70 ml-1">{fmtNum(vc.vms)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-ink-faint mt-2 tnum">
              Showing {fmtNum(summary.vms)} of {fmtNum(allVms.length)} VMs across {selected.size || allVcs.length} of {allVcs.length} vCenters
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
            <StatCard icon={MonitorSmartphone} label="VMs" value={fmtNum(summary.vms)} tone="brand" />
            <StatCard icon={Power} label="On" value={fmtNum(summary.poweredOn)} sub={`${fmtNum(summary.vms - summary.poweredOn)} off`} />
            <StatCard icon={AppWindow} label="Windows" value={fmtNum(summary.windows)} />
            <StatCard icon={Cpu} label="Linux" value={fmtNum(summary.linux)} />
            <StatCard icon={HelpCircle} label="Other" value={fmtNum(summary.other + summary.unknown)} sub={summary.unknown ? `${fmtNum(summary.unknown)} unknown` : undefined} />
            <StatCard icon={ScanSearch} label="Detail" value={fmtNum(summary.detailed)}
              sub={`of ${fmtNum(summary.vms)} VMs report an OS version`} tone={summary.vms && detailPct < 0.5 ? 'warn' : 'default'} />
          </div>

          {tiles.length > 0 && (
            <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {tiles.map((r) => {
                const active = activeOs === r.label;
                return (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => pickRelease(r.label)}
                    title={`${r.label}: show these VMs`}
                    className={`panel panel-hover text-left px-3 py-2.5 border-l-[3px] cursor-pointer ${FAMILY_BORDER[r.family] || FAMILY_BORDER.unknown} ${active ? 'ring-2 ring-brand' : ''}`}
                  >
                    <p className="text-[11px] font-semibold text-ink-muted truncate">{r.label}</p>
                    <p className="text-xl font-bold text-ink tnum leading-tight">{fmtNum(r.vms)}</p>
                    <p className="text-[11px] text-ink-faint tnum truncate">
                      {fmtNum(r.poweredOn)} on{r.versionCount > 1 ? `, ${r.versionCount} versions` : ''}
                    </p>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex gap-4 items-start">
            <div className="panel p-2 w-52 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
              {nav.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSection(n.id)}
                  className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${
                    section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'
                  }`}
                >
                  <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
                  <span className="truncate">{n.label}</span>
                  <NavChip count={n.count} />
                </button>
              ))}
            </div>

            <div className="flex-1 min-w-0">
              {section === 'releases' && (
                <Section icon={Layers} title="Releases">
                  <div className="flex justify-end mb-2">
                    <CsvExportButton filename="vcenter-guest-os-releases" rows={relCtl.rows} columns={[
                      { label: 'Release', get: 'label' }, { label: 'Family', get: 'familyLabel' },
                      { label: 'VMs', get: 'vms' }, { label: 'Powered on', get: 'poweredOn' },
                      { label: 'Versions seen', get: 'versionCount' },
                      ...visibleVcs.map((vc) => ({ label: vc.name, get: (r) => r.byVc[vc.id] || 0 })),
                      { label: 'Tools outdated', get: 'toolsOutdated' },
                    ]} />
                  </div>
                  {relCtl.rows.length === 0 ? (
                    <div className="text-sm text-ink-muted py-8 text-center">No VMs in the current selection.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <SortTh k="label" label="Release" ctl={relCtl} />
                          <SortTh k="familyLabel" label="Family" ctl={relCtl} />
                          <SortTh k="vms" label="VMs" ctl={relCtl} align="right" />
                          <SortTh k="poweredOn" label="Powered on" ctl={relCtl} align="right" />
                          <SortTh k="versionCount" label="Versions seen" ctl={relCtl} align="right" />
                          {useColumns
                            ? vcCountCols.map((vc) => <SortTh key={vc.id} k={`vc_${vc.id}`} label={vc.name} ctl={relCtl} align="right" />)
                            : <th className="py-2 pr-3">By vCenter</th>}
                          <SortTh k="toolsOutdated" label="Tools outdated" ctl={relCtl} align="right" />
                        </tr></thead>
                        <tbody>
                          {relCtl.pageRows.map((r) => (
                            <tr key={r.label} onClick={() => pickRelease(r.label)}
                              className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                              <td className="py-2 pr-3 text-ink font-medium whitespace-nowrap">{r.label}</td>
                              <td className="py-2 pr-3 text-ink-muted">{r.familyLabel}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(r.vms)}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.poweredOn)}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.versionCount)}</td>
                              {useColumns
                                ? vcCountCols.map((vc) => <td key={vc.id} className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.byVc[vc.id] || 0)}</td>)
                                : <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[320px] truncate" title={vcText(r.byVc, visibleVcs)}>{vcText(r.byVc, visibleVcs)}</td>}
                              <td className="py-2 pr-3 text-right tnum">
                                {r.toolsOutdated > 0 ? <Badge tone="warn">{r.toolsOutdated}</Badge> : <span className="text-ink-faint">0</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <TablePager ctl={relCtl} />
                </Section>
              )}

              {section === 'versions' && (
                <Section icon={GitCommitVertical} title="Versions">
                  {summary.detailed === 0 && (
                    <p className="text-xs text-ink-muted mb-3">
                      No VM reports a detailed version yet. Versions appear once VMware Tools 11 or newer runs in the guest and the next poll stores guest detail.
                    </p>
                  )}
                  <TableControls ctl={verCtl} rows={versions} searchPlaceholder="Filter by version or release..." />
                  <div className="flex justify-end mb-2">
                    <CsvExportButton filename="vcenter-guest-os-versions" rows={verCtl.rows} columns={[
                      { label: 'Version', get: 'versionLabel' }, { label: 'Release', get: 'label' }, { label: 'Family', get: 'familyLabel' },
                      { label: 'VMs', get: 'vms' }, { label: 'Powered on', get: 'poweredOn' },
                      { label: 'Tools detail', get: 'detailed' }, { label: 'Tools', get: 'tools' }, { label: 'Configured', get: 'configured' },
                      ...visibleVcs.map((vc) => ({ label: vc.name, get: (r) => r.byVc[vc.id] || 0 })),
                    ]} />
                  </div>
                  {verCtl.rows.length === 0 ? (
                    <div className="text-sm text-ink-muted py-8 text-center">No versions match.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <SortTh k="versionLabel" label="Version" ctl={verCtl} />
                          <SortTh k="label" label="Release" ctl={verCtl} />
                          <SortTh k="familyLabel" label="Family" ctl={verCtl} />
                          <SortTh k="vms" label="VMs" ctl={verCtl} align="right" />
                          <SortTh k="poweredOn" label="Powered on" ctl={verCtl} align="right" />
                          <th className="py-2 pr-3">Source</th>
                          {useColumns
                            ? vcCountCols.map((vc) => <SortTh key={vc.id} k={`vc_${vc.id}`} label={vc.name} ctl={verCtl} align="right" />)
                            : <th className="py-2 pr-3">By vCenter</th>}
                        </tr></thead>
                        <tbody>
                          {verCtl.pageRows.map((r) => (
                            <tr key={r.versionLabel} className="border-b border-cohesity-border/50">
                              <td className="py-2 pr-3 text-ink font-medium whitespace-nowrap">{r.versionLabel}</td>
                              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{r.label}</td>
                              <td className="py-2 pr-3 text-ink-muted">{r.familyLabel}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink">{fmtNum(r.vms)}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.poweredOn)}</td>
                              <td className="py-2 pr-3">
                                <div className="flex flex-wrap gap-1">
                                  {r.detailed > 0 && <Badge tone="ok" className="whitespace-nowrap">detailed {r.detailed}</Badge>}
                                  {r.tools > 0 && <Badge tone="info" className="whitespace-nowrap">Tools {r.tools}</Badge>}
                                  {r.configured > 0 && <Badge tone="neutral" className="whitespace-nowrap">configured {r.configured}</Badge>}
                                </div>
                              </td>
                              {useColumns
                                ? vcCountCols.map((vc) => <td key={vc.id} className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(r.byVc[vc.id] || 0)}</td>)
                                : <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[320px] truncate" title={vcText(r.byVc, visibleVcs)}>{vcText(r.byVc, visibleVcs)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <TablePager ctl={verCtl} />
                </Section>
              )}

              {section === 'vms' && (
                <Section icon={Boxes} title="Virtual machines">
                  <TableControls ctl={vmControls} rows={vms} searchPlaceholder="Filter by VM, host, cluster, OS or version..."
                    filters={[
                      { k: 'family', label: 'families' },
                      { k: 'label', label: 'OS' },
                      { k: 'source', label: 'sources' },
                      { k: 'power', label: 'power states' },
                    ]} />
                  <div className="flex justify-end mb-2">
                    <CsvExportButton filename="vcenter-guest-os-vms" rows={vmCtl.rows} columns={[
                      { label: 'VM', get: 'name' }, { label: 'vCenter', get: 'vcenter_name' }, { label: 'Cluster', get: 'cluster_name' },
                      { label: 'Host', get: 'host_name' }, { label: 'Power', get: 'power' },
                      { label: 'OS', get: 'label' }, { label: 'Version', get: 'versionLabel' }, { label: 'Source', get: 'source' },
                      { label: 'Configured guest', get: 'guest_os' }, { label: 'Running guest', get: 'guest_os_running' },
                      { label: 'Tools status', get: 'tools_status' }, { label: 'Tools version status', get: 'tools_version_status' },
                      { label: 'HW version', get: 'hw_version' }, { label: 'vCPU', get: 'cpu_count' }, { label: 'Memory (MB)', get: 'memory_mb' },
                    ]} />
                  </div>
                  {vmCtl.rows.length === 0 ? (
                    <div className="text-sm text-ink-muted py-8 text-center">No VMs match your filters.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                          <SortTh k="name" label="VM" ctl={vmCtl} />
                          <SortTh k="vcenter_name" label="vCenter" ctl={vmCtl} />
                          <SortTh k="cluster_name" label="Cluster" ctl={vmCtl} />
                          <SortTh k="host_name" label="Host" ctl={vmCtl} />
                          <SortTh k="power" label="Power" ctl={vmCtl} />
                          <SortTh k="label" label="OS" ctl={vmCtl} />
                          <SortTh k="versionLabel" label="Version" ctl={vmCtl} />
                          <SortTh k="source" label="Source" ctl={vmCtl} />
                          <SortTh k="tools_status" label="Tools" ctl={vmCtl} />
                          <SortTh k="hw_version" label="HW" ctl={vmCtl} />
                          <SortTh k="cpu_count" label="vCPU" ctl={vmCtl} align="right" />
                          <SortTh k="memory_mb" label="Memory" ctl={vmCtl} align="right" />
                        </tr></thead>
                        <tbody>
                          {vmCtl.pageRows.map((v) => (
                            <tr key={`${v.vcenter_id}-${v.id}`} onClick={() => setDetailVmId(v.id)}
                              className="border-b border-cohesity-border/50 hover:bg-surface-overlay/60 cursor-pointer transition-colors">
                              <td className="py-2 pr-3 text-ink font-medium whitespace-nowrap">{v.name}</td>
                              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.vcenter_name}</td>
                              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.cluster_name || '-'}</td>
                              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.host_name || '-'}</td>
                              <td className="py-2 pr-3"><Badge tone={v.power === 'On' ? 'ok' : v.power === 'Off' ? 'neutral' : 'warn'}>{v.power}</Badge></td>
                              <td className="py-2 pr-3 text-ink whitespace-nowrap">{v.label}</td>
                              <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{v.versionLabel || '-'}</td>
                              <td className="py-2 pr-3"><SourceBadge source={v.source} /></td>
                              <td className="py-2 pr-3 text-ink-muted text-[11px]">
                                {toolsLabel(v.tools_status)}{v.tools_outdated && <Badge tone="warn" className="ml-1.5">outdated</Badge>}
                              </td>
                              <td className="py-2 pr-3 text-ink-muted tnum">{v.hw_version || '-'}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtNum(v.cpu_count)}</td>
                              <td className="py-2 pr-3 text-right tnum text-ink-muted">{fmtMem(v.memory_mb)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <TablePager ctl={vmCtl} />
                </Section>
              )}
            </div>
          </div>
        </>
      )}

      {detailVmId != null && <VmDetailModal vmId={detailVmId} onClose={() => setDetailVmId(null)} />}
    </div>
  );
}
