import { useState } from 'react';
import { Globe2, Activity, Network, AlertTriangle } from 'lucide-react';
import { PageHeader, StatCard, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, DASH } from '../logicmonitor/helpers';
import { SectionPanel, chipBtn } from '../logicmonitor/ui';
import { TrendLine } from '../logicmonitor/kit360';
import { BRAND, useF5Get } from './f5Shared';
import { FeedNote, PageError, CtlTable, dayPoints } from './f5Kit';

const DAYS = [7, 30, 90];
const sum = (a) => a.reduce((n, p) => n + (p.value || 0), 0);

export default function F5GtmPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/gtm', 'F5 GTM', { params: { days } });
  const req = data?.requestsPerDay || [];
  const res = data?.resolutionsPerDay || [];
  const ratio = data?.ratio || [];
  const events = Array.isArray(data?.wideIpAvailability) ? data.wideIpAvailability : [];
  const lastRatio = [...ratio].reverse().find((p) => p.value != null);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Globe2} title="GTM and DNS" description="Request and resolution rates, wide IP availability changes and the busiest wide IPs">
        <div className="flex items-center gap-1.5">
          {DAYS.map((d) => <button key={d} className={chipBtn(days === d)} onClick={() => setDays(d)}>{d} d</button>)}
        </div>
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Activity} label={`Requests, ${days} d`} value={fmtNum(Math.round(sum(req)))} loading={loading} />
        <StatCard icon={Network} label={`Resolutions, ${days} d`} value={fmtNum(Math.round(sum(res)))} loading={loading} />
        <StatCard icon={Globe2} label="Resolution ratio" value={lastRatio ? `${Math.round(lastRatio.value * 1000) / 10}%` : DASH} sub="latest day" loading={loading} />
        <StatCard icon={AlertTriangle} label="Wide IP changes" value={fmtNum(events.length)} tone={events.length ? 'warn' : 'ok'} sub={`in ${days} days`} loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading GTM data..." height={200} /> : data && data.present === false ? (
        <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>No GTM devices are classified as F5 yet.</div>
      ) : data && data.available === false ? <FeedNote what="GTM history" /> : (
        <div className="flex flex-col gap-4">
          <div className="grid xl:grid-cols-2 gap-4">
            <SectionPanel title="Requests and resolutions per day" blurb="Daily delta of the GTM counters; a counter reset is skipped, not counted as a negative day.">
              <TrendLine series={[{ label: 'Requests', points: dayPoints(req) }, { label: 'Resolutions', points: dayPoints(res), color: '#3FB950' }]} empty="No GTM counter history yet." />
            </SectionPanel>
            <SectionPanel title="Resolution ratio" blurb="Resolutions divided by requests. A falling ratio means requests are not being answered.">
              <TrendLine pct={false} series={[{ label: 'Ratio', points: dayPoints(ratio) }]} empty="No ratio yet." />
            </SectionPanel>
          </div>
          <SectionPanel title="Wide IP availability changes" blurb={data?.correlationNote}>
            <CtlTable rows={events.map((e) => ({ ...e, dcText: e.datacenters ? e.datacenters.join(', ') : null }))} searchKeys={['wideIp']} defaultSortKey="day" defaultSortDir="desc" empty="No wide IP availability changes in this window." pageSize={10}
              columns={[
                { k: 'day', label: 'Day' },
                { k: 'wideIp', label: 'Wide IP', render: (r) => <span className="text-ink">{r.wideIp || DASH}</span> },
                { k: 'range', label: 'State range', sortValue: (r) => r.min, render: (r) => (r.min == null ? DASH : `${r.min} to ${r.max}`) },
                { k: 'dcText', label: 'Data centers changing that day', render: (r) => (r.datacenters == null ? 'not in feed' : r.dcText || 'none') },
              ]} />
          </SectionPanel>
          <SectionPanel title="Busiest wide IPs">
            <CtlTable rows={data?.topWideIps || []} search={false} empty="No per wide IP counters yet." pageSize={10}
              columns={[
                { k: 'wideIp', label: 'Wide IP', render: (r) => r.wideIp || r.name || r.subject || DASH },
                { k: 'requests', label: 'Requests', align: 'right', render: (r) => (r.requests == null ? DASH : fmtNum(r.requests)) },
                { k: 'resolutions', label: 'Resolutions', align: 'right', render: (r) => (r.resolutions == null ? DASH : fmtNum(r.resolutions)) },
              ]} />
          </SectionPanel>
        </div>
      )}
    </div>
  );
}
