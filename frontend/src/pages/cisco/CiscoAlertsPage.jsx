import DerivedAlertsPage from '../../components/derived/DerivedAlertsPage';
import { BRAND, API } from './ciscoShared';

export default function CiscoAlertsPage() {
  return (
    <DerivedAlertsPage
      apiBase={API}
      label="Cisco"
      brand={BRAND}
      description="Alerts the LogicMonitor portal raised on Cisco and Meraki devices. Computed ICC issues are on the Issues page."
      emptyText="No open alerts on Cisco or Meraki devices. Alerts appear here when the portal raises one on a device ICC classified as Cisco or Meraki."
    />
  );
}
