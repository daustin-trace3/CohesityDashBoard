import { Repeat, ShieldAlert, Gauge, Scale, Link2Off } from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum } from '../logicmonitor/helpers';
import { SectionPanel, Fact } from '../logicmonitor/ui';
import { BRAND, useF5Get } from './f5Shared';
import { sevTone, sevWord, n1, FeedNote, PageError } from './f5Kit';

const ROLE_TONE = { active: 'ok', standby: 'info', offline: 'crit', unknown: 'neutral' };

function UnitBox({ u }) {
  if (!u) {
    return (
      <div className="rounded-lg border border-dashed border-cohesity-border p-3 text-[12px] text-ink-faint">
        No partner unit found. Pairing is by device group or by site plus name stem.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-cohesity-border p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-ink text-[13px] truncate" title={u.device}>{u.device}</span>
        <Badge tone={ROLE_TONE[u.role] || 'neutral'}>{u.role}</Badge>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Fact label="CPU p95 (7 d)">{u.cpuP95 == null ? null : `${n1(u.cpuP95)}%`}</Fact>
        <Fact label="Baseline CPU">{u.cpuBaseline == null ? null : `${n1(u.cpuBaseline)}%`}</Fact>
        <Fact label="Client conns">{u.clientConnections == null ? null : fmtNum(u.clientConnections)}</Fact>
      </div>
    </div>
  );
}

function PairCard({ p }) {
  const h = p.headroom || {};
  return (
    <div className="panel p-4" style={{ borderLeft: `3px solid ${p.severity === 'critical' ? '#C75D5D' : p.severity === 'warning' ? '#D4A24E' : p.severity === 'info' ? '#4C9BE8' : '#3FB950'}` }}>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <Badge tone={sevTone(p.severity)}>{sevWord(p.severity)}</Badge>
        {p.bothActive && <Badge tone="crit">Both active</Badge>}
        {p.neitherActive && <Badge tone="crit">Neither active</Badge>}
        {p.partnerMissing && <Badge tone="warn">Unpaired</Badge>}
        {p.asymmetry && <Badge tone="info">Standby carries traffic</Badge>}
        <span className="text-[11px] text-ink-faint ml-auto">{p.syncState ? `Sync: ${p.syncState}` : 'Sync state not reported'}</span>
      </div>
      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <UnitBox u={p.units[0]} />
        <UnitBox u={p.units[1]} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Fact label="Days since failover">{p.daysSinceFailover == null ? 'none in history' : fmtNum(p.daysSinceFailover)}</Fact>
        <Fact label="Failovers, 90 d">{fmtNum(p.failovers90d)}</Fact>
        <Fact label="Failover headroom">
          {h.ok == null ? 'insufficient data' : `${n1(h.sum)}% of ${h.limit}% (${h.ok ? 'can absorb' : 'cannot absorb'})`}
        </Fact>
        <Fact label="Standby share of active">{p.standbyShare == null ? null : `${Math.round(p.standbyShare * 100)}%`}</Fact>
      </div>
      {p.reasons.length > 0 && (
        <ul className="mt-3 text-[12px] text-ink-muted list-disc pl-5">
          {p.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      {h.note && h.ok != null && <p className="text-[11px] text-ink-faint mt-2">{h.note}</p>}
    </div>
  );
}

export default function F5HaPage() {
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/ha', 'F5 HA pairs');
  const s = data?.summary || {};
  const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
  return (
    <div className="animate-fade-in">
      <PageHeader icon={Repeat} title="HA Pairs" description="Failover role, sync, headroom and asymmetry per BIG-IP pair, worst first">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Repeat} label="Pairs" value={fmtNum(s.pairs || 0)} sub={s.unpaired ? `${fmtNum(s.unpaired)} unpaired` : undefined} loading={loading} />
        <StatCard icon={ShieldAlert} label="At risk" value={fmtNum(s.atRisk || 0)} tone={s.atRisk ? 'crit' : 'ok'} sub={`${fmtNum(s.bothActive || 0)} both active, ${fmtNum(s.neitherActive || 0)} neither`} loading={loading} />
        <StatCard icon={Gauge} label="No headroom" value={fmtNum(s.noHeadroom || 0)} tone={s.noHeadroom ? 'warn' : 'ok'} sub="standby cannot absorb the active" loading={loading} />
        <StatCard icon={Scale} label="Asymmetric" value={fmtNum(s.asymmetric || 0)} tone={s.asymmetric ? 'info' : 'ok'} sub="standby over 20% of active" loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading HA pairs..." height={200} /> : data && data.available === false ? <FeedNote what="HA state" />
        : pairs.length === 0 ? (
          <div className="panel p-6 text-sm text-ink-muted text-center" style={{ borderTop: `3px solid ${BRAND}` }}>
            <Link2Off size={18} className="inline mr-2" />No BIG-IP units reported a failover state yet.
          </div>
        ) : (
          <SectionPanel title="Pairs, worst first" blurb="Both active and neither active are critical. Headroom is active p95 CPU plus standby baseline CPU against 80 percent, an estimate.">
            <div className="grid xl:grid-cols-2 gap-4">{pairs.map((p) => <PairCard key={p.pairKey} p={p} />)}</div>
          </SectionPanel>
        )}
    </div>
  );
}
