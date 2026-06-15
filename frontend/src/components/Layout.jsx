import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Bell, Server, ShieldCheck, ArrowLeftRight, HardDrive,
  Activity, FileText, Search, PanelLeftClose, PanelLeftOpen, Hexagon, Plus, X, ClipboardCheck,
} from 'lucide-react';
import NotificationBell from './NotificationBell';
import client from '../api/client';
import { useSearch } from '../context';

const platforms = [
  { id: 'cohesity', label: 'Cohesity', route: '/dashboard', color: '#6CB33F' },
  { id: 'pure',     label: 'Pure Storage', route: '/pure',  color: '#FF6B00' },
  { id: 'netapp',   label: 'NetApp',    route: '/netapp',   color: '#0067C5' },
];

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Global Overview', route: '/dashboard', icon: LayoutDashboard, isActive: (p) => p === '/' || p.startsWith('/dashboard') },
      { label: 'Alerts', route: '/alerts', icon: Bell, isActive: (p) => p.startsWith('/alerts'), showAlertCount: true },
      { label: 'Analytics', route: '/analytics', icon: Activity, isActive: (p) => p.startsWith('/analytics') },
      { label: 'Reporting', route: '/reporting', icon: FileText, isActive: (p) => p.startsWith('/reporting') },
    ],
  },
  {
    label: 'Protect',
    items: [
      { label: 'Data Protection', route: '/data-protection', icon: ShieldCheck, isActive: (p) => p.startsWith('/data-protection') },
      { label: 'Replication', route: '/replication', icon: ArrowLeftRight, isActive: (p) => p.startsWith('/replication') },
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
];

function isActivePlatform(id, pathname) {
  if (id === 'cohesity') return ['/', '/dashboard', '/alerts', '/clusters', '/hardware', '/data-protection', '/replication', '/analytics', '/reporting'].some(r => pathname === r || pathname.startsWith(r + '/'));
  if (id === 'pure') return pathname.startsWith('/pure');
  if (id === 'netapp') return pathname.startsWith('/netapp');
  return false;
}

function BrandMark({ collapsed }) {
  return (
    <div className={`flex items-center gap-2.5 px-4 h-14 border-b border-cohesity-border flex-shrink-0 ${collapsed ? 'justify-center px-0' : ''}`}>
      <div className="relative flex items-center justify-center flex-shrink-0">
        <Hexagon size={26} className="text-brand" strokeWidth={1.75} />
        <ShieldCheck size={12} className="text-brand absolute" strokeWidth={2.5} />
      </div>
      {!collapsed && (
        <div className="leading-tight min-w-0">
          <p className="text-[13px] font-bold text-ink tracking-tight truncate">Cohesity</p>
          <p className="text-[10px] font-semibold text-brand uppercase tracking-[0.14em]">Command Center</p>
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

  const { search, setSearch } = useSearch();
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;

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

  const criticalCount = alerts.filter(a => a.severity === 'critical').length;

  return (
    <div className="h-screen flex flex-row bg-transparent overflow-hidden">
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-[60px]' : 'w-[218px]'} bg-surface-base/80 border-r border-cohesity-border flex flex-col flex-shrink-0 transition-all duration-200`}>
        <BrandMark collapsed={collapsed} />

        <nav className="flex-1 overflow-y-auto py-3 flex flex-col gap-4" aria-label="Primary">
          {navGroups.map(group => (
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
              <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${apiOnline ? 'bg-status-ok shadow-glow-green' : 'bg-status-crit'}`} style={{ animation: apiOnline ? 'orb-pulse 2.5s ease-in-out infinite' : 'none' }} />
              <div className="leading-tight min-w-0">
                <p className="text-[11px] font-medium text-ink truncate">{apiOnline ? 'All systems operational' : 'API unreachable'}</p>
                <p className="text-[10px] text-ink-faint tnum">{clusterCount} cluster{clusterCount !== 1 ? 's' : ''} monitored</p>
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
        <header className="h-14 bg-surface-base/70 backdrop-blur border-b border-cohesity-border flex-shrink-0 flex items-center gap-3 px-4">
          <h1 className="text-sm font-semibold text-ink whitespace-nowrap hidden md:block">Global Cluster Dashboard</h1>
          <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted hidden lg:inline-flex tnum">
            <Server size={11} className="text-brand" />
            {clusterCount} Cohesity Cluster{clusterCount !== 1 ? 's' : ''}
          </span>
          {criticalCount > 0 && (
            <button
              onClick={() => navigate('/alerts')}
              className="chip bg-status-crit/10 border-status-crit/25 text-status-crit cursor-pointer hover:bg-status-crit/20 transition-colors tnum"
            >
              <Bell size={11} />
              {criticalCount} critical
            </button>
          )}

          {/* Global search */}
          <div className="relative ml-auto w-56 lg:w-72">
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

          <NotificationBell count={alertCount} alerts={alerts.slice(0, 10)} />
        </header>

        {/* Vendor platform tabs */}
        <div className="flex items-center gap-1.5 px-5 pt-4 pb-1 flex-shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint mr-2">Platform</span>
          <div className="flex items-center gap-1 rounded-lg bg-surface border border-cohesity-border p-1">
            {platforms.map(p => {
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
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-cohesity-border text-ink-faint hover:border-ink-faint hover:text-ink-muted text-[12px] transition-colors cursor-pointer">
            <Plus size={13} /> Add Platform
          </button>
        </div>

        {/* Page content */}
        <main className="px-5 py-4 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
