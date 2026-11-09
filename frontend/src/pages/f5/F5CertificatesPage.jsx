import { CalendarClock, ShieldAlert, ShieldCheck, Copy } from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel } from '../logicmonitor/ui';
import { useF5Get } from './f5Shared';
import { FeedNote, PageError, CtlTable } from './f5Kit';

const BUCKETS = [
  ['expired', 'Expired', 'crit'], ['lt7', 'Under 7 days', 'crit'], ['lt30', 'Under 30 days', 'warn'],
  ['lt60', 'Under 60 days', 'info'], ['lt90', 'Under 90 days', 'neutral'], ['gt90', 'Over 90 days', 'ok'],
];
const toneFor = (d) => (d < 0 ? 'crit' : d < 7 ? 'crit' : d < 30 ? 'warn' : d < 90 ? 'info' : 'neutral');
const dayText = (d) => (d < 0 ? `expired ${fmtNum(Math.abs(Math.round(d)))} d ago` : `${fmtNum(Math.round(d))} d`);

export default function F5CertificatesPage() {
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/certificates', 'F5 certificates');
  const b = data?.buckets || {};
  const certs = Array.isArray(data?.certs) ? data.certs : [];
  const weeks = Array.isArray(data?.weeks) ? data.weeks : [];
  const rows = certs.map((c) => ({ ...c, devicesText: c.devices.join(', '), copiesText: c.copies }));

  return (
    <div className="animate-fade-in">
      <PageHeader icon={CalendarClock} title="Certificates" description="VIP certificates across the fleet, counted once when the same certificate sits on both HA units">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ShieldAlert} label="Expired" value={fmtNum(b.expired || 0)} tone={b.expired ? 'crit' : 'ok'} loading={loading} />
        <StatCard icon={CalendarClock} label="Within 30 days" value={fmtNum((b.lt7 || 0) + (b.lt30 || 0))} tone={(b.lt7 || b.lt30) ? 'warn' : 'ok'} sub="not counting expired" loading={loading} />
        <StatCard icon={ShieldCheck} label="Unique certificates" value={fmtNum(data?.uniqueTotal || 0)} sub={`${fmtNum(data?.rawTotal || 0)} found on devices`} loading={loading} />
        <StatCard icon={Copy} label="Duplicates collapsed" value={fmtNum(data?.duplicatesCollapsed || 0)} loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading certificates..." height={200} /> : data && data.available === false ? <FeedNote what="The certificate list" /> : (
        <div className="flex flex-col gap-4">
          <SectionPanel title="Expiry buckets" blurb={data?.dedupeRule}>
            <div className="flex flex-wrap gap-3">
              {BUCKETS.map(([k, label, tone]) => (
                <div key={k} className="flex items-center gap-2"><Badge tone={tone}>{label}</Badge><span className="text-ink tnum text-sm">{fmtNum(b[k] || 0)}</span></div>
              ))}
            </div>
          </SectionPanel>
          <SectionPanel title="By week of expiry" blurb="Certificates expiring inside 90 days, grouped by the Monday of the week.">
            {weeks.length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">Nothing expires inside 90 days.</p> : (
              <div className="flex flex-col gap-3">
                {weeks.map((w) => (
                  <div key={w.week}>
                    <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1">Week of {w.week}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {w.certs.map((c) => <Badge key={`${c.stem}-${c.daysLeft}`} tone={toneFor(c.daysLeft)}>{`${c.instanceName} (${c.expiresOn})`}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionPanel>
          <SectionPanel title="All certificates" blurb="Soonest first. Copies counts the units or VIPs that carry the same certificate.">
            <CtlTable rows={rows} searchKeys={['instanceName', 'vip', 'devicesText']} defaultSortKey="daysLeft" empty="No certificate data is available." rowKey={(r) => `${r.stem}-${r.daysLeft}`}
              columns={[
                { k: 'instanceName', label: 'Certificate / profile', render: (r) => <span className="text-ink">{r.instanceName}</span> },
                { k: 'vip', label: 'VIP', render: (r) => r.vip || DASH },
                { k: 'daysLeft', label: 'Days left', render: (r) => <Badge tone={toneFor(r.daysLeft)}>{dayText(r.daysLeft)}</Badge> },
                { k: 'copiesText', label: 'Copies', align: 'right' },
                { k: 'devicesText', label: 'Units' },
              ]} />
          </SectionPanel>
          <SectionPanel title="By unit" blurb="Counts every copy, before de-duplication.">
            <CtlTable rows={data?.perDevice || []} searchKeys={['device']} defaultSortKey="expired" defaultSortDir="desc" empty="No units reported certificates." pageSize={10}
              columns={[
                { k: 'device', label: 'Unit' },
                { k: 'certs', label: 'Certificates', align: 'right' },
                { k: 'expired', label: 'Expired', align: 'right' },
                { k: 'lt30', label: 'Under 30 d', align: 'right' },
              ]} />
          </SectionPanel>
        </div>
      )}
    </div>
  );
}
