import { TrendingUp, PiggyBank, LineChart } from 'lucide-react';
import PlatformAdvisorPage from '../../components/PlatformAdvisorPage';

const BRAND = '#FF9900';

const TABS = [
  { slug: 'cost-growth', label: 'Cost Growth Attribution', icon: TrendingUp,
    blurb: 'Which services and resources drove recent cost increases.' },
  { slug: 'finops-waste', label: 'Waste & Savings', icon: PiggyBank,
    blurb: 'Idle and unoptimized resources with estimated savings.' },
  { slug: 'monthly-trend', label: 'Monthly Trend', icon: LineChart,
    blurb: 'Long-term spend trajectory and month-over-month movers.' },
];

export default function AwsAdvisorPage() {
  return <PlatformAdvisorPage platform="aws" brand={BRAND} title="AI Advisor" tabs={TABS} />;
}
