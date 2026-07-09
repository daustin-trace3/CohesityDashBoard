import { useNavigate, useLocation } from 'react-router-dom';
import { Sparkles, Layers, KeyRound, Mail, Users, Puzzle } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';

// Grouped vertical nav shared by every Global Settings page. Each item is a
// real route so sections are bookmarkable and browser-back works.
const GROUPS = [
  {
    label: 'Intelligence',
    items: [
      { to: '/admin/ai', label: 'AI Analysis & Keys', icon: Sparkles, aliases: ['/admin'] },
    ],
  },
  {
    label: 'Platforms',
    items: [
      { to: '/admin/platforms', label: 'Platforms', icon: Layers },
      { to: '/admin/plugins', label: 'Plugins', icon: Puzzle, permission: 'admin:plugins:view' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/admin/license', label: 'Product License', icon: KeyRound },
      { to: '/admin/notifications', label: 'Alert Notifications', icon: Mail },
    ],
  },
  {
    label: 'Access',
    items: [
      { to: '/admin/users', label: 'Users & Access', icon: Users, permission: 'admin:users:view' },
    ],
  },
];

export default function AdminNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { hasPermission, loading: authLoading } = useAuth();

  const isActive = (item) =>
    pathname === item.to || (item.aliases || []).includes(pathname);

  return (
    <nav className="w-full md:w-48 shrink-0 flex flex-row md:flex-col flex-wrap gap-x-6 gap-y-4" aria-label="Global settings sections">
      {GROUPS.map(group => {
        const items = group.items.filter(i => !i.permission || authLoading || hasPermission(i.permission));
        if (items.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-col gap-0.5 min-w-[10rem]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint px-2 mb-1">{group.label}</p>
            {items.map(item => {
              const Icon = item.icon;
              const active = isActive(item);
              return (
                <button key={item.to} onClick={() => navigate(item.to)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] font-medium text-left transition-colors duration-150 cursor-pointer ${
                    active ? 'bg-surface-overlay text-ink shadow-panel' : 'text-ink-muted hover:text-ink'
                  }`}>
                  <Icon size={13} className={active ? 'text-brand' : ''} /> {item.label}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
