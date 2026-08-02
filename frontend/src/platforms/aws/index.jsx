import { lazy } from 'react';
import { Gauge, DollarSign, Bell, Server, Boxes, Zap, Container, Package, Database, Table2, Network, BrainCircuit, Settings, Sparkles, Wrench, ShieldCheck as PrivacyIcon } from 'lucide-react';

const AwsOverviewPage = lazy(() => import('../../pages/aws/AwsOverviewPage'));
const AwsCostPage = lazy(() => import('../../pages/aws/AwsCostPage'));
const AwsOptimizerPage = lazy(() => import('../../pages/aws/AwsOptimizerPage'));
const AwsAlertsPage = lazy(() => import('../../pages/aws/AwsAlertsPage'));
const AwsAdvisorPage = lazy(() => import('../../pages/aws/AwsAdvisorPage'));
const AwsEc2Page = lazy(() => import('../../pages/aws/AwsEc2Page'));
const AwsLightsailPage = lazy(() => import('../../pages/aws/AwsLightsailPage'));
const AwsLambdaPage = lazy(() => import('../../pages/aws/AwsLambdaPage'));
const AwsEcsPage = lazy(() => import('../../pages/aws/AwsEcsPage'));
const AwsEcrPage = lazy(() => import('../../pages/aws/AwsEcrPage'));
const AwsRdsPage = lazy(() => import('../../pages/aws/AwsRdsPage'));
const AwsDynamoPage = lazy(() => import('../../pages/aws/AwsDynamoPage'));
const AwsS3Page = lazy(() => import('../../pages/aws/AwsS3Page'));
const AwsVpcPage = lazy(() => import('../../pages/aws/AwsVpcPage'));
const AwsBedrockPage = lazy(() => import('../../pages/aws/AwsBedrockPage'));
const AwsSettingsPage = lazy(() => import('../../pages/aws/AwsSettingsPage'));
const PrivacyInspectorPage = lazy(() => import('../../components/PrivacyInspectorPage'));
const AwsPrivacyPage = () => <PrivacyInspectorPage platform="aws" />;

// AWS sidebar — shown when the AWS platform is active.
const navGroups = [
  {
    label: 'Monitor',
    items: [
      { label: 'Overview', route: '/aws', icon: Gauge, isActive: (p) => p === '/aws' },
      { label: 'Cost', route: '/aws/cost', icon: DollarSign, isActive: (p) => p.startsWith('/aws/cost') },
      { label: 'Optimizer', route: '/aws/optimizer', icon: Wrench, isActive: (p) => p.startsWith('/aws/optimizer') },
      { label: 'AI Advisor', route: '/aws/advisor', icon: Sparkles, isActive: (p) => p.startsWith('/aws/advisor'), requiresAi: true },
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
      { label: 'Privacy Inspector', route: '/aws/privacy', icon: PrivacyIcon, isActive: (p) => p.startsWith('/aws/privacy'), requiresAi: true },
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
    { path: 'aws/optimizer', Component: AwsOptimizerPage },
    { path: 'aws/advisor', Component: AwsAdvisorPage },
    { path: 'aws/alerts', Component: AwsAlertsPage },
    { path: 'aws/ec2', Component: AwsEc2Page },
    { path: 'aws/lightsail', Component: AwsLightsailPage },
    { path: 'aws/lambda', Component: AwsLambdaPage },
    { path: 'aws/ecs', Component: AwsEcsPage },
    { path: 'aws/ecr', Component: AwsEcrPage },
    { path: 'aws/rds', Component: AwsRdsPage },
    { path: 'aws/dynamo', Component: AwsDynamoPage },
    { path: 'aws/s3', Component: AwsS3Page },
    { path: 'aws/vpc', Component: AwsVpcPage },
    { path: 'aws/bedrock', Component: AwsBedrockPage },
    { path: 'aws/privacy', Component: AwsPrivacyPage },
    { path: 'aws/settings', Component: AwsSettingsPage },
  ],
};
