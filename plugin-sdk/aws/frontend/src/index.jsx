// AWS plugin frontend module. Bundled as an IIFE with no ESM imports at
// runtime — React/ReactDOM/ReactRouterDOM/Chart come from window globals
// (injected by the build banner, see plugin-sdk/build.mjs). Mirrors
// plugin-sdk/dell/frontend/src/index.jsx's registration shape.
//
// AWS has no feature-flag gating — the built-in platforms/aws/index.jsx nav
// is a static array, so navGroups here is static too. Privacy Inspector is
// DROPPED per the conversion plan: it needs the host-only
// components/PrivacyInspectorPage.jsx (not portable), same reason Dell
// dropped its own Privacy Inspector entry. AI Advisor and Alerts ARE
// ported, but self-contained (the built-in delegates to shared host
// components components/PlatformAdvisorPage.jsx and components/IssueAlertsPage.jsx,
// neither importable in a plugin sandbox) — same treatment Dell gave its
// AI Advisor page.

import { injectStyles } from './ui.jsx';
import { LOGO_DATA_URI } from './logo.js';
import {
  Gauge, DollarSign, Bell, Server, Boxes, Zap, Container, Package, Database, Table2, Network, BrainCircuit,
  Settings, Sparkles, Wrench,
} from './icons.jsx';

import OverviewPage from './pages/overview.jsx';
import CostPage from './pages/cost.jsx';
import OptimizerPage from './pages/optimizer.jsx';
import AdvisorPage from './pages/advisor.jsx';
import AlertsPage from './pages/alerts.jsx';
import Ec2Page from './pages/ec2.jsx';
import LightsailPage from './pages/lightsail.jsx';
import LambdaPage from './pages/lambda.jsx';
import EcsPage from './pages/ecs.jsx';
import EcrPage from './pages/ecr.jsx';
import RdsPage from './pages/rds.jsx';
import DynamoPage from './pages/dynamo.jsx';
import S3Page from './pages/s3.jsx';
import VpcPage from './pages/vpc.jsx';
import BedrockPage from './pages/bedrock.jsx';
import SettingsPage from './pages/settings.jsx';

const ACCENT = '#FF9900';

injectStyles();

const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aws', icon: Gauge, isActive: (p) => p === '/aws' },
      { label: 'Cost', route: '/aws/cost', icon: DollarSign, isActive: (p) => p.startsWith('/aws/cost') },
      { label: 'Optimizer', route: '/aws/optimizer', icon: Wrench, isActive: (p) => p.startsWith('/aws/optimizer') },
      { label: 'AI Advisor', route: '/aws/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/aws/advisor') },
      { label: 'Alerts', route: '/aws/alerts', icon: Bell, isActive: (p) => p.startsWith('/aws/alerts') },
    ],
  },
  {
    label: 'Compute',
    items: [
      { label: 'EC2', route: '/aws/ec2', icon: Server, isActive: (p) => p.startsWith('/aws/ec2') },
      { label: 'Lightsail', route: '/aws/lightsail', icon: Boxes, isActive: (p) => p.startsWith('/aws/lightsail') },
      { label: 'Lambda', route: '/aws/lambda', icon: Zap, isActive: (p) => p.startsWith('/aws/lambda') },
    ],
  },
  {
    label: 'Containers',
    items: [
      { label: 'ECS', route: '/aws/ecs', icon: Container, isActive: (p) => p.startsWith('/aws/ecs') },
      { label: 'ECR', route: '/aws/ecr', icon: Package, isActive: (p) => p.startsWith('/aws/ecr') },
    ],
  },
  {
    label: 'Database',
    items: [
      { label: 'RDS', route: '/aws/rds', icon: Database, isActive: (p) => p.startsWith('/aws/rds') },
      { label: 'DynamoDB', route: '/aws/dynamo', icon: Table2, isActive: (p) => p.startsWith('/aws/dynamo') },
    ],
  },
  {
    label: 'Storage',
    items: [
      { label: 'S3', route: '/aws/s3', icon: Database, isActive: (p) => p.startsWith('/aws/s3') },
    ],
  },
  {
    label: 'Network',
    items: [
      { label: 'VPC', route: '/aws/vpc', icon: Network, isActive: (p) => p.startsWith('/aws/vpc') },
    ],
  },
  {
    label: 'AI',
    items: [
      { label: 'Bedrock', route: '/aws/bedrock', icon: BrainCircuit, isActive: (p) => p.startsWith('/aws/bedrock') },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Settings', route: '/aws/settings', icon: Settings, isActive: (p) => p.startsWith('/aws/settings') },
    ],
  },
];

// Every page renders inside an .aw-root wrapper — the plugin stylesheet is
// scoped under it (see ui.jsx scopeCss) so its utility classes can't leak
// into host pages.
const rooted = (C) => function AwRooted() { return <div className="aw-root"><C /></div>; };

const routes = [
  { path: 'aws', Component: rooted(OverviewPage) },
  { path: 'aws/cost', Component: rooted(CostPage) },
  { path: 'aws/optimizer', Component: rooted(OptimizerPage) },
  { path: 'aws/advisor', Component: rooted(AdvisorPage) },
  { path: 'aws/alerts', Component: rooted(AlertsPage) },
  { path: 'aws/ec2', Component: rooted(Ec2Page) },
  { path: 'aws/lightsail', Component: rooted(LightsailPage) },
  { path: 'aws/lambda', Component: rooted(LambdaPage) },
  { path: 'aws/ecs', Component: rooted(EcsPage) },
  { path: 'aws/ecr', Component: rooted(EcrPage) },
  { path: 'aws/rds', Component: rooted(RdsPage) },
  { path: 'aws/dynamo', Component: rooted(DynamoPage) },
  { path: 'aws/s3', Component: rooted(S3Page) },
  { path: 'aws/vpc', Component: rooted(VpcPage) },
  { path: 'aws/bedrock', Component: rooted(BedrockPage) },
  { path: 'aws/settings', Component: rooted(SettingsPage) },
];

window.__ICC_REGISTER_PLUGIN__({
  id: 'aws',
  label: 'AWS',
  color: ACCENT,
  logo: LOGO_DATA_URI,
  switcherRoute: '/aws',
  basePath: '/aws',
  isActive: (p) => p.startsWith('/aws'),
  navGroups,
  routes,
});
