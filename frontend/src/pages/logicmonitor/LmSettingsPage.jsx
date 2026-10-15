import { useEffect, useState, useCallback } from 'react';
import { Settings, Network, FolderTree, Gauge, BellRing, Database } from 'lucide-react';
import client from '../../api/client';
import { PageHeader } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';
import { BRAND } from './helpers';
import LmPortalsPanel from './LmPortalsPanel';
import { LmScopePanel, LmThresholdsPanel } from './LmScopeThresholds';
import LmDataExportPanel from './LmDataExportPanel';

const SECTIONS = [
  { key: 'portals', label: 'Portals', icon: Network, group: 'Connections' },
  { key: 'scope', label: 'Scope', icon: FolderTree, group: 'Connections' },
  { key: 'thresholds', label: 'Thresholds', icon: Gauge, group: 'Tuning' },
  { key: 'notify', label: 'Alert Notifications', icon: BellRing, group: 'Tuning' },
  { key: 'export', label: 'Data Export', icon: Database, group: 'Data' },
];

export default function LmSettingsPage() {
  const [section, setSection] = useState('portals');
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
        {section === 'thresholds' && <LmThresholdsPanel />}
        {section === 'notify' && <PlatformAlertNotifications platform="logicmonitor" label="LogicMonitor" />}
        {section === 'export' && <LmDataExportPanel />}
        <p className="text-[11px] text-ink-faint leading-relaxed">
          The LogicMonitor platform tab itself is enabled from Global Settings (gear icon, Platforms).
        </p>
      </PlatformSettingsLayout>
    </div>
  );
}
