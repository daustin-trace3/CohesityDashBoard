import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings, Network, FolderTree, Activity, Server, Globe, Cable, BellRing, Database, Archive, Layers, Cpu } from 'lucide-react';
import client from '../../api/client';
import { PageHeader } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';
import { BRAND } from './helpers';
import LmPortalsPanel from './LmPortalsPanel';
import { LmScopePanel } from './LmScopeThresholds';
import { LmInterfacesRulesPanel, LmDevicesRulesPanel, LmReachabilityRulesPanel, LmCircuitsRulesPanel, LmServicesRulesPanel, LmRetentionPanel } from './LmRulesPanels';
import LmDataExportPanel from './LmDataExportPanel';
import LmCollectorsPage from './LmCollectorsPage';

const SECTIONS = [
  { key: 'portals', label: 'Portals', icon: Network, group: 'Connections' },
  { key: 'scope', label: 'Scope', icon: FolderTree, group: 'Connections' },
  { key: 'collectors', label: 'Collectors', icon: Cpu, group: 'Connections' },
  { key: 'interfaces', label: 'Interfaces', icon: Activity, group: 'Rules' },
  { key: 'devices', label: 'Devices and alerts', icon: Server, group: 'Rules' },
  { key: 'reachability', label: 'Site reachability', icon: Globe, group: 'Rules' },
  { key: 'circuits', label: 'Circuits', icon: Cable, group: 'Rules' },
  { key: 'services', label: 'Services', icon: Layers, group: 'Rules' },
  { key: 'notify', label: 'Alert Notifications', icon: BellRing, group: 'Notifications' },
  { key: 'retention', label: 'Retention and limits', icon: Archive, group: 'Data' },
  { key: 'export', label: 'Data Export', icon: Database, group: 'Data' },
];

// The old single Thresholds section opens Interfaces.
const resolveSection = (v) => {
  if (v === 'thresholds') return 'interfaces';
  return SECTIONS.some((s) => s.key === v) ? v : 'portals';
};

export default function LmSettingsPage() {
  const [params, setParams] = useSearchParams();
  const section = resolveSection(params.get('section'));
  const setSection = (key) => setParams((cur) => { const n = new URLSearchParams(cur); n.set('section', key); return n; }, { replace: true });
  const [sources, setSources] = useState(null);

  const loadSources = useCallback(() => client.get('/logicmonitor/sources')
    .then(({ data }) => setSources(Array.isArray(data) ? data : data?.sources || []))
    .catch(() => setSources([])), []);

  useEffect(() => { loadSources(); }, [loadSources]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="LogicMonitor Settings" description="Connect LogicMonitor portals, set the collection scope and tune issue detection" />
      <PlatformSettingsLayout brand={BRAND} label="LogicMonitor" sections={SECTIONS} active={section} onSelect={setSection}>
        {section === 'portals' && <LmPortalsPanel sources={sources} reload={loadSources} />}
        {section === 'scope' && <LmScopePanel sources={sources} reload={loadSources} />}
        {section === 'collectors' && <LmCollectorsPage embedded />}
        {section === 'interfaces' && <LmInterfacesRulesPanel />}
        {section === 'devices' && <LmDevicesRulesPanel />}
        {section === 'reachability' && <LmReachabilityRulesPanel />}
        {section === 'circuits' && <LmCircuitsRulesPanel />}
        {section === 'services' && <LmServicesRulesPanel />}
        {section === 'notify' && <PlatformAlertNotifications platform="logicmonitor" label="LogicMonitor" />}
        {section === 'retention' && <LmRetentionPanel />}
        {section === 'export' && <LmDataExportPanel />}
        <p className="text-[11px] text-ink-faint leading-relaxed">
          The LogicMonitor platform tab itself is enabled from Global Settings (gear icon, Platforms).
        </p>
      </PlatformSettingsLayout>
    </div>
  );
}
