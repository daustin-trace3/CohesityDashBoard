import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  Bell, Server, HardDrive, PanelLeftClose, PanelLeftOpen, Hexagon, ShieldCheck, Settings, LogOut, Activity, Crosshair, Waypoints, LayoutGrid, ChevronDown,
} from 'lucide-react';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import UpdateBanner from './UpdateBanner';
import { SyncStatusChip, LastUpdated } from './ui/primitives';
import { subscribeNetworkActivity } from '../api/client';
import { usePollerStatus } from '../api/usePollerStatus';
import client from '../api/client';
import { platforms as builtinPlatforms } from '../platforms/registry';
import { usePlatforms } from '../platforms/PlatformsContext';
import { useAuth } from '../auth/AuthContext';
import { PlatformDropdown, PlatformRail, PlatformGrid, getSwitcherMode } from './PlatformSwitcher';
import { useAiEnabled } from '../api/useAiEnabled';

const builtinIds = builtinPlatforms.map(p => p.id);

// Cross-platform Ops Monitor — a pseudo-platform entry so every switcher
// style (tabs/dropdown/rail/grid) offers a way back to the landing page.
const OPS_ENTRY = { id: 'ops', label: 'Ops', route: '/ops', color: '#8FA3B0' };
const opsNavGroups = [{
  label: 'Estate',
  items: [
    { label: 'Ops Monitor', route: '/ops', icon: Activity, isActive: p => p === '/ops', permission: 'cohesity:*:view' },
    { label: 'Server 360', route: '/ops/server360', icon: Crosshair, isActive: p => p.startsWith('/ops/server360'), permission: 'cohesity:*:view' },
    { label: 'Topology', route: '/ops/topology', icon: Waypoints, isActive: p => p.startsWith('/ops/topology'), permission: 'cohesity:*:view' },
    { label: 'Custom Dashboards', route: '/ops/dashboards', icon: LayoutGrid, isActive: p => p.startsWith('/ops/dashboards'), permission: 'cohesity:*:view', requiresCustomDashboards: true },
  ],
}];

// Permission required to see a given nav item. Explicit per-item overrides
// (Settings) take precedence; everything else falls back to the active
// platform's own view permission.
function requiredNavPermission(platformId, item) {
  if (item.permission) return item.permission;
  if (platformId === 'cohesity' && item.route === '/settings') return 'admin:settings:view';
  return `${platformId}:*:view`;
}

function BrandMark({ collapsed, label = 'Cohesity', accent }) {
  return (
    <div className={`flex items-center gap-2.5 px-4 h-14 border-b border-cohesity-border flex-shrink-0 ${collapsed ? 'justify-center px-0' : ''}`}>
      <div className="relative flex items-center justify-center flex-shrink-0">
        <Hexagon size={26} className="text-brand" strokeWidth={1.75} style={accent ? { color: accent } : undefined} />
        <ShieldCheck size={12} className="text-brand absolute" strokeWidth={2.5} style={accent ? { color: accent } : undefined} />
      </div>
      {!collapsed && (
        <div className="leading-tight min-w-0">
          <p className="text-[13px] font-bold text-ink tracking-tight truncate">{label}</p>
          <p className="text-[10px] font-semibold text-brand uppercase tracking-[0.14em]" style={accent ? { color: accent } : undefined}>Command Center</p>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const [alertCount, setAlertCount] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [clusterCount, setClusterCount] = useState(0);
  const [apiOnline, setApiOnline] = useState(true);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  // Pure/NetApp tabs stay hidden until enabled in Settings → Platforms.
  const [enabledPlatformIds, setEnabledPlatformIds] = useState(['cohesity']);
  // Custom Dashboards ships dark — nav item hidden until enabled in Settings → Platforms.
  const [customDashboardsEnabled, setCustomDashboardsEnabled] = useState(false);
  const [switcherMode, setSwitcherMode] = useState(getSwitcherMode);
  // Collapsible nav groups: {label: bool} open-state, persisted per platform.
  const [openGroups, setOpenGroups] = useState({});

  useEffect(() => {
    const onModeChange = () => setSwitcherMode(getSwitcherMode());
    window.addEventListener('switcher-mode-changed', onModeChange);
    return () => window.removeEventListener('switcher-mode-changed', onModeChange);
  }, []);
  // Vendor-platform fleet summary, loaded only while a platform (Pure/NetApp) is active.
  const [platformCount, setPlatformCount] = useState(0);
  const [platformAlerts, setPlatformAlerts] = useState(0);
  const [platformHealthy, setPlatformHealthy] = useState(0);
  const [platformAlertList, setPlatformAlertList] = useState([]);

  const [networkSyncing, setNetworkSyncing] = useState(false);
  const networkSyncTimer = useRef(null);

  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;
  const isPure = pathname.startsWith('/pure');
  const isNetapp = pathname.startsWith('/netapp');
  const isZerto = pathname.startsWith('/zerto');
  const isVcenter = pathname.startsWith('/vcenter');
  const isDell = pathname.startsWith('/dell');
  // 'ariaops' contains 'aria' — check it before/independent of isAria so a
  // plain prefix match doesn't misfire across the two platforms.
  const isAriaOps = pathname === '/ariaops' || pathname.startsWith('/ariaops/');
  const isAria = !isAriaOps && (pathname === '/aria' || pathname.startsWith('/aria/'));
  const isNetbackup = pathname.startsWith('/netbackup');
  const isAws = pathname.startsWith('/aws');
  const isProxmox = pathname.startsWith('/proxmox');
  const isBrocade = pathname.startsWith('/brocade');
  const isOps = pathname.startsWith('/ops');
  const isPlatform = isPure || isNetapp || isZerto || isVcenter || isDell || isAria || isAriaOps || isNetbackup || isAws || isProxmox || isBrocade;
  const platformKey = isPure ? 'pure' : isNetapp ? 'netapp' : isZerto ? 'zerto' : isVcenter ? 'vcenter' : isDell ? 'dell' : isAria ? 'aria' : isAriaOps ? 'ariaops' : isNetbackup ? 'netbackup' : isAws ? 'aws' : isProxmox ? 'proxmox' : isBrocade ? 'brocade' : null;
  const platformLabel = isPure ? 'Pure Array' : isNetapp ? 'NetApp Cluster' : isZerto ? 'Zerto Site' : isVcenter ? 'ESX Host' : isDell ? 'Device' : isAria ? 'Deployment' : isAriaOps ? 'Resource' : isNetbackup ? 'Server' : isAws ? 'Instance' : isProxmox ? 'Guest' : isBrocade ? 'Fabric' : '';

  const { platforms: allPlatforms } = usePlatforms();
  const getPlatform = (id) => allPlatforms.find(p => p.id === id);
  const platforms = allPlatforms.map(p => ({ id: p.id, label: p.label, route: p.switcherRoute, color: p.color }));
  const navGroups = getPlatform('cohesity')?.navGroups || [];
  const pureNavGroups = getPlatform('pure')?.navGroups || [];
  const netappNavGroups = getPlatform('netapp')?.navGroups || [];
  const zertoNavGroups = getPlatform('zerto')?.navGroups || [];
  const vcenterNavGroups = getPlatform('vcenter')?.navGroups || [];
  const dellNavGroups = getPlatform('dell')?.navGroups || [];
  const ariaNavGroups = getPlatform('aria')?.navGroups || [];
  const ariaopsNavGroups = getPlatform('ariaops')?.navGroups || [];
  const netbackupNavGroups = getPlatform('netbackup')?.navGroups || [];
  const awsNavGroups = getPlatform('aws')?.navGroups || [];
  const proxmoxNavGroups = getPlatform('proxmox')?.navGroups || [];
  const brocadeNavGroups = getPlatform('brocade')?.navGroups || [];
  const isActivePlatform = (id, pathname) => {
    if (id === 'ops') return pathname.startsWith('/ops');
    const platform = getPlatform(id);
    return platform ? platform.isActive(pathname) : false;
  };
  // Non-built-in (installed plugin) platform whose routes match the current
  // path, so plugin nav/branding shows up without special-casing each plugin.
  const activePluginPlatform = !isPlatform
    ? allPlatforms.find(p => !builtinIds.includes(p.id) && p.isActive(pathname))
    : null;
  const navPlatformKey = platformKey || (activePluginPlatform ? activePluginPlatform.id : 'cohesity');

  // Read the persisted open/closed map once per platform switch.
  useEffect(() => {
    try {
      setOpenGroups(JSON.parse(localStorage.getItem(`nav-open:${navPlatformKey}`) || '{}'));
    } catch {
      setOpenGroups({});
    }
  }, [navPlatformKey]);

  const toggleNavGroup = (label) => {
    setOpenGroups(prev => {
      const isOpen = prev[label] !== false;
      const next = { ...prev, [label]: !isOpen };
      localStorage.setItem(`nav-open:${navPlatformKey}`, JSON.stringify(next));
      return next;
    });
  };

  const { user, logout, hasPermission, loading: authLoading } = useAuth();
  const aiEnabled = useAiEnabled();

  const visiblePlatforms = [OPS_ENTRY, ...platforms.filter(p => enabledPlatformIds.includes(p.id) && (authLoading || hasPermission(`${p.id}:*:view`)))];
  const currentPlatformId = isOps ? 'ops' : (platforms.find(p => isActivePlatform(p.id, pathname))?.id || 'cohesity');
  const gotoPlatform = (p) => navigate(p.route);
  const multiPlatform = visiblePlatforms.length > 1;

  // Sync chip is scoped to the platform being viewed (Pure pages show Pure
  // freshness, etc.); Cohesity pages also fold in the Helios licensing feed.
  const { status: pollerStatus, anySyncing, anyStale, anyError, hasEntities, newestCapture } = usePollerStatus(isOps ? 'all' : (platformKey || 'cohesity'));

  // Ops Monitor header: estate-wide figures from /ops/summary (platform count,
  // critical across every managed platform) instead of the Cohesity feed.
  const [opsTotals, setOpsTotals] = useState(null);
  useEffect(() => {
    if (!isOps) return undefined;
    let cancelled = false;
    const load = () => client.get('/ops/summary')
      .then((r) => { if (!cancelled) setOpsTotals(r.data?.totals || null); })
      .catch(() => {});
    load();
    const interval = setInterval(load, 60000);
    window.addEventListener('platforms-changed', load);
    return () => { cancelled = true; clearInterval(interval); window.removeEventListener('platforms-changed', load); };
  }, [isOps]);

  const toggleCollapsed = () => {
    setCollapsed(c => {
      localStorage.setItem('sidebar-collapsed', c ? '0' : '1');
      return !c;
    });
  };

  useEffect(() => {
    const load = async () => {
      const [alertResp, clusterResp] = await Promise.allSettled([
        client.get('/cohesity/alerts?dismissed=0&resolved=0'),
        client.get('/cohesity/clusters')
      ]);
      if (alertResp.status === 'fulfilled') {
        setAlerts(alertResp.value.data);
        setAlertCount(alertResp.value.data.length);
        setApiOnline(true);
      }
      if (clusterResp.status === 'fulfilled') {
        setClusterCount(clusterResp.value.data.length);
      }
      if (alertResp.status === 'rejected' && clusterResp.status === 'rejected') {
        setApiOnline(false);
      }
    };
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  // Vendor-platform fleet summary (count + open alerts + health) — only while a
  // platform is active. Pure is backed by the Pure1 cloud fleet; NetApp uses its
  // per-cluster overview.
  useEffect(() => {
    if (!platformKey) { setPlatformAlertList([]); return undefined; }
    let cancelled = false;
    const pureFleet = platformKey === 'pure';
    const zerto = platformKey === 'zerto';
    const vcenter = platformKey === 'vcenter';
    const dell = platformKey === 'dell';
    const aria = platformKey === 'aria';
    const ariaops = platformKey === 'ariaops';
    const netbackup = platformKey === 'netbackup';
    const aws = platformKey === 'aws';
    const proxmox = platformKey === 'proxmox';
    const brocade = platformKey === 'brocade';
    // Zerto's "entities" are sites; vCenter's are ESX hosts. Both platforms'
    // overview endpoints are rollup objects, so entity lists come from their
    // inventory endpoints; vCenter's "alerts" are its computed issues.
    // Aria's "entities" are deployments, and its computed issues endpoint
    // returns a plain array (not vCenter/Dell's {issues: [...]} rollup).
    // Aria Operations' "entities" are polled resources (VMs/hosts/datastores),
    // and its alerts endpoint is a flat array of raw alert rows (level/status).
    // NetBackup's overview is a rollup object ({sources, stats, ...}) rather
    // than a bare entity array, so its source count comes from stats.sourceCount.
    // Brocade's overview is a rollup object too (sources/fabrics/switches/...),
    // and its alert badge reads the computed issues endpoint (issues: [...]).
    const overviewUrl = pureFleet ? '/pure1/overview' : zerto ? '/zerto/sites' : vcenter ? '/vcenter/hosts' : dell ? '/dell/devices' : aria ? '/aria/deployments' : ariaops ? '/ariaops/resources' : netbackup ? '/netbackup/overview' : aws ? '/aws/overview' : proxmox ? '/proxmox/overview' : brocade ? '/brocade/overview' : `/${platformKey}/overview`;
    const alertsUrl = pureFleet ? '/pure1/alerts' : (vcenter || dell) ? `/${platformKey}/overview` : aria ? '/aria/issues' : ariaops ? '/ariaops/alerts' : netbackup ? '/netbackup/issues' : aws ? '/aws/issues' : proxmox ? '/proxmox/issues' : brocade ? '/brocade/issues' : `/${platformKey}/alerts`;

    const loadAlertList = () => client.get(alertsUrl)
      .then(r => {
        if (cancelled) return;
        if (vcenter || dell) {
          const rows = (r.data?.issues || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map((i, idx) => ({
            id: idx,
            cluster_name: i.vcenter || i.ome || '—',
            severity: i.severity === 'critical' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else if (aria) {
          const rows = (r.data || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map((i, idx) => ({
            id: idx,
            cluster_name: i.instance || '—',
            severity: i.severity === 'error' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else if (ariaops) {
          const rows = r.data || [];
          setPlatformAlertList(rows.map(a => ({
            id: `${a.instance_id}|${a.alert_id}`,
            cluster_name: a.resource_name || a.instance_name || '—',
            severity: (a.level === 'CRITICAL' || a.level === 'IMMEDIATE') ? 'critical' : 'warning',
            description: a.definition_name || 'Alert',
          })));
          setPlatformAlerts(rows.length);
        } else if (zerto) {
          const rows = r.data || [];
          setPlatformAlertList(rows.map(a => ({
            id: a.alert_identifier,
            cluster_name: a.site_name || '—',
            severity: a.severity === 'Error' ? 'critical' : 'warning',
            description: a.description || a.alert_type || 'Alert',
          })));
          setPlatformAlerts(rows.length);
        } else if (pureFleet) {
          const open = (r.data || []).filter(a => String(a.severity || '').toLowerCase() !== 'hidden');
          setPlatformAlertList(open.map(a => ({
            id: a.id,
            cluster_name: a.arrayName || '—',
            severity: a.severity,
            description: a.summary || 'Alert',
          })));
          setPlatformAlerts(open.length);
        } else if (netbackup) {
          const rows = (r.data?.issues || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map(i => ({
            id: i.issueKey,
            cluster_name: i.host || '—',
            severity: i.severity === 'critical' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else if (aws) {
          const rows = (r.data?.issues || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map((i, idx) => ({
            id: idx,
            cluster_name: i.account || '—',
            severity: i.severity === 'critical' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else if (proxmox) {
          const rows = (r.data || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map((i, idx) => ({
            id: idx,
            cluster_name: i.source || '—',
            severity: i.severity === 'critical' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else if (brocade) {
          const rows = (r.data?.issues || []).filter(i => i.severity !== 'info');
          setPlatformAlertList(rows.map((i, idx) => ({
            id: idx,
            cluster_name: i.source || '—',
            severity: i.severity === 'critical' ? 'critical' : 'warning',
            description: i.message,
          })));
          setPlatformAlerts(rows.length);
        } else {
          const rows = (r.data || []).filter(a => !a.resolved && a.state !== 'closed' && a.state !== 'resolved');
          setPlatformAlertList(rows.map(a => ({
            id: a.id,
            cluster_name: a.array_name || a.cluster_name || '—',
            severity: a.severity,
            description: a.summary || a.message || a.description || a.alert_type || 'Alert',
          })));
        }
      })
      .catch(() => { if (!cancelled) setPlatformAlertList([]); });
    const loadPlatform = () => client.get(overviewUrl)
      .then(r => {
        if (cancelled) return;
        // NetBackup's overview response is a rollup object, not a bare list of
        // entities — its "rows" are the source list, and its entity count is
        // the reported stats.sourceCount (mirrors the pattern used by the
        // Zerto/Aria branches below, whose overview endpoints are also not
        // bare entity arrays).
        const rows = netbackup ? (r.data?.sources || []) : proxmox ? (r.data?.servers || []) : (r.data || []);
        setPlatformCount(netbackup ? (r.data?.stats?.sourceCount ?? rows.length)
          : aws ? ((r.data?.ec2?.total || 0) + (r.data?.lightsail?.total || 0))
          : proxmox ? (r.data?.totals?.guests || 0)
          : brocade ? (r.data?.fabrics?.total || 0)
          : rows.length);
        const now = Date.now();
        if (zerto) {
          setPlatformHealthy(rows.filter(s => s.connection_status === 'Connected').length);
        } else if (vcenter) {
          setPlatformHealthy(rows.filter(h => h.connection_state === 'CONNECTED').length);
        } else if (dell) {
          setPlatformHealthy(rows.filter(d => d.connection_state !== 0).length);
        } else if (aria) {
          setPlatformHealthy(rows.filter(d => !String(d.status || '').toUpperCase().includes('FAIL')).length);
        } else if (ariaops) {
          setPlatformHealthy(rows.filter(r => r.health === 'GREEN').length);
        } else if (pureFleet) {
          // Pure1 capacity metrics update daily; treat arrays reporting within
          // ~3 days as operational. Alert count is set from the alerts fetch.
          const healthy = rows.filter(a => a.capturedAt && (now - a.capturedAt) <= 3 * 86400000).length;
          setPlatformHealthy(healthy);
        } else if (netbackup) {
          // A source is healthy if it has no critical (poll-error) issue.
          setPlatformHealthy(rows.filter(s => s.lastPollStatus !== 'error').length);
        } else if (aws) {
          // Overview is a rollup object, not a bare entity array — count
          // running instances (EC2 + Lightsail) as "healthy".
          setPlatformHealthy((r.data?.ec2?.running || 0) + (r.data?.lightsail?.running || 0));
        } else if (proxmox) {
          setPlatformHealthy(r.data?.totals?.guestsRunning || 0);
        } else if (brocade) {
          setPlatformHealthy(r.data?.fabrics?.healthy ?? 0);
        } else {
          setPlatformAlerts(rows.reduce((s, a) => s + (a.open_alerts || 0), 0));
          const healthy = rows.filter(a => {
            if (!a.latest || !a.latest.captured_at) return false;
            const ms = new Date(String(a.latest.captured_at).replace(' ', 'T') + 'Z').getTime();
            const thresholdMin = (a.polling_interval_minutes || 15) * 2 + 5;
            return Number.isFinite(ms) && (now - ms) <= thresholdMin * 60000;
          }).length;
          setPlatformHealthy(healthy);
        }
      })
      .catch(() => {});
    loadPlatform();
    loadAlertList();
    const id = setInterval(() => { loadPlatform(); loadAlertList(); }, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [platformKey]);

  useEffect(() => {
    const loadPlatforms = () => client.get('/settings')
      .then(r => {
        setCustomDashboardsEnabled(!!r.data.featureCustomDashboardsEnabled);
        return r;
      })
      .then(r => setEnabledPlatformIds([
        ...(r.data.platformCohesityEnabled !== false ? ['cohesity'] : []),
        ...(r.data.platformPureEnabled ? ['pure'] : []),
        ...(r.data.platformNetappEnabled ? ['netapp'] : []),
        ...(r.data.platformZertoEnabled ? ['zerto'] : []),
        ...(r.data.platformVcenterEnabled ? ['vcenter'] : []),
        ...(r.data.platformDellEnabled ? ['dell'] : []),
        ...(r.data.platformAriaEnabled ? ['aria'] : []),
        ...(r.data.platformAriaopsEnabled ? ['ariaops'] : []),
        ...(r.data.platformNetbackupEnabled ? ['netbackup'] : []),
        ...(r.data.platformAwsEnabled ? ['aws'] : []),
        ...(r.data.platformProxmoxEnabled ? ['proxmox'] : []),
        ...(r.data.platformBrocadeEnabled ? ['brocade'] : []),
        ...allPlatforms.filter(p => !builtinIds.includes(p.id)).map(p => p.id),
      ]))
      .catch(() => {});
    loadPlatforms();
    // SettingsPage fires this after saving so the tabs update without a reload.
    window.addEventListener('platforms-changed', loadPlatforms);
    return () => window.removeEventListener('platforms-changed', loadPlatforms);
  }, [allPlatforms]);

  useEffect(() => {
    return subscribeNetworkActivity((count) => {
      const busy = count > 0;
      if (busy) {
        clearTimeout(networkSyncTimer.current);
        setNetworkSyncing(true);
      } else {
        networkSyncTimer.current = setTimeout(() => setNetworkSyncing(false), 400);
      }
    });
  }, []);

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;

  // Swap the sidebar menu to match the active vendor platform.
  const baseNavGroups = isOps ? opsNavGroups
    : isPure ? pureNavGroups : isNetapp ? netappNavGroups : isZerto ? zertoNavGroups : isVcenter ? vcenterNavGroups : isDell ? dellNavGroups : isAria ? ariaNavGroups : isAriaOps ? ariaopsNavGroups : isNetbackup ? netbackupNavGroups : isAws ? awsNavGroups : isProxmox ? proxmoxNavGroups : isBrocade ? brocadeNavGroups
    : activePluginPlatform ? activePluginPlatform.navGroups : navGroups;

  // Hide items the user lacks permission for. While auth is still loading,
  // show everything (no flicker-hide). AI-dependent items (requiresAi) stay
  // hidden until an AI provider token is configured.
  const activeNavGroups = baseNavGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item =>
        (!item.requiresAi || aiEnabled)
        && (!item.requiresCustomDashboards || customDashboardsEnabled)
        && (authLoading || hasPermission(requiredNavPermission(navPlatformKey, item)))),
    }))
    .filter(group => group.items.length > 0);

  // Sidebar footer status — per-node health on a platform, API reachability elsewhere.
  const noun = isNetapp ? 'cluster' : isZerto ? 'site' : isVcenter ? 'host' : isDell ? 'device' : isAria ? 'instance' : isAriaOps ? 'resource' : isNetbackup ? 'server' : isAws ? 'instance' : isProxmox ? 'guest' : isBrocade ? 'fabric' : 'array';
  const platformAllOk = platformCount > 0 && platformHealthy === platformCount;
  const footerOk = isPlatform ? platformAllOk : apiOnline;
  const footerPartial = isPlatform && platformHealthy > 0 && !platformAllOk;
  const footerDot = footerOk ? 'bg-status-ok shadow-glow-green' : footerPartial ? 'bg-status-warn' : 'bg-status-crit';
  const footerHeadline = isPlatform
    ? (platformCount === 0 ? `No ${noun}s connected`
      : platformAllOk ? `All ${noun}s operational`
      : `${platformHealthy} of ${platformCount} operational`)
    : (apiOnline ? 'All systems operational' : 'API unreachable');

  return (
    <div className="h-screen flex flex-row bg-transparent overflow-hidden">
      {/* Experimental switcher style: far-left platform icon rail */}
      {multiPlatform && switcherMode === 'rail' && (
        <PlatformRail platforms={visiblePlatforms} currentId={currentPlatformId} onSelect={gotoPlatform} status={pollerStatus} />
      )}
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-[60px]' : 'w-[218px]'} bg-surface-base/80 border-r border-cohesity-border flex flex-col flex-shrink-0 transition-all duration-200`}>
        <BrandMark
          collapsed={collapsed}
          label={isOps ? 'Operations' : isPure ? 'Pure' : isNetapp ? 'NetApp' : isZerto ? 'Zerto' : isVcenter ? 'vCenter' : isDell ? 'Dell' : isAria ? 'Aria' : isAriaOps ? 'Aria Ops' : isNetbackup ? 'NetBackup' : isAws ? 'AWS' : isProxmox ? 'Proxmox VE' : isBrocade ? 'Brocade SAN' : activePluginPlatform ? activePluginPlatform.label : 'Cohesity'}
          accent={isPure ? '#FF6B00' : isNetapp ? '#0067C5' : isZerto ? '#EE3124' : isVcenter ? '#0091DA' : isDell ? '#007DB8' : isAria ? '#00A2C7' : isAriaOps ? '#78BE20' : isNetbackup ? '#B1181E' : isAws ? '#FF9900' : isProxmox ? '#E57000' : isBrocade ? '#CC092F' : activePluginPlatform ? activePluginPlatform.color : undefined}
        />

        <nav className="flex-1 overflow-y-auto py-3 flex flex-col gap-4" aria-label="Primary">
          {activeNavGroups.map(group => {
            const groupHasActiveItem = group.items.some(item => item.isActive(pathname));
            const groupOpen = collapsed || groupHasActiveItem || openGroups[group.label] !== false;
            return (
            <div key={group.label}>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => toggleNavGroup(group.label)}
                  className="w-full flex items-center justify-between gap-1 px-4 mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint select-none cursor-pointer hover:text-ink transition-colors"
                >
                  <span className="truncate">{group.label}</span>
                  <ChevronDown size={12} className={`flex-shrink-0 transition-transform duration-150 ${groupOpen ? 'rotate-180' : ''}`} />
                </button>
              )}
              {(collapsed || groupOpen) && (
              <div className="flex flex-col gap-0.5 px-2">
                {group.items.map(item => {
                  const active = item.isActive(pathname);
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.route}
                      to={item.route}
                      title={collapsed ? item.label : undefined}
                      className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors duration-150 cursor-pointer ${
                        collapsed ? 'justify-center' : ''
                      } ${
                        active
                          ? 'bg-brand/10 text-brand'
                          : 'text-ink-muted hover:bg-surface-overlay hover:text-ink'
                      }`}
                    >
                      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r bg-brand" />}
                      {Icon ? (
                        <Icon size={16} strokeWidth={active ? 2.25 : 1.75} className="flex-shrink-0" />
                      ) : (
                        // Installed plugins can't import the host icon set — render a
                        // neutral dot instead of crashing on <undefined />.
                        <span className="h-1.5 w-1.5 mx-[5px] rounded-full bg-current opacity-60 flex-shrink-0" />
                      )}
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {!collapsed && item.showAlertCount && alertCount > 0 && (
                        <span className={`ml-auto min-w-[20px] text-center rounded-full px-1.5 py-px text-[10px] font-bold tnum ${
                          criticalCount > 0 ? 'bg-status-crit/15 text-status-crit' : 'bg-status-warn/15 text-status-warn'
                        }`}>
                          {alertCount > 99 ? '99+' : alertCount}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
              )}
            </div>
            );
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-cohesity-border p-2 flex flex-col gap-1.5">
          {!collapsed && (
            <div className="px-2 py-1.5 flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${footerDot}`} style={{ animation: footerOk ? 'orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
              <div className="leading-tight min-w-0">
                <p className="text-[11px] font-medium text-ink truncate">{footerHeadline}</p>
                <p className="text-[10px] text-ink-faint tnum">
                  {isOps
                    ? `${opsTotals?.platforms ?? 0} platform${opsTotals?.platforms === 1 ? '' : 's'} monitored`
                    : isPlatform
                    ? `${platformCount} ${noun}${platformCount !== 1 ? 's' : ''} monitored`
                    : `${clusterCount} cluster${clusterCount !== 1 ? 's' : ''} monitored`}
                </p>
                {newestCapture && <LastUpdated date={newestCapture} prefix="Data" />}
              </div>
            </div>
          )}
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-ink-faint hover:bg-surface-overlay hover:text-ink transition-colors cursor-pointer text-[12px]"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={16} /><span>Collapse</span></>}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="relative z-30 h-14 bg-surface-base/70 backdrop-blur border-b border-cohesity-border flex-shrink-0 flex items-center gap-2 px-4">
          {/* Experimental switcher styles: dropdown / grid launcher in the top bar */}
          {multiPlatform && switcherMode === 'dropdown' && (
            <PlatformDropdown platforms={visiblePlatforms} currentId={currentPlatformId} onSelect={gotoPlatform} status={pollerStatus} />
          )}
          {multiPlatform && switcherMode === 'grid' && (
            <PlatformGrid platforms={visiblePlatforms} currentId={currentPlatformId} onSelect={gotoPlatform} status={pollerStatus} />
          )}
          {/* Left group — shrinks when viewport narrows so right controls are never pushed off */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
            <h1 className="text-sm font-semibold text-ink whitespace-nowrap hidden md:block flex-shrink-0">{isOps ? 'Ops Monitor' : isPure ? 'Pure Dashboard' : isNetapp ? 'NetApp Dashboard' : isZerto ? 'Zerto Dashboard' : isVcenter ? 'vCenter Dashboard' : isDell ? 'Dell Dashboard' : isAria ? 'Aria Automation Dashboard' : isAriaOps ? 'Aria Operations Dashboard' : isNetbackup ? 'NetBackup Dashboard' : isAws ? 'AWS Dashboard' : isProxmox ? 'Proxmox VE Dashboard' : isBrocade ? 'Brocade SAN Dashboard' : activePluginPlatform ? `${activePluginPlatform.label} Dashboard` : 'Global Cluster Dashboard'}</h1>
            {/* Plugin platforms have no entity-feed endpoints — hide the count chip
                rather than showing the Cohesity fall-through. */}
            {isOps ? (
              opsTotals && (
                <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted hidden lg:inline-flex tnum flex-shrink-0">
                  <LayoutGrid size={11} className="text-brand" />
                  {`${opsTotals.platforms} Platform${opsTotals.platforms !== 1 ? 's' : ''}`}
                </span>
              )
            ) : !activePluginPlatform && (
            <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted hidden lg:inline-flex tnum flex-shrink-0">
              {isPlatform ? <HardDrive size={11} className="text-brand" /> : <Server size={11} className="text-brand" />}
              {isPlatform
                ? `${platformCount} ${platformLabel}${platformCount !== 1 ? 's' : ''}`
                : `${clusterCount} Cohesity Cluster${clusterCount !== 1 ? 's' : ''}`}
            </span>
            )}
            {isOps ? (
              opsTotals?.critical > 0 && (
                <button
                  onClick={() => navigate('/ops')}
                  className="chip bg-status-crit/10 border-status-crit/25 text-status-crit cursor-pointer hover:bg-status-crit/20 transition-colors tnum flex-shrink-0"
                >
                  <Bell size={11} />
                  {opsTotals.critical} critical
                </button>
              )
            ) : activePluginPlatform ? null : isPlatform ? (
              platformAlerts > 0 && (
                <button
                  onClick={() => navigate(`/${platformKey}/alerts`)}
                  className="chip bg-status-crit/10 border-status-crit/25 text-status-crit cursor-pointer hover:bg-status-crit/20 transition-colors tnum flex-shrink-0"
                >
                  <Bell size={11} />
                  {platformAlerts} alert{platformAlerts !== 1 ? 's' : ''}
                </button>
              )
            ) : (
              criticalCount > 0 && (
                <button
                  onClick={() => navigate('/cohesity/alerts')}
                  className="chip bg-status-crit/10 border-status-crit/25 text-status-crit cursor-pointer hover:bg-status-crit/20 transition-colors tnum flex-shrink-0"
                >
                  <Bell size={11} />
                  {criticalCount} critical
                </button>
              )
            )}
            {/* Poller / network sync status — scoped to the active platform;
                hidden when that platform has nothing registered */}
            {((pollerStatus && hasEntities) || networkSyncing) && (
              <span className="hidden sm:inline-flex flex-shrink-0">
                <SyncStatusChip
                  state={networkSyncing || anySyncing ? 'syncing' : anyError ? 'error' : anyStale ? 'stale' : 'live'}
                />
              </span>
            )}
          </div>

          {/* Global search — estate-wide entity typeahead */}
          <GlobalSearch />

          <div className="flex-shrink-0">
            <NotificationBell
              count={isPlatform ? platformAlerts : alertCount}
              alerts={isPlatform ? platformAlertList.slice(0, 10) : alerts.slice(0, 10)}
              viewAllRoute={isPlatform ? `/${platformKey}/alerts` : '/cohesity/alerts'}
            />
          </div>

          {/* Global settings — estate-wide admin (AI keys, platforms, product license) */}
          {(authLoading || hasPermission('admin:settings:view')) && (
            <button
              onClick={() => navigate('/admin')}
              title="Global settings"
              aria-label="Global settings"
              className={`flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg border transition-colors cursor-pointer ${
                pathname.startsWith('/admin')
                  ? 'bg-brand/10 border-brand/30 text-brand'
                  : 'border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40'
              }`}
            >
              <Settings size={15} />
            </button>
          )}

          {/* Signed-in user + sign out */}
          {user && (
            <div className="flex items-center gap-2 flex-shrink-0 pl-3 ml-1 border-l border-cohesity-border">
              <span
                className="text-xs text-ink-muted max-w-[120px] truncate hidden sm:block"
                title={user.displayName || user.username}
              >
                {user.displayName || user.username}
              </span>
              {user.id != null && (
                <button
                  onClick={logout}
                  title="Sign out"
                  aria-label="Sign out"
                  className="flex items-center justify-center h-8 w-8 rounded-lg border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"
                >
                  <LogOut size={15} />
                </button>
              )}
            </div>
          )}
        </header>

        {/* Vendor platform tabs — hidden entirely while Cohesity is the only enabled platform */}
        {multiPlatform && switcherMode === 'tabs' && (
          <div className="flex items-center gap-1.5 px-5 pt-4 pb-1 flex-shrink-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mr-2">Platform</span>
            <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1">
              {visiblePlatforms.map(p => {
                const active = isActivePlatform(p.id, pathname);
                return (
                  <button
                    key={p.id}
                    onClick={() => navigate(p.route)}
                    className={`flex items-center gap-2 px-3.5 py-1.5 rounded-md text-[12px] font-medium transition-colors duration-150 cursor-pointer ${
                      active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: p.color, boxShadow: active ? `0 0 6px ${p.color}99` : 'none' }} />
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Page content */}
        <main className="px-5 py-4 flex-1 overflow-auto">
          <UpdateBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
