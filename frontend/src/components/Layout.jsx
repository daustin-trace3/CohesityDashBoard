import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  Bell, Server, PanelLeftClose, PanelLeftOpen, Hexagon, ShieldCheck, Settings, LogOut, Activity, Crosshair, LayoutGrid, ChevronDown, HelpCircle,
} from 'lucide-react';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import ReleaseNotesModal from './ReleaseNotesModal';
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
  const { platforms: allPlatforms } = usePlatforms();
  const getPlatform = (id) => allPlatforms.find(p => p.id === id);
  const cohesityPresent = !!getPlatform('cohesity');

  const [alertCount, setAlertCount] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [clusterCount, setClusterCount] = useState(0);
  const [apiOnline, setApiOnline] = useState(true);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === '1');
  // Installed-plugin tabs stay hidden until the plugin is enabled.
  const [enabledPlatformIds, setEnabledPlatformIds] = useState(() =>
    cohesityPresent ? ['cohesity'] : (allPlatforms[0] ? [allPlatforms[0].id] : [])
  );
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
  const [networkSyncing, setNetworkSyncing] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseNotesUnseen, setReleaseNotesUnseen] = useState(false);
  const networkSyncTimer = useRef(null);

  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;
  const isOps = pathname.startsWith('/ops');

  const platforms = allPlatforms.map(p => ({ id: p.id, label: p.label, route: p.switcherRoute, color: p.color, logo: p.logo }));
  const primaryPlatformId = cohesityPresent ? 'cohesity' : (enabledPlatformIds[0] || null);
  const navGroups = getPlatform(primaryPlatformId)?.navGroups || [];
  const isActivePlatform = (id, pathname) => {
    if (id === 'ops') return pathname.startsWith('/ops');
    const platform = getPlatform(id);
    return platform ? platform.isActive(pathname) : false;
  };
  // Non-built-in (installed plugin) platform whose routes match the current
  // path, so plugin nav/branding shows up without special-casing each plugin.
  const activePluginPlatform = allPlatforms.find(p => p.isPlugin && !builtinIds.includes(p.id) && p.isActive(pathname));
  const navPlatformKey = activePluginPlatform ? activePluginPlatform.id : (primaryPlatformId || 'cohesity');

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

  useEffect(() => {
    client.get('/release-notes')
      .then(({ data }) => {
        setReleaseNotes(data);
        const seen = localStorage.getItem('icc:release-notes-seen');
        if (data?.latest?.version && data.latest.version !== seen) setReleaseNotesUnseen(true);
      })
      .catch(() => {});
  }, []);

  const openReleaseNotes = () => {
    setReleaseNotesOpen(true);
    setReleaseNotesUnseen(false);
  };

  const visiblePlatforms = [OPS_ENTRY, ...platforms.filter(p => enabledPlatformIds.includes(p.id) && (authLoading || hasPermission(`${p.id}:*:view`)))];
  const currentPlatformId = isOps ? 'ops' : (platforms.find(p => isActivePlatform(p.id, pathname))?.id || primaryPlatformId || 'cohesity');
  const gotoPlatform = (p) => navigate(p.route);
  const multiPlatform = visiblePlatforms.length > 1;

  // Sync chip is scoped to the platform being viewed (an installed plugin's
  // own poller entry, or Cohesity); Cohesity pages also fold in the Helios
  // licensing feed.
  const { status: pollerStatus, anySyncing, anyStale, anyError, hasEntities, newestCapture } = usePollerStatus(activePluginPlatform ? activePluginPlatform.id : (primaryPlatformId || 'cohesity'));

  const toggleCollapsed = () => {
    setCollapsed(c => {
      localStorage.setItem('sidebar-collapsed', c ? '0' : '1');
      return !c;
    });
  };

  useEffect(() => {
    if (!cohesityPresent) return undefined;
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
  }, [cohesityPresent]);

  // When cohesity isn't present, the header alert/cluster poll above never
  // runs — derive API reachability from an endpoint every deployment has
  // instead of leaving the shell stuck on the initial apiOnline=true guess.
  useEffect(() => {
    if (cohesityPresent) return undefined;
    let cancelled = false;
    const check = () => client.get('/ops/summary')
      .then(() => { if (!cancelled) setApiOnline(true); })
      .catch(() => { if (!cancelled) setApiOnline(false); });
    check();
    const interval = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [cohesityPresent]);

  useEffect(() => {
    const loadPlatforms = () => client.get('/settings')
      .then(r => {
        setCustomDashboardsEnabled(!!r.data.featureCustomDashboardsEnabled);
        return r;
      })
      .then(r => setEnabledPlatformIds([
        ...(cohesityPresent && r.data.platformCohesityEnabled !== false ? ['cohesity'] : []),
        // Installed plugins are enabled by definition (the backend only serves
        // active ones) — including when they shadow a built-in id the local
        // backend has no platform_<id>_enabled setting for.
        ...allPlatforms.filter(p => p.isPlugin).map(p => p.id),
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

  // Sidebar footer status — API reachability.
  const footerOk = apiOnline;
  const footerDot = footerOk ? 'bg-status-ok shadow-glow-green' : 'bg-status-crit';
  const footerHeadline = apiOnline ? 'All systems operational' : 'API unreachable';

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
          label={isOps ? 'Operations' : activePluginPlatform ? activePluginPlatform.label : 'Cohesity'}
          accent={activePluginPlatform ? activePluginPlatform.color : undefined}
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
                  {clusterCount} cluster{clusterCount !== 1 ? 's' : ''} monitored
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
            <h1 className="text-sm font-semibold text-ink whitespace-nowrap hidden md:block flex-shrink-0">{isOps ? 'Ops Monitor' : activePluginPlatform ? `${activePluginPlatform.label} Dashboard` : 'Global Cluster Dashboard'}</h1>
            {/* Plugin platforms have no entity-feed endpoints — hide the count chip
                rather than showing the Cohesity fall-through. The cohesity fallback
                branch below also hides when cohesity itself isn't present. */}
            {!activePluginPlatform && cohesityPresent && (
            <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted hidden lg:inline-flex tnum flex-shrink-0">
              <Server size={11} className="text-brand" />
              {clusterCount} Cohesity Cluster{clusterCount !== 1 ? 's' : ''}
            </span>
            )}
            {!activePluginPlatform && cohesityPresent && criticalCount > 0 && (
              <button
                onClick={() => navigate('/cohesity/alerts')}
                className="chip bg-status-crit/10 border-status-crit/25 text-status-crit cursor-pointer hover:bg-status-crit/20 transition-colors tnum flex-shrink-0"
              >
                <Bell size={11} />
                {criticalCount} critical
              </button>
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

          {/* What's New — release notes for the current version */}
          <button
            onClick={openReleaseNotes}
            title="What's New"
            aria-label="What's New"
            className="relative flex-shrink-0 flex items-center justify-center h-8 w-8 rounded-lg border transition-colors cursor-pointer border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40"
          >
            <HelpCircle size={16} />
            {releaseNotesUnseen && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 bg-status-crit rounded-full shadow" />
            )}
          </button>
          {releaseNotesOpen && (
            <ReleaseNotesModal latest={releaseNotes?.latest} onClose={() => setReleaseNotesOpen(false)} />
          )}

          {cohesityPresent && (
          <div className="flex-shrink-0">
            <NotificationBell
              count={alertCount}
              alerts={alerts.slice(0, 10)}
              viewAllRoute={`/${primaryPlatformId || 'cohesity'}/alerts`}
            />
          </div>
          )}

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
