import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, DollarSign, Container, Database, BrainCircuit, ShieldAlert, Activity, Network, HardDrive } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtUsd, severityTone, dateAgo } from './helpers';

export default function AwsOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [health, setHealth] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aws/overview').then(({ data }) => setData(data)),
    client.get('/aws/issues').then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || [])).catch(() => setIssues([])),
    client.get('/aws/health').then(({ data }) => setHealth(data)).catch(() => setHealth({ operational: true, events: [] })),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setData({}); toast({ type: 'error', title: 'Failed to load AWS overview' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const accounts = data?.accounts;
  const accountCount = Array.isArray(accounts) ? accounts.length : (accounts ?? 0);
  const ec2 = data?.ec2 || {};
  const lightsail = data?.lightsail || {};
  const ecs = data?.ecs || {};
  const s3 = data?.s3 || {};
  const cost = data?.cost || {};
  const bedrock = data?.bedrock || {};
  const iss = data?.issues || {};
  const totalIssues = (iss.critical || 0) + (iss.warning || 0) + (iss.info || 0);
  const topServices = cost.topServices || [];
  const accountsDetail = data?.accountsDetail || [];
  const estate = data?.estate || {};
  const topMovers = estate.topMovers || [];
  const healthEvents = health?.events || [];

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Gauge} title="AWS Overview" description="EC2, Lightsail, ECS, S3, Bedrock usage and cost across all registered AWS accounts">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {accountCount === 0 && data && (
        <div className="panel p-4 mb-4 border border-status-warn/40">
          <p className="text-sm text-ink">
            No AWS accounts registered yet. Add one under{' '}
            <Link to="/aws/settings" className="text-brand underline">AWS → Settings</Link> to start polling.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
        <StatCard icon={Server} label="EC2 Instances" value={ec2.total != null ? `${fmtNum(ec2.running)} / ${fmtNum(ec2.total)}` : '—'}
          sub="running / total" tone={ec2.alarmed ? 'crit' : 'brand'}
          onClick={() => navigate('/aws/ec2')} />
        <StatCard icon={DollarSign} label="MTD Spend" value={fmtUsd(cost.mtdUsd)}
          sub={cost.deltaPct != null ? `${cost.deltaPct > 0 ? '+' : ''}${cost.deltaPct.toFixed(1)}% vs prior day` : undefined}
          trend={cost.deltaPct}
          tone={cost.deltaPct > 0 ? 'warn' : 'default'}
          onClick={() => navigate('/aws/cost')} />
        <StatCard icon={Container} label="ECS Degraded" value={fmtNum(ecs.degraded)}
          sub={`${fmtNum(ecs.services)} services · ${fmtNum(ecs.clusters)} clusters`}
          tone={ecs.degraded ? 'crit' : 'ok'}
          onClick={() => navigate('/aws/ecs')} />
        <StatCard icon={Database} label="S3 Total Size" value={fmtBytes(s3.totalSizeBytes)}
          sub={`${fmtNum(s3.buckets)} buckets · ${fmtNum(s3.totalObjects)} objects`}
          onClick={() => navigate('/aws/s3')} />
        <StatCard icon={BrainCircuit} label="Bedrock Invocations" value={fmtNum(bedrock.invocations30d)}
          sub="last 30 days" onClick={() => navigate('/aws/bedrock')} />
        <StatCard icon={ShieldAlert} label="Issues" value={fmtNum(totalIssues)}
          sub={totalIssues ? `${iss.critical || 0} critical` : 'all clear'}
          tone={iss.critical ? 'crit' : totalIssues ? 'warn' : 'ok'}
          onClick={() => navigate('/aws/alerts')} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><DollarSign size={15} className="text-brand" /> Top Services (MTD)</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : topServices.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">No cost data yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-1.5 pr-3">Service</th>
                <th className="py-1.5 pr-3 text-right">MTD Spend</th>
              </tr></thead>
              <tbody>
                {topServices.map((s) => (
                  <tr key={s.service} className="border-b border-cohesity-border/40">
                    <td className="py-1.5 pr-3 text-ink">{s.service}</td>
                    <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtUsd(s.mtdUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-ink flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Recent Issues</p>
            <Link to="/aws/alerts" className="text-[11px] text-brand hover:underline">View all →</Link>
          </div>
          {issues == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : issues.length === 0 ? (
            <div className="text-sm text-status-ok py-6 text-center">No open issues.</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {issues.slice(0, 8).map((i, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone={severityTone(i.severity)}>{i.severity}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{i.message}</p>
                    <p className="text-[10px] text-ink-faint">{i.account}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="panel p-4 lg:col-span-2" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Server size={15} className="text-brand" /> Estate Status</p>
          {data == null ? (
            <LoadingPanel label="Loading…" height={180} />
          ) : (
            <div className="flex flex-col gap-3">
              {accountsDetail.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {accountsDetail.map((a) => (
                    <div key={a.id} className="flex items-center gap-1.5 bg-surface-overlay rounded-lg px-2.5 py-1.5 border border-cohesity-border">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${a.lastPollStatus === 'error' ? 'bg-status-crit' : a.lastPollStatus === 'success' ? 'bg-status-ok' : 'bg-status-warn'}`} />
                      <span className="text-xs text-ink font-medium">{a.name}</span>
                      <span className="text-[10px] text-ink-faint">{a.region}</span>
                      <span className="text-[10px] text-ink-faint">· {dateAgo(a.lastPollAt)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button onClick={() => navigate('/aws/ec2')} className="text-left bg-surface-overlay rounded-lg px-3 py-2 hover:border-brand/40 border border-transparent transition-colors">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><HardDrive size={11} /> Unattached EBS</p>
                  <p className="text-base font-bold text-ink tnum">{fmtNum(estate.unattachedEbs)}</p>
                </button>
                <button onClick={() => navigate('/aws/vpc')} className="text-left bg-surface-overlay rounded-lg px-3 py-2 hover:border-brand/40 border border-transparent transition-colors">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Network size={11} /> NAT Gateways</p>
                  <p className="text-base font-bold text-ink tnum">{fmtNum(estate.natGateways)}</p>
                </button>
                <button onClick={() => navigate('/aws/alerts')} className="text-left bg-surface-overlay rounded-lg px-3 py-2 hover:border-brand/40 border border-transparent transition-colors">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Critical Issues</p>
                  <p className="text-base font-bold text-status-crit tnum">{fmtNum(iss.critical || 0)}</p>
                </button>
                <button onClick={() => navigate('/aws/alerts')} className="text-left bg-surface-overlay rounded-lg px-3 py-2 hover:border-brand/40 border border-transparent transition-colors">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Warning Issues</p>
                  <p className="text-base font-bold text-status-warn tnum">{fmtNum(iss.warning || 0)}</p>
                </button>
              </div>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-1.5">Top Movers (day over day)</p>
                {topMovers.length === 0 ? (
                  <div className="text-xs text-ink-muted py-3 text-center">No significant spend movement.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                      <th className="py-1.5 pr-3">Service</th>
                      <th className="py-1.5 pr-3 text-right">Prev Day</th>
                      <th className="py-1.5 pr-3 text-right">Last Day</th>
                      <th className="py-1.5 pr-3 text-right">Δ</th>
                    </tr></thead>
                    <tbody>
                      {topMovers.map((m) => (
                        <tr key={m.service} className="border-b border-cohesity-border/40">
                          <td className="py-1.5 pr-3 text-ink">{m.service}</td>
                          <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtUsd(m.prevUsd)}</td>
                          <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtUsd(m.lastUsd)}</td>
                          <td className={`py-1.5 pr-3 text-right tnum font-semibold ${m.deltaUsd > 0 ? 'text-status-crit' : m.deltaUsd < 0 ? 'text-status-ok' : 'text-ink-faint'}`}>
                            {m.deltaUsd > 0 ? '+' : ''}{fmtUsd(m.deltaUsd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Activity size={15} className="text-brand" /> AWS Service Health</p>
          {health == null ? (
            <LoadingPanel label="Loading…" height={140} />
          ) : health.operational && healthEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-status-ok" style={{ animation: 'orb-pulse 2.5s ease-in-out infinite' }} />
              <p className="text-sm text-status-ok font-medium">All monitored services operational</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[45vh] overflow-y-auto pr-1">
              {healthEvents.slice(0, 8).map((e, idx) => (
                <div key={idx} className="flex items-start gap-2.5 bg-surface-overlay rounded-lg px-3 py-2">
                  <Badge tone="warn">{e.service}</Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-ink leading-relaxed">{e.title}</p>
                    <p className="text-[10px] text-ink-faint">{e.region} · {dateAgo(e.publishedAt)}</p>
                  </div>
                </div>
              ))}
              {healthEvents.length === 0 && (
                <div className="text-sm text-ink-muted py-6 text-center">No recent events.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
