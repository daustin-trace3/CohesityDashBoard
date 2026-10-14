import IssueAlertsPage from '../../components/IssueAlertsPage';

// Computed LogicMonitor issues with open/resolved history. The CONFIG entry
// for 'logicmonitor' in IssueAlertsPage.jsx is WP4's integration edit.
export default function LmIssuesPage() {
  return <IssueAlertsPage platform="logicmonitor" />;
}
