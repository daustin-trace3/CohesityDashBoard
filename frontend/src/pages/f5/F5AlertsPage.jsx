import DerivedAlertsPage from '../../components/derived/DerivedAlertsPage';
import { BRAND } from './f5Shared';

export default function F5AlertsPage() {
  return (
    <DerivedAlertsPage
      apiBase="/f5"
      label="F5"
      brand={BRAND}
      description="Alerts the LogicMonitor portal raised on F5 devices. Computed ICC issues are on the Issues page."
      emptyText="No open alerts on F5 devices. Alerts appear here when the portal raises one on a device ICC classified as F5."
    />
  );
}
