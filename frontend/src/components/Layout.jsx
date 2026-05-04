import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import NotificationBell from './NotificationBell';
import client from '../api/client';

const platforms = [
  { id: 'cohesity', label: 'Cohesity', route: '/dashboard', color: '#6CB33F' },
  { id: 'pure',     label: 'Pure Storage', route: '/pure',  color: '#FF6B00' },
  { id: 'netapp',   label: 'NetApp',    route: '/netapp',   color: '#0067C5' },
];

const navItems = [
  {
    label: 'Global Overview',
    route: '/dashboard',
    svg: 'globe',
    isActive: (p) => p === '/' || p === '/dashboard',
  },
  {
    label: 'Alerts',
    route: '/alerts',
    svg: 'bell',
    isActive: (p) => p.startsWith('/alerts'),
  },
  {
    label: 'Clusters',
    route: '/clusters',
    svg: 'clusters',
    isActive: (p) => p.startsWith('/clusters'),
  },
  {
    label: 'Data Protection',
    route: '/data-protection',
    svg: 'shield',
    isActive: (p) => p.startsWith('/data-protection'),
  },
  {
    label: 'Infrastructure',
    route: '/hardware',
    svg: 'infra',
    isActive: (p) => p.startsWith('/hardware'),
  },
  {
    label: 'Analytics',
    route: '/analytics',
    svg: 'analytics',
    isActive: (p) => p.startsWith('/analytics'),
  },
  {
    label: 'Reporting',
    route: '/reporting',
    svg: 'report',
    isActive: (p) => p.startsWith('/reporting'),
  },
];

function NavIcon({ type }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" fill="none" className="flex-shrink-0">
      {type === 'globe' && <><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 010 12M8 2a9 9 0 000 12"/></>}
      {type === 'shield' && <path d="M8 2l5 2v4c0 3-2.5 5-5 6C5.5 13 3 11 3 8V4l5-2z"/>}
      {type === 'infra' && <><rect x="2" y="3" width="5" height="4" rx="1"/><rect x="9" y="3" width="5" height="4" rx="1"/><rect x="2" y="11" width="5" height="4" rx="1"/><rect x="9" y="11" width="5" height="4" rx="1"/></>}
      {type === 'bell' && <><path d="M8 2a4 4 0 014 4v3l1.5 2.5H2.5L4 9V6a4 4 0 014-4z"/><line x1="6.5" y1="13.5" x2="9.5" y2="13.5"/></>}
      {type === 'clusters' && <><rect x="2" y="2" width="12" height="4" rx="1"/><rect x="2" y="8" width="12" height="4" rx="1"/><line x1="5" y1="4" x2="5" y2="4" strokeWidth="2"/><line x1="5" y1="10" x2="5" y2="10" strokeWidth="2"/></>}
      {type === 'analytics' && <><polyline points="3,13 7,7 10,10 14,4"/><polyline points="11,4 14,4 14,7"/></>}
      {type === 'report' && <><path d="M5 3h8a1 1 0 011 1v12l-3-2-2 2-2-2-3 2V4a1 1 0 011-1z"/><line x1="7" y1="8" x2="11" y2="8"/><line x1="7" y1="11" x2="10" y2="11"/></>}
    </svg>
  );
}

function isActivePlatform(id, pathname) {
  if (id === 'cohesity') return ['/', '/dashboard', '/alerts', '/clusters', '/hardware', '/data-protection', '/analytics', '/reporting'].some(r => pathname === r || pathname.startsWith(r + '/'));
  if (id === 'pure') return pathname.startsWith('/pure');
  if (id === 'netapp') return pathname.startsWith('/netapp');
  return false;
}

export default function Layout() {
  const [alertCount, setAlertCount] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [clusterCount, setClusterCount] = useState(0);

  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;

  useEffect(() => {
    const load = async () => {
      try {
        const [alertResp, clusterResp] = await Promise.allSettled([
          client.get('/alerts?dismissed=0&resolved=0'),
          client.get('/clusters')
        ]);
        if (alertResp.status === 'fulfilled') {
          setAlerts(alertResp.value.data);
          setAlertCount(alertResp.value.data.length);
        }
        if (clusterResp.status === 'fulfilled') {
          setClusterCount(clusterResp.value.data.length);
        }
      } catch {
        // silently fail
      }
    };
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-cohesity-black">
      {/* Header */}
      <header className="h-14 bg-[#111111] border-b border-cohesity-border flex-shrink-0 flex items-center px-4 gap-4">
        <span className="text-gray-400 text-xl leading-none select-none">☰</span>
        <span className="text-base font-bold text-white">Global Cluster Dashboard</span>
        <div className="w-px h-5 bg-cohesity-border" />
        <span className="text-xs bg-cohesity-gray px-2 py-0.5 rounded text-gray-300">
          {clusterCount} Cohesity Cluster{clusterCount !== 1 ? 's' : ''}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <NotificationBell count={alertCount} alerts={alerts.slice(0, 10)} />
          <span className="text-gray-400 text-lg leading-none select-none">⚙</span>
          <span className="text-xs text-green-400">● Online</span>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-row flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-48 bg-[#111111] border-r border-cohesity-border flex flex-col flex-shrink-0 pt-2 gap-0.5">
          {navItems.map(item => {
            const active = item.isActive(pathname);
            return (
              <NavLink
                key={item.route}
                to={item.route}
                className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors mx-1 rounded-r ${
                  active
                    ? 'bg-cohesity-gray text-cohesity-text border-l-2 border-cohesity-green'
                    : 'text-gray-400 hover:bg-cohesity-gray/40 hover:text-cohesity-text'
                }`}
              >
                <NavIcon type={item.svg} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto flex flex-col">
          {/* Vendor tabs */}
          <div className="flex items-center gap-2 px-6 pt-5 pb-3 flex-shrink-0">
            <span className="text-xs text-gray-500 mr-2">Vendor Select</span>
            {platforms.map(p => {
              const active = isActivePlatform(p.id, pathname);
              return (
                <button
                  key={p.id}
                  onClick={() => navigate(p.route)}
                  className={`flex items-center gap-2 px-4 py-1.5 rounded border text-sm font-medium transition-colors ${
                    active
                      ? 'border-2 text-cohesity-text bg-cohesity-gray/60'
                      : 'border-cohesity-border text-gray-400 hover:border-gray-500 hover:text-cohesity-text'
                  }`}
                  style={active ? { borderColor: p.color } : {}}
                >
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                  {p.label}
                </button>
              );
            })}
            <button className="flex items-center gap-1.5 px-4 py-1.5 rounded border border-dashed border-cohesity-border text-gray-500 hover:border-gray-400 hover:text-gray-300 text-sm transition-colors">
              <span>+</span> Add Platform
            </button>
          </div>

          {/* Page content */}
          <div className="px-6 py-4 flex-1">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
