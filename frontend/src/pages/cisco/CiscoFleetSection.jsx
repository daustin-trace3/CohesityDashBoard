import { useState } from 'react';
import { SectionPanel, Tabs } from '../logicmonitor/ui';
import { AutoTable } from '../logicmonitor/kit360';
import { API, useCiscoGet } from './ciscoShared';

// Fleet hygiene on the Cisco overview: software version spread, availability, alert noise and reboots.
const TABS = [{ key: 'versions', label: 'Software versions' }, { key: 'availability', label: 'Availability' }, { key: 'noise', label: 'Alert noise' }, { key: 'reboots', label: 'Reboots' }];

export default function CiscoFleetSection() {
  const [tab, setTab] = useState('versions');
  const { data, error } = useCiscoGet(`${API}/fleet`, 'Cisco fleet hygiene', { params: { days: 30 }, interval: 300000 });
  if (error || !data || data.available === false) return null;
  const av = data.availability || {};
  const noise = data.alertNoise || {};
  const rebootRows = (data.reboots || []).map((r) => ({ device: r.device, site: r.site, rebootsLast30d: r.count, days: (r.events || []).map((e) => e.day || e.at).filter(Boolean).slice(0, 6).join(', ') }));
  return (
    <div className="mt-4">
      <SectionPanel title="Fleet hygiene" blurb="Availability excludes scheduled downtime days. Repeat offenders are alerts that fired 3 or more times in 7 days.">
        <Tabs tabs={TABS} active={tab} onSelect={setTab} />
        {tab === 'versions' && (
          <>
            <AutoTable rows={data.versions} empty="No software version data." preferred={['vendorKind', 'model', 'version', 'devices', 'dominant']} />
            {(data.outliers || []).length > 0 && <div className="mt-3"><p className="text-[11px] text-ink-faint mb-1">Devices on a non-dominant version for their model</p><AutoTable rows={data.outliers} preferred={['device', 'model', 'version', 'site']} /></div>}
          </>
        )}
        {tab === 'availability' && (
          <>
            <AutoTable rows={av.sites} empty="No availability data by site." preferred={['site', 'availabilityPct', 'devices']} />
            <div className="mt-3"><AutoTable rows={av.devices} empty="No availability data by device." preferred={['device', 'site', 'availabilityPct', 'deadDays', 'sdtDays', 'normalDays', 'days']} /></div>
          </>
        )}
        {tab === 'noise' && (
          <>
            <AutoTable rows={noise.byDataSource} empty="No alert history in this window." preferred={['name', 'alerts', 'medianMinutesToClear']} />
            <div className="mt-3"><p className="text-[11px] text-ink-faint mb-1">Repeat offenders</p><AutoTable rows={noise.repeatOffenders} empty="No repeat offenders." preferred={['device', 'type', 'count7d']} /></div>
          </>
        )}
        {tab === 'reboots' && <AutoTable rows={rebootRows} empty="No reboots detected (uptime resets) in the window." preferred={['device', 'site', 'rebootsLast30d', 'days']} />}
      </SectionPanel>
    </div>
  );
}
