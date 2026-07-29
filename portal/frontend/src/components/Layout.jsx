import { NavLink } from 'react-router-dom';
import { LayoutGrid, Building2, Users, LogOut, TowerControl } from 'lucide-react';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/tenants', label: 'Tenants', icon: Building2 },
  { to: '/users', label: 'Users', icon: Users },
];

export default function Layout({ user, onLogout, children }) {
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 flex-shrink-0 border-r border-cohesity-border bg-surface-base flex flex-col">
        <div className="px-4 py-5 border-b border-cohesity-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand/15 border border-brand/30 flex items-center justify-center">
              <TowerControl size={17} className="text-brand" />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-bold text-ink">Infrastructure</p>
              <p className="text-sm font-bold text-brand -mt-0.5">Command Center</p>
            </div>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-ink-faint mt-2">MSP Portal</p>
        </div>

        <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                  isActive ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink hover:bg-surface-raised'
                }`
              }
            >
              <Icon size={15} /> {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-3 border-t border-cohesity-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink truncate">{user.displayName || user.username}</p>
            <p className="text-[10px] text-ink-faint truncate">{user.username}</p>
          </div>
          <button
            onClick={onLogout}
            title="Sign out"
            className="p-1.5 rounded-md text-ink-faint hover:text-status-crit hover:bg-surface-raised transition-colors cursor-pointer"
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 px-6 py-5 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
