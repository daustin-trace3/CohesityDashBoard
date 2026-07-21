import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, Bell, Server, ShieldCheck, ArrowLeftRight, HardDrive,
  Activity, FileText, Search, PanelLeftClose, PanelLeftOpen, Hexagon, X, ClipboardCheck, Settings, Sparkles, BadgeCheck, Database, Layers, Gauge, Network, FolderTree, Cloud, LayoutList, FolderOpen, Globe2, MonitorSmartphone,
} from 'lucide-react';
import NotificationBell from './NotificationBell';
import { SyncStatusChip, LastUpdated } from './ui/primitives';
import { subscribeNetworkActivity } from '../api/client';
import { usePollerStatus } from '../api/usePollerStatus';
import client from '../api/client';
import { useSearch } from '../context';

const platforms = [
  { id: 'cohesity', label: 'Cohesity', route: '/dashboard', color: '#6CB33F' },
  { id: 'pure',     label: 'Pure', route: '/pure',  color: '#FF6B00' },
  { id: 'netapp',   label: 'NetApp',    route: '/netapp',   color: '#0067C5' },
  { id: 'zerto',    label: 'Zerto',     route: '/zerto',    color: '#EE3124' },
];

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Global Overview', route: '/dashboard', icon: LayoutDashboard, isActive: (p) => p === '/' || p.startsWith('/dashboard') },
      { label: 'AI Advisor', route: '/ai-advisor', icon: Sparkles, isActive: (p) => p.startsWith('/ai-advisor') },
      { label: 'Alerts', route: '/alerts', icon: Bell, isActive: (p) => p.startsWith('/alerts'), showAlertCount: true },
      { label: 'Analytics', route: '/analytics', icon: Activity, isActive: (p) => p.startsWith('/analytics') },
      { label: 'Reporting', route: '/reporting', icon: FileText, isActive: (p) => p.startsWith('/reporting') },
      { label: 'Licensing', route: '/licensing', icon: BadgeCheck, isActive: (p) => p.startsWith('/licensing') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Data Protection', route: '/data-protection', icon: ShieldCheck, isActive: (p) => p.startsWith('/data-protection') },
      { label: 'Workloads', route: '/workloads', icon: Layers, isActive: (p) => p.startsWith('/workloads') },
      { label: 'Replication', route: '/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/replication') },
      { label: 'Views', route: '/views', icon: FolderOpen, isActive: (p) => p.startsWith('/views') },
      { label: 'Governance', route: '/governance', icon: ClipboardCheck, isActive: (p) => p.startsWith('/governance') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Clusters', route: '/clusters', icon: Server, isActive: (p) => p.startsWith('/clusters') },
      { label: 'Hardware', route: '/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/hardware') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/settings', icon: Settings, isActive: (p) => p.startsWith('/settings') },
    ],
  },
];

// Pure Storage sidebar — shown when the Pure platform is active. Grouped into
// sections that mirror the Cohesity menu.
const pureNavGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/pure', icon: Cloud, isActive: (p) => p === '/pure' },      { label: 'Estate', route: '/pure/estate', icon: LayoutList, isActive: (p) => p.startsWith('/pure/estate') },      { label: 'Capacity', route: '/pure/capacity', icon: Database, isActive: (p) => p.startsWith('/pure/capacity') },
      { label: 'Volumes', route: '/pure/volumes', icon: Layers, isActive: (p) => p.startsWith('/pure/volumes') },
      { label: 'Alerts', route: '/pure/alerts', icon: Bell, isActive: (p) => p.startsWith('/pure/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Replication', route: '/pure/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/pure/replication') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Hardware', route: '/pure/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/pure/hardware') },
      { label: 'Connectivity', route: '/pure/connectivity', icon: Network, isActive: (p) => p.startsWith('/pure/connectivity') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/pure/settings', icon: Settings, isActive: (p) => p.startsWith('/pure/settings') },
    ],
  },
];

// NetApp ONTAP sidebar — shown when the NetApp platform is active.
const netappNavGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/netapp', icon: Gauge, isActive: (p) => p === '/netapp' },
      { label: 'Capacity', route: '/netapp/capacity', icon: Database, isActive: (p) => p.startsWith('/netapp/capacity') },
      { label: 'Volumes', route: '/netapp/volumes', icon: Layers, isActive: (p) => p.startsWith('/netapp/volumes') },
      { label: 'NFS', route: '/netapp/nfs', icon: Network, isActive: (p) => p.startsWith('/netapp/nfs') },
      { label: 'SMB / CIFS', route: '/netapp/cifs', icon: FolderTree, isActive: (p) => p.startsWith('/netapp/cifs') },
      { label: 'Alerts', route: '/netapp/alerts', icon: Bell, isActive: (p) => p.startsWith('/netapp/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Replication', route: '/netapp/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/netapp/replication') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Hardware', route: '/netapp/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/netapp/hardware') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/netapp/settings', icon: Settings, isActive: (p) => p.startsWith('/netapp/settings') },
    ],
  },
];

// Zerto sidebar — shown when the Zerto platform is active.
const zertoNavGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/zerto', icon: Gauge, isActive: (p) => p === '/zerto' },
      { label: 'Alerts', route: '/zerto/alerts', icon: Bell, isActive: (p) => p.startsWith('/zerto/alerts') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'VPGs', route: '/zerto/vpgs', icon: ShieldCheck, isActive: (p) => p.startsWith('/zerto/vpgs') },
      { label: 'Replication', route: '/zerto/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/zerto/replication') },
      { label: 'Protected VMs', route: '/zerto/vms', icon: MonitorSmartphone, isActive: (p) => p.startsWith('/zerto/vms') },
    ],
  },
  {
    label: 'Infrastructure',
    items: [
      { label: 'Sites', route: '/zerto/sites', icon: Globe2, isActive: (p) => p.startsWith('/zerto/sites') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/zerto/settings', icon: Settings, isActive: (p) => p.startsWith('/zerto/settings') },
    ],
  },
];

function isActivePlatform(id, pathname) {
  if (id === 'cohesity') return ['/', '/dashboard', '/ai-advisor', '/alerts', '/clusters', '/hardware', '/data-protection', '/workloads', '/replication', '/views', '/analytics', '/reporting', '/licensing', '/settings'].some(r => pathname === r || pathname.startsWith(r + '/'));
  if (id === 'pure') return pathname.startsWith('/pure');
  if (id === 'netapp') return pathname.startsWith('/netapp');
  if (id === 'zerto') return pathname.startsWith('/zerto');
  return false;
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
  // Vendor-platform fleet summary, loaded only while a platform (Pure/NetApp) is active.
  const [platformCount, setPlatformCount] = useState(0);
  const [platformAlerts, setPlatformAlerts] = useState(0);
  const [platformHealthy, setPlatformHealthy] = useState(0);
  const [platformAlertList, setPlatformAlertList] = useState([]);

  const [networkSyncing, setNetworkSyncing] = useState(false);
  const networkSyncTimer = useRef(null);

  const { search, setSearch } = useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;
  const isPure = pathname.startsWith('/pure');
  const isNetapp = pathname.startsWith('/netapp');
  const isZerto = pathname.startsWith('/zerto');
  const isPlatform = isPure || isNetapp || isZerto;
  const platformKey = isPure ? 'pure' : isNetapp ? 'netapp' : isZerto ? 'zerto' : null;
  const platformLabel = isPure ? 'Pure Array' : isNetapp ? 'NetApp Cluster' : isZerto ? 'Zerto Site' : '';

  // Sync chip is scoped to the platform being viewed (Pure pages show Pure
  // freshness, etc.); Cohesity pages also fold in the Helios licensing feed.
  const { status: pollerStatus, anySyncing, anyStale, anyError, hasEntities, newestCapture } = usePollerStatus(platformKey || 'cohesity');

  const toggleCollapsed = () => {
    setCollapsed(c => {
      localStorage.setItem('sidebar-collapsed', c ? '0' : '1');
      return !c;
    });
  };

  useEffect(() => {
    const load = async () => {
      const [alertResp, clusterResp] = await Promise.allSettled([
        client.get('/alerts?dismissed=0&resolved=0'),
        client.get('/clusters')
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
    // Zerto's "entities" are sites; its overview endpoint is an account rollup
    // object, so the entity list comes from /zerto/sites instead.
    const overviewUrl = pureFleet ? '/pure1/overview' : zerto ? '/zerto/sites' : `/${platformKey}/overview`;
    const alertsUrl = pureFleet ? '/pure1/alerts' : `/${platformKey}/alerts`;

    const loadAlertList = () => client.get(alertsUrl)
      .then(r => {
        if (cancelled) return;
        if (zerto) {
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
        const rows = r.data || [];
        setPlatformCount(rows.length);
        const now = Date.now();
        if (zerto) {
          setPlatformHealthy(rows.filter(s => s.connection_status === 'Connected').length);
        } else if (pureFleet) {
          // Pure1 capacity metrics update daily; treat arrays reporting within
          // ~3 days as operational. Alert count is set from the alerts fetch.
          const healthy = rows.filter(a => a.capturedAt && (now - a.capturedAt) <= 3 * 86400000).length;
          setPlatformHealthy(healthy);
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
      .then(r => setEnabledPlatformIds([
        'cohesity',
        ...(r.data.platformPureEnabled ? ['pure'] : []),
        ...(r.data.platformNetappEnabled ? ['netapp'] : []),
        ...(r.data.platformZertoEnabled ? ['zerto'] : []),
      ]))
      .catch(() => {});
    loadPlatforms();
    // SettingsPage fires this after saving so the tabs update without a reload.
    window.addEventListener('platforms-changed', loadPlatforms);
    return () => window.removeEventListener('platforms-changed', loadPlatforms);
  }, []);

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
  const activeNavGroups = isPure ? pureNavGroups : isNetapp ? netappNavGroups : isZerto ? zertoNavGroups : navGroups;

  // Sidebar footer status — per-node health on a platform, API reachability elsewhere.
  const noun = isNetapp ? 'cluster' : isZerto ? 'site' : 'array';
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
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-[60px]' : 'w-[218px]'} bg-surface-base/80 border-r border-cohesity-border flex flex-col flex-shrink-0 transition-all duration-200`}>
        <BrandMark
          collapsed={collapsed}
          label={isPure ? 'Pure' : isNetapp ? 'NetApp' : isZerto ? 'Zerto' : 'Cohesity'}
          accent={isPure ? '#FF6B00' : isNetapp ? '#0067C5' : isZerto ? '#EE3124' : undefined}
        />

        <nav className="flex-1 overflow-y-auto py-3 flex flex-col gap-4" aria-label="Primary">
          {activeNavGroups.map(group => (
            <div key={group.label}>
              {!collapsed && (
                <p className="px-4 mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint select-none">{group.label}</p>
              )}
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
                      <Icon size={16} strokeWidth={active ? 2.25 : 1.75} className="flex-shrink-0" />
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
            </div>
          ))}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-cohesity-border p-2 flex flex-col gap-1.5">
          {!collapsed && (
            <div className="px-2 py-1.5 flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${footerDot}`} style={{ animation: footerOk ? 'orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
              <div className="leading-tight min-w-0">
                <p className="text-[11px] font-medium text-ink truncate">{footerHeadline}</p>
                <p className="text-[10px] text-ink-faint tnum">
                  {isPlatform
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
          {/* Left group — shrinks when viewport narrows so right controls are never pushed off */}
          <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
            <h1 className="text-sm font-semibold text-ink whitespace-nowrap hidden md:block flex-shrink-0">{isPure ? 'Pure Dashboard' : isNetapp ? 'NetApp Dashboard' : isZerto ? 'Zerto Dashboard' : 'Global Cluster Dashboard'}</h1>
            <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted hidden lg:inline-flex tnum flex-shrink-0">
              {isPlatform ? <HardDrive size={11} className="text-brand" /> : <Server size={11} className="text-brand" />}
              {isPlatform
                ? `${platformCount} ${platformLabel}${platformCount !== 1 ? 's' : ''}`
                : `${clusterCount} Cohesity Cluster${clusterCount !== 1 ? 's' : ''}`}
            </span>
            {isPlatform ? (
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
                  onClick={() => navigate('/alerts')}
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

          {/* Global search — pushes right controls to the far end */}
          <div className="relative ml-auto w-48 lg:w-64 xl:w-72 flex-shrink-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clusters…"
              aria-label="Search clusters"
              className="w-full bg-surface border border-cohesity-border text-[13px] text-ink rounded-lg pl-9 pr-8 py-1.5 placeholder-ink-faint focus:border-brand/60 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink cursor-pointer"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="flex-shrink-0">
            <NotificationBell
              count={isPlatform ? platformAlerts : alertCount}
              alerts={isPlatform ? platformAlertList.slice(0, 10) : alerts.slice(0, 10)}
              viewAllRoute={isPlatform ? `/${platformKey}/alerts` : '/alerts'}
            />
          </div>

          {/* Global settings — estate-wide admin (AI keys, platforms, product license) */}
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
        </header>

        {/* Vendor platform tabs — hidden entirely while Cohesity is the only enabled platform */}
        {enabledPlatformIds.length > 1 && (
          <div className="flex items-center gap-1.5 px-5 pt-4 pb-1 flex-shrink-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mr-2">Platform</span>
            <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1">
              {platforms.filter(p => enabledPlatformIds.includes(p.id)).map(p => {
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
          <Outlet />
        </main>
      </div>
    </div>
  );
}
