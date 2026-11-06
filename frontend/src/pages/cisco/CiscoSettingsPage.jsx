import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, Cable, BellRing } from 'lucide-react';
import { PageHeader, Badge, LoadingPanel } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';
import { fmtNum, fmtWhen, DASH, arr } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { BRAND, API, OLDER_VERSION, kindLabel, familyLabel, useCiscoGet } from './ciscoShared';

const SECTIONS = [
  { key: 'source', label: 'Source', icon: Cable },
  { key: 'notify', label: 'Alert Notifications', icon: BellRing },
];

const tabFromHash = () => {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '');
  return SECTIONS.some((x) => x.key === h) ? h : 'source';
};

function SourceSection() {
  const settings = useCiscoGet(`${API}/settings`, 'the Cisco settings', { interval: 0 });
  const s = settings.data;
  const shapeOk = !!s && typeof s === 'object' && Array.isArray(s.sources);
  const sources = shapeOk ? s.sources : [];
  const lmPath = (shapeOk && s.logicmonitorSettingsPath) || '/logicmonitor/settings?section=services';
  const kinds = Object.entries(shapeOk && s.kinds && typeof s.kinds === 'object' ? s.kinds : {})
    .filter(([, n]) => Number(n) > 0).sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <SectionPanel title="Source" blurb="Cisco has no connection of its own. Its data comes from the LogicMonitor portal that monitors the devices, so portals, credentials and polling are set up under LogicMonitor.">
      {settings.loading ? <LoadingPanel label="Loading source..." height={120} /> : (
        <div className="flex flex-col gap-4">
          {settings.error && <p className="text-sm text-status-crit">{settings.error}</p>}
          {!settings.error && !shapeOk && <p className="text-sm text-status-warn">{OLDER_VERSION}</p>}
          {shapeOk && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone="info">{`Derived from ${s.derivedFrom === 'logicmonitor' || !s.derivedFrom ? 'LogicMonitor' : s.derivedFrom}`}</Badge>
                <span className="text-[12px] text-ink-muted tnum">{`${fmtNum(s.matchedDevices ?? 0)} matched device${Number(s.matchedDevices) === 1 ? '' : 's'}`}</span>
              </div>

              {kinds.length === 0 ? (
                <p className="text-sm text-ink-muted">No Cisco or Meraki devices matched yet, so there is no kind breakdown. Kinds appear after the LogicMonitor inventory tick.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className={headRow}>
                      <th className="py-2 pr-3">Kind</th>
                      <th className="py-2 pr-3">Family</th>
                      <th className="py-2 pr-3 text-right">Devices</th>
                    </tr></thead>
                    <tbody>
                      {kinds.map(([k, n]) => (
                        <tr key={k} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink text-[12px]">{kindLabel(k)}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[12px]">{familyLabel(['mx', 'ms', 'mr', 'mv', 'mg'].includes(k) ? 'meraki' : 'cisco')}</td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(n)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {sources.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No LogicMonitor portal is configured. Add one under LogicMonitor Settings and Cisco devices appear here after its first inventory tick.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className={headRow}>
                      <th className="py-2 pr-3">Portal</th>
                      <th className="py-2 pr-3">Company</th>
                      <th className="py-2 pr-3">Last poll</th>
                      <th className="py-2 pr-3">Result</th>
                      <th className="py-2 pr-3 text-right">Devices</th>
                    </tr></thead>
                    <tbody>
                      {sources.map((r) => (
                        <tr key={r.id} className="border-b border-cohesity-border/50">
                          <td className="py-2 pr-3 text-ink text-[12px]">{r.name || `Portal ${r.id}`}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.company || DASH}</td>
                          <td className="py-2 pr-3 text-ink-muted text-[12px]">{r.lastPollAt ? fmtWhen(r.lastPollAt) : 'Never'}</td>
                          <td className="py-2 pr-3 text-[12px]">
                            <Badge tone={r.lastPollStatus === 'success' ? 'ok' : r.lastPollStatus === 'error' ? 'crit' : 'neutral'}>{r.lastPollStatus || 'No result'}</Badge>
                          </td>
                          <td className="py-2 pr-3 text-right tnum text-ink-muted text-[12px]">{fmtNum(r.devices)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap gap-4 text-[12px]">
                <Link to={lmPath} className="text-brand hover:underline">Cisco thresholds: LogicMonitor Settings, Rules, Services</Link>
                <Link to="/logicmonitor/settings?section=scope" className="text-brand hover:underline">Metric families and scope: LogicMonitor Settings, Scope</Link>
                <Link to="/logicmonitor/settings?section=portals" className="text-brand hover:underline">Portals and credentials</Link>
              </div>
              {arr(s.notes).length > 0 && (
                <ul className="list-disc pl-5 text-[12px] text-ink-muted">
                  {arr(s.notes).map((n, i) => <li key={i}>{String(n)}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </SectionPanel>
  );
}

export default function CiscoSettingsPage() {
  const [tab, setTab] = useState(tabFromHash);
  const selectTab = (key) => { setTab(key); try { window.history.replaceState(null, '', `#${key}`); } catch { /* ignore */ } };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="Cisco settings" description="Where the Cisco data comes from, and alert notifications for Cisco issue types" />
      <PlatformSettingsLayout brand={BRAND} label="Cisco" sections={SECTIONS} active={tab} onSelect={selectTab}>
        {tab === 'source' && <SourceSection />}
        {tab === 'notify' && <PlatformAlertNotifications platform="cisco" label="Cisco" />}
      </PlatformSettingsLayout>
    </div>
  );
}
