import { useEffect, useState, useCallback } from 'react';
import { Gauge, Server, DollarSign, Container, Database, BrainCircuit, ShieldAlert } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtBytes, fmtUsd, severityTone } from './helpers';

export default function AwsOverviewPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [issues, setIssues] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get('/aws/overview').then(({ data }) => setData(data)),
    client.get('/aws/issues').then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || [])).catch(() => setIssues([])),
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
    </div>
  );
}
