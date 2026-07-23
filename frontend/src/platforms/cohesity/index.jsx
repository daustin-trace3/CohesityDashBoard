import { lazy } from 'react';
import {
  LayoutDashboard, Bell, Server, ShieldCheck, ArrowLeftRight, HardDrive,
  Activity, FileText, ClipboardCheck, Settings, Sparkles, BadgeCheck, FolderOpen, Layers, Flag,
} from 'lucide-react';

const Dashboard = lazy(() => import('../../pages/Dashboard'));
const AlertsPage = lazy(() => import('../../pages/AlertsPage'));
const HardwarePage = lazy(() => import('../../pages/HardwarePage'));
const ClusterManagement = lazy(() => import('../../pages/ClusterManagement'));
const GflagsPage = lazy(() => import('../../pages/GflagsPage'));

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Global Overview', route: '/cohesity', icon: LayoutDashboard, isActive: (p) => p === '/' || p === '/cohesity' },
      { label: 'AI Advisor', route: '/ai-advisor', icon: Sparkles, isActive: (p) => p.startsWith('/ai-advisor'), requiresAi: true },
      { label: 'Alerts', route: '/cohesity/alerts', icon: Bell, isActive: (p) => p.startsWith('/cohesity/alerts'), showAlertCount: true },
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
      { label: 'Clusters', route: '/cohesity/clusters', icon: Server, isActive: (p) => p.startsWith('/cohesity/clusters') },
      { label: 'Hardware', route: '/cohesity/hardware', icon: HardDrive, isActive: (p) => p.startsWith('/cohesity/hardware') },
      { label: 'GFlags', route: '/cohesity/gflags', icon: Flag, isActive: (p) => p.startsWith('/cohesity/gflags') },
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
  if (pathname.startsWith('/cohesity')) return true;
  return ['/', '/ai-advisor', '/analytics', '/reporting', '/licensing', '/data-protection', '/workloads', '/replication', '/views', '/governance', '/settings']
    .some(r => pathname === r || pathname.startsWith(r + '/'));
}

export default {
  id: 'cohesity',
  label: 'Cohesity',
  switcherRoute: '/cohesity',
  color: '#6CB33F',
  basePath: '/cohesity',
  isActive,
  navGroups,
  routes: [
    { path: 'cohesity', Component: Dashboard },
    { path: 'cohesity/alerts', Component: AlertsPage },
    { path: 'cohesity/hardware', Component: HardwarePage },
    { path: 'cohesity/clusters', Component: ClusterManagement },
    { path: 'cohesity/gflags', Component: GflagsPage },
  ],
};
