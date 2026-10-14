// Governance > Data Quality: the coverage score as a headline, then one list
// per gap kind. Every list exports its own CSV section.
import { useState } from 'react';
import { ShieldCheck, Cable, Network, MapPinOff, Radar } from 'lucide-react';
import { arr, fmtNum } from './helpers';
import { SectionPanel, chipBtn } from './ui';
import {
  ListSection, portNoDescColumns, switchNoNeighborColumns, deviceNoSiteColumns, checkNoBaselineColumns,
} from './governanceSections';

export default function DataQualitySection({ data }) {
  const d = data || {};
  const [which, setWhich] = useState('portsNoDescription');
  const score = Number.isFinite(Number(d.coverageScore)) ? Math.round(Number(d.coverageScore)) : null;
  const tone = score == null ? 'text-ink-muted' : score >= 90 ? 'text-status-ok' : score >= 70 ? 'text-status-warn' : 'text-status-crit';
  const lists = [
    { id: 'portsNoDescription', label: 'Ports without description', icon: Cable, rows: arr(d.portsNoDescription), columns: portNoDescColumns, searchKeys: ['deviceName', 'port'], sortKey: 'deviceName',
      title: 'Ports Without a Description', blurb: 'Network device ports that are up but carry no description, so ICC cannot derive a link from them. Name the far end in the port description and the link appears on the map.', empty: 'Every active port has a description.' },
    { id: 'switchesNoNeighbors', label: 'Switches without neighbors', icon: Network, rows: arr(d.switchesNoNeighbors), columns: switchNoNeighborColumns, searchKeys: ['deviceName'], sortKey: 'deviceName',
      title: 'Switches Without LLDP or CDP Data', blurb: 'Switches with no LLDP_Neighbors or CDP_Neighbors DataSource instance. Without them, switch ports cannot be matched to servers automatically.', empty: 'Every switch reports neighbor data.' },
    { id: 'devicesNoSite', label: 'Devices without a site', icon: MapPinOff, rows: arr(d.devicesNoSite), columns: deviceNoSiteColumns, searchKeys: ['deviceName'], sortKey: 'deviceName',
      title: 'Devices Without a Site', blurb: 'Devices no site rule matched. Put them in a group under Network, Sites, Locations or Branch, set a site property, or adjust the site rules under Settings, Scope.', empty: 'Every device belongs to a site.' },
    { id: 'checksNoBaseline', label: 'Checks without a baseline', icon: Radar, rows: arr(d.checksNoBaseline), columns: checkNoBaselineColumns, searchKeys: ['checkName', 'label'], sortKey: 'samples',
      title: 'Checks Without a Baseline', blurb: 'Reachability checks with too few samples to judge latency anomalies yet. They fill in on their own; a check that stays here is not being polled.', empty: 'Every check has a baseline.' },
  ];
  const cur = lists.find((l) => l.id === which) || lists[0];

  return (
    <div className="flex flex-col gap-4">
      <SectionPanel icon={ShieldCheck} title="Data Quality" blurb="How complete the data behind path blame, site rollups and endpoint matching is. The score drops as gaps grow.">
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Coverage score</p>
            <p className={`text-3xl font-semibold tnum ${tone}`}>{score == null ? '-' : score}<span className="text-sm text-ink-faint"> / 100</span></p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint">Unresolved links</p>
            <p className="text-lg font-semibold tnum text-ink">{fmtNum(d.unresolvedLinks)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-4">
          {lists.map((l) => <button key={l.id} onClick={() => setWhich(l.id)} className={chipBtn(cur.id === l.id)}>{l.label} ({fmtNum(l.rows.length)})</button>)}
        </div>
      </SectionPanel>
      <ListSection key={cur.id} section={cur.id} icon={cur.icon} title={cur.title} blurb={cur.blurb} rows={cur.rows}
        columns={cur.columns} searchKeys={cur.searchKeys} defaultSortKey={cur.sortKey} emptyText={cur.empty} />
    </div>
  );
}
