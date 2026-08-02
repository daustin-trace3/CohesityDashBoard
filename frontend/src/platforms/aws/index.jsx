import { lazy } from 'react';
import { Gauge, DollarSign, Bell, Server, Boxes, Container, Database, BrainCircuit, Settings } from 'lucide-react';

const AwsOverviewPage = lazy(() => import('../../pages/aws/AwsOverviewPage'));
const AwsCostPage = lazy(() => import('../../pages/aws/AwsCostPage'));
const AwsAlertsPage = lazy(() => import('../../pages/aws/AwsAlertsPage'));
const AwsEc2Page = lazy(() => import('../../pages/aws/AwsEc2Page'));
const AwsLightsailPage = lazy(() => import('../../pages/aws/AwsLightsailPage'));
const AwsEcsPage = lazy(() => import('../../pages/aws/AwsEcsPage'));
const AwsS3Page = lazy(() => import('../../pages/aws/AwsS3Page'));
const AwsBedrockPage = lazy(() => import('../../pages/aws/AwsBedrockPage'));
const AwsSettingsPage = lazy(() => import('../../pages/aws/AwsSettingsPage'));

// AWS sidebar — shown when the AWS platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aws', icon: Gauge, isActive: (p) => p === '/aws' },
      { label: 'Cost', route: '/aws/cost', icon: DollarSign, isActive: (p) => p.startsWith('/aws/cost') },
      { label: 'Alerts', route: '/aws/alerts', icon: Bell, isActive: (p) => p.startsWith('/aws/alerts') },
    ],
  },
  {
    label: 'Compute',
    items: [
      { label: 'EC2', route: '/aws/ec2', icon: Server, isActive: (p) => p.startsWith('/aws/ec2') },
      { label: 'Lightsail', route: '/aws/lightsail', icon: Boxes, isActive: (p) => p.startsWith('/aws/lightsail') },
      { label: 'ECS', route: '/aws/ecs', icon: Container, isActive: (p) => p.startsWith('/aws/ecs') },
    ],
  },
  {
    label: 'Storage',
    items: [
      { label: 'S3', route: '/aws/s3', icon: Database, isActive: (p) => p.startsWith('/aws/s3') },
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

function isActive(pathname) {
  return pathname.startsWith('/aws');
}

export default {
  id: 'aws',
  label: 'AWS',
  switcherRoute: '/aws',
  color: '#FF9900',
  basePath: '/aws',
  isActive,
  navGroups,
  routes: [
    { path: 'aws', Component: AwsOverviewPage },
    { path: 'aws/cost', Component: AwsCostPage },
    { path: 'aws/alerts', Component: AwsAlertsPage },
    { path: 'aws/ec2', Component: AwsEc2Page },
    { path: 'aws/lightsail', Component: AwsLightsailPage },
    { path: 'aws/ecs', Component: AwsEcsPage },
    { path: 'aws/s3', Component: AwsS3Page },
    { path: 'aws/bedrock', Component: AwsBedrockPage },
    { path: 'aws/settings', Component: AwsSettingsPage },
  ],
};
