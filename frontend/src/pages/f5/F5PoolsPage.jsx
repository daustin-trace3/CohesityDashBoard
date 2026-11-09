import { useMemo, useState } from 'react';
import { Layers, ShieldAlert, Scale, PauseCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { fmtNum, fmtMbps, DASH } from '../logicmonitor/helpers';
import { SectionPanel, chipBtn } from '../logicmonitor/ui';
import { useF5Get } from './f5Shared';
import { FeedNote, PageError, CtlTable } from './f5Kit';

const bitsText = (b) => (b == null ? DASH : fmtMbps(b / 1e6));

function MemberRows({ p }) {
  return (
    <table className="w-full text-sm mt-1">
      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
        <th className="py-1 pr-3">Member</th><th className="py-1 pr-3 text-right">Connections</th><th className="py-1 pr-3 text-right">In + out</th><th className="py-1 pr-3 text-right">Sessions</th>
      </tr></thead>
      <tbody>
        {p.members.slice().sort((a, b) => (b.connections ?? 0) - (a.connections ?? 0)).map((m) => (
          <tr key={m.member} className="border-t border-cohesity-border/30">
            <td className="py-1 pr-3 text-ink-muted text-[12px] font-mono">{m.member}</td>
            <td className={`py-1 pr-3 text-right tnum text-[12px] ${m.connections === 0 && p.totalConnections > 0 ? 'text-status-warn' : 'text-ink-muted'}`}>{m.connections == null ? DASH : fmtNum(m.connections)}</td>
            <td className="py-1 pr-3 text-right tnum text-ink-muted text-[12px]">{bitsText((m.bitsIn || 0) + (m.bitsOut || 0))}</td>
            <td className="py-1 pr-3 text-right tnum text-ink-muted text-[12px]">{m.sessions == null ? DASH : fmtNum(m.sessions)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function F5PoolsPage() {
  const { data, error, loading, reload, loadedAt } = useF5Get('/f5/pools', 'F5 pools');
  const [view, setView] = useState('all');
  const [open, setOpen] = useState(() => new Set());
  const pools = useMemo(() => (Array.isArray(data?.pools) ? data.pools : []), [data]);
  const s = data?.summary || {};
  const shown = useMemo(() => pools.filter((p) => view === 'all' || (view === 'spof' && p.spof) || (view === 'idle' && p.zeroMembers.length) || (view === 'imbalanced' && p.imbalanced))
    .map((p) => ({ ...p, key: `${p.sourceId}|${p.device}|${p.pool}`, flag: p.spof ? 0 : p.zeroMembers.length ? 1 : p.imbalanced ? 2 : 3 })), [pools, view]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Layers} title="Pools" description="Single points of failure, load imbalance, idle members and top talkers across the fleet">
        <LastUpdated date={loadedAt} prefix="Updated" />
        <RefreshButton onClick={reload} />
      </PageHeader>
      <PageError error={error} loading={loading} data={data} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Layers} label="Pools" value={fmtNum(s.pools || 0)} loading={loading} />
        <StatCard icon={ShieldAlert} label="Single point of failure" value={fmtNum(s.spof || 0)} tone={s.spof ? 'warn' : 'ok'} sub="one member carries the traffic" loading={loading} />
        <StatCard icon={Scale} label="Imbalanced" value={fmtNum(s.imbalanced || 0)} tone={s.imbalanced ? 'info' : 'ok'} loading={loading} />
        <StatCard icon={PauseCircle} label="With idle members" value={fmtNum(s.withIdleMembers || 0)} tone={s.withIdleMembers ? 'warn' : 'ok'} sub="0 connections beside busy siblings" loading={loading} />
      </div>
      {loading ? <LoadingPanel label="Loading pools..." height={200} /> : data && data.available === false ? <FeedNote what="Pool member data" /> : (
        <div className="flex flex-col gap-4">
          <SectionPanel title="Pools" blurb={data?.rules}
            right={(
              <div className="flex items-center gap-1.5">
                {[['all', 'All'], ['spof', 'Single point'], ['idle', 'Idle members'], ['imbalanced', 'Imbalanced']].map(([k, l]) => (
                  <button key={k} className={chipBtn(view === k)} onClick={() => setView(k)}>{l}</button>
                ))}
              </div>
            )}>
            <CtlTable rows={shown} searchKeys={['device', 'pool']} defaultSortKey="flag" empty="No pools match this view." rowKey={(r) => r.key}
              columns={[
                { k: 'pool', label: 'Pool', sortValue: (r) => r.pool, render: (r) => {
                  const isOpen = open.has(r.key);
                  const Chev = isOpen ? ChevronDown : ChevronRight;
                  return (
                    <div>
                      <button className="inline-flex items-center gap-1 text-ink cursor-pointer" onClick={() => setOpen((cur) => { const n = new Set(cur); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
                        <Chev size={13} className="text-ink-faint" />{r.pool}
                      </button>
                      {isOpen && <MemberRows p={r} />}
                    </div>
                  );
                } },
                { k: 'device', label: 'Unit' },
                { k: 'memberCount', label: 'Members', align: 'right', render: (r) => fmtNum(r.memberCount) },
                { k: 'totalConnections', label: 'Connections', align: 'right', render: (r) => fmtNum(r.totalConnections) },
                { k: 'totalBits', label: 'In + out', align: 'right', render: (r) => bitsText(r.totalBits) },
                { k: 'cv', label: 'Imbalance (CV)', align: 'right', render: (r) => (r.cv == null ? DASH : r.cv.toFixed(2)) },
                { k: 'flag', label: 'Finding', render: (r) => (
                  <span className="inline-flex gap-1 flex-wrap">
                    {r.spof && <Badge tone="warn" className="">{r.spofReason}</Badge>}
                    {r.zeroMembers.length > 0 && <Badge tone="warn">{`${r.zeroMembers.length} idle`}</Badge>}
                    {r.imbalanced && <Badge tone="info">Imbalanced</Badge>}
                    {!r.spof && !r.zeroMembers.length && !r.imbalanced && <Badge tone="ok">OK</Badge>}
                  </span>
                ) },
              ]} />
          </SectionPanel>
          <div className="grid xl:grid-cols-2 gap-4">
            <SectionPanel title="Top members by traffic" blurb="Highest combined bits in and out.">
              <CtlTable rows={data?.topMembers || []} search={false} empty="No member traffic collected." pageSize={10} defaultSortKey="bits" defaultSortDir="desc"
                columns={[
                  { k: 'member', label: 'Member', render: (r) => <span className="font-mono text-ink-muted">{r.member}</span> },
                  { k: 'pool', label: 'Pool' }, { k: 'device', label: 'Unit' },
                  { k: 'bits', label: 'In + out', align: 'right', render: (r) => bitsText(r.bits) },
                ]} />
            </SectionPanel>
            <SectionPanel title="Top pools by traffic">
              <CtlTable rows={data?.topPools || []} search={false} empty="No pool traffic collected." pageSize={10} defaultSortKey="bits" defaultSortDir="desc"
                columns={[
                  { k: 'pool', label: 'Pool' }, { k: 'device', label: 'Unit' },
                  { k: 'members', label: 'Members', align: 'right', render: (r) => fmtNum(r.members) },
                  { k: 'bits', label: 'In + out', align: 'right', render: (r) => bitsText(r.bits) },
                ]} />
            </SectionPanel>
          </div>
        </div>
      )}
    </div>
  );
}
