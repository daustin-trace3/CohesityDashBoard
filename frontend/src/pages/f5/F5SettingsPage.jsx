import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings, Cable, BellRing } from 'lucide-react';
import { PageHeader, Badge, LoadingPanel } from '../../components/ui/primitives';
import PlatformSettingsLayout from '../../components/PlatformSettingsLayout';
import PlatformAlertNotifications from '../../components/PlatformAlertNotifications';
import { fmtNum, fmtWhen, DASH, arr } from '../logicmonitor/helpers';
import { SectionPanel, headRow } from '../logicmonitor/ui';
import { BRAND, OLDER_VERSION, kindLabel, useF5Get } from './f5Shared';

const SECTIONS = [
  { key: 'source', label: 'Source', icon: Cable },
  { key: 'notify', label: 'Alert Notifications', icon: BellRing },
];

const tabFromHash = () => {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '');
  return SECTIONS.some((x) => x.key === h) ? h : 'source';
};

function SourceSection() {
  const settings = useF5Get('/f5/settings', 'the F5 settings', { interval: 0 });
  const overview = useF5Get('/f5/overview', 'the F5 device counts', { interval: 0 });
  const s = settings.data;
  const shapeOk = !!s && typeof s === 'object' && Array.isArray(s.sources);
  const sources = shapeOk ? s.sources : [];
  const lmPath = (shapeOk && s.logicmonitorSettingsPath) || '/logicmonitor/settings?section=services';
  const dev = overview.data?.devices || {};
  const kinds = ['bigip', 'gtm', 'f5os'].filter((k) => Number(dev[k]) > 0);

  return (
    <SectionPanel title="Source" blurb="F5 has no connection of its own. Its data comes from the LogicMonitor portal that monitors the devices, so portals, credentials and polling are set up under LogicMonitor.">
      {settings.loading ? <LoadingPanel label="Loading source..." height={120} /> : (
        <div className="flex flex-col gap-4">
          {settings.error && <p className="text-sm text-status-crit">{settings.error}</p>}
          {!settings.error && !shapeOk && <p className="text-sm text-status-warn">{OLDER_VERSION}</p>}
          {shapeOk && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone="info">{`Derived from ${s.derivedFrom === 'logicmonitor' || !s.derivedFrom ? 'LogicMonitor' : s.derivedFrom}`}</Badge>
                <span className="text-[12px] text-ink-muted tnum">{`${fmtNum(s.matchedDevices ?? 0)} matched device${Number(s.matchedDevices) === 1 ? '' : 's'}`}</span>
                {kinds.map((k) => <Badge key={k} tone="neutral">{`${kindLabel(k)} ${fmtNum(dev[k])}`}</Badge>)}
              </div>

              {sources.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No LogicMonitor portal is configured. Add one under LogicMonitor Settings and F5 devices appear here after its first inventory tick.
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
                <Link to={lmPath} className="text-brand hover:underline">F5 thresholds: LogicMonitor Settings, Rules, Services</Link>
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

export default function F5SettingsPage() {
  const [tab, setTab] = useState(tabFromHash);
  const selectTab = (key) => { setTab(key); try { window.history.replaceState(null, '', `#${key}`); } catch { /* ignore */ } };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Settings} title="F5 settings" description="Where the F5 data comes from, and alert notifications for F5 issue types" />
      <PlatformSettingsLayout brand={BRAND} label="F5" sections={SECTIONS} active={tab} onSelect={selectTab}>
        {tab === 'source' && <SourceSection />}
        {tab === 'notify' && <PlatformAlertNotifications platform="f5" label="F5" />}
      </PlatformSettingsLayout>
    </div>
  );
}
