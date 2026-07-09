import { lazy } from 'react';
import {
  LayoutDashboard, Bell, Server, ShieldCheck, ArrowLeftRight, HardDrive,
  Activity, FileText, ClipboardCheck, Settings, Sparkles, BadgeCheck,
} from 'lucide-react';

const Dashboard = lazy(() => import('../../pages/Dashboard'));
const AlertsPage = lazy(() => import('../../pages/AlertsPage'));
const HardwarePage = lazy(() => import('../../pages/HardwarePage'));
const ClusterManagement = lazy(() => import('../../pages/ClusterManagement'));

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
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/settings', icon: Settings, isActive: (p) => p.startsWith('/settings') },
    ],
  },
];

function isActive(pathname) {
  return ['/', '/dashboard', '/ai-advisor', '/alerts', '/clusters', '/hardware', '/data-protection', '/replication', '/analytics', '/reporting', '/licensing', '/settings']
    .some(r => pathname === r || pathname.startsWith(r + '/'));
}

export default {
  id: 'cohesity',
  label: 'Cohesity',
  switcherRoute: '/dashboard',
  color: '#6CB33F',
  basePath: '/dashboard',
  isActive,
  navGroups,
  routes: [
    { path: 'dashboard', Component: Dashboard },
    { path: 'alerts', Component: AlertsPage },
    { path: 'hardware', Component: HardwarePage },
    { path: 'clusters', Component: ClusterManagement },
  ],
};
