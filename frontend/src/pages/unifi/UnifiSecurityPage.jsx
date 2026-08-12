import { useEffect, useState, useCallback, useMemo } from 'react';
import { ShieldCheck, ShieldAlert, Ban, Target, ListChecks } from 'lucide-react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager } from '../../components/ui/tableTools';
import { BRAND, fmtNum, fmtWhen } from './helpers';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const chartOpts = {
  responsive: true, maintainAspectRatio: false, animation: false,
  plugins: { legend: { labels: { color: '#E5E5E5', boxWidth: 12, font: { size: 11 } } } },
  scales: {
    x: { stacked: true, ticks: { color: '#E5E5E5', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
    y: { stacked: true, ticks: { color: '#E5E5E5', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.1)' } },
  },
};

function PostureCards({ posture }) {
  if (!posture?.length) return null;
  return (
    <div className={`grid gap-3 mb-4 ${posture.length > 1 ? 'sm:grid-cols-2' : ''}`}>
      {posture.map((p) => (
        <div key={p.sourceId} className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
          <div className="flex items-start justify-between gap-2 mb-2">
            <p className="text-sm font-semibold text-ink flex items-center gap-2"><ShieldCheck size={15} className="text-brand" /> {p.sourceName || 'IPS / IDS'}</p>
            <Badge tone={p.mode && p.mode !== 'disabled' ? 'ok' : 'neutral'}>{p.mode || 'unknown'}</Badge>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge tone={p.honeypotEnabled ? 'ok' : 'neutral'}>Honeypot {p.honeypotEnabled ? 'On' : 'Off'}</Badge>
            <Badge tone={p.dnsFiltering ? 'ok' : 'neutral'}>DNS Filtering {p.dnsFiltering ? 'On' : 'Off'}</Badge>
            <Badge tone={p.adBlocking ? 'ok' : 'neutral'}>Ad Block {p.adBlocking ? 'On' : 'Off'}</Badge>
            <Badge tone={p.contentFiltering ? 'ok' : 'neutral'}>Content Filter {p.contentFiltering ? 'On' : 'Off'}</Badge>
            {p.enabledNetworksCount != null && <Badge tone="neutral">{p.enabledNetworksCount} network{p.enabledNetworksCount === 1 ? '' : 's'}</Badge>}
          </div>
        </div>
      ))}
    </div>
  );
}

function CompactList({ icon: Icon, title, rows, labelKey, countKey }) {
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
      <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><Icon size={15} className="text-brand" /> {title}</p>
      {!rows?.length ? (
        <div className="text-sm text-ink-muted py-4 text-center">No data in the last 24h.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <p className="text-xs text-ink truncate" title={r[labelKey]}>{r[labelKey] || '—'}</p>
              <span className="text-xs text-ink-faint tnum shrink-0">{fmtNum(r[countKey])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RulesTable({ rows, kind }) {
  const ctl = useTableControls(rows, {
    searchKeys: ['name', 'ruleset', 'action', 'protocol', 'src', 'dst'],
    defaultSortKey: 'rule_index', defaultSortDir: 'asc',
    paginate: true,
  });
  return (
    <>
      <TableControls ctl={ctl} rows={rows} searchPlaceholder="Filter by name, ruleset, action…"
        filters={[{ k: 'ruleset', label: 'Ruleset' }, { k: 'action', label: 'Action' }]} />
      {rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No {kind} rules collected.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No rules match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="name" label="Name" ctl={ctl} />
              <SortTh k="ruleset" label="Ruleset" ctl={ctl} />
              <SortTh k="rule_index" label="Index" ctl={ctl} align="right" />
              <SortTh k="action" label="Action" ctl={ctl} />
              <SortTh k="enabled" label="Enabled" ctl={ctl} />
              <SortTh k="protocol" label="Protocol" ctl={ctl} />
              <th className="py-2 pr-3">Src → Dst</th>
              <th className="py-2 pr-3">Logging</th>
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((r) => (
                <tr key={r.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3 text-ink">{r.name || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.ruleset || '—'}</td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{r.rule_index ?? '—'}</td>
                  <td className="py-2 pr-3"><Badge tone={r.action === 'accept' ? 'ok' : r.action === 'drop' || r.action === 'reject' ? 'crit' : 'neutral'}>{r.action || '—'}</Badge></td>
                  <td className="py-2 pr-3"><Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'Enabled' : 'Disabled'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.protocol || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] truncate max-w-[220px]" title={`${r.src || '—'} → ${r.dst || '—'}`}>{r.src || '—'} → {r.dst || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted">{r.logging ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </>
  );
}

export default function UnifiSecurityPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [ruleTab, setRuleTab] = useState('firewall');

  const load = useCallback(() => client.get('/unifi/security')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ ips: {}, rogueCounts: {}, events: [], posture: [], rules: { firewall: [], traffic: [] }, timeline: [], topDestinations: [], topOffenders: [], policyHits: [], rogueChanges: { newThisWeek: 0, flagged: [] } }); toast({ type: 'error', title: 'Failed to load security data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const ips = data?.ips || {};
  const rogueCounts = data?.rogueCounts || {};
  const events = data?.events || [];
  const posture = data?.posture || [];
  const rules = data?.rules || {};
  const timeline = data?.timeline || [];
  const topDestinations = data?.topDestinations || [];
  const topOffenders = data?.topOffenders || [];
  const policyHits = data?.policyHits || [];
  const rogueChanges = data?.rogueChanges || {};
  const flaggedRogues = rogueChanges.flagged || [];

  const threatChart = useMemo(() => ({
    labels: timeline.map((t) => t.hour),
    datasets: [
      { label: 'Blocks', data: timeline.map((t) => t.blocks), backgroundColor: '#C75D5D', borderRadius: 2 },
      { label: 'IPS', data: timeline.map((t) => t.ips), backgroundColor: BRAND, borderRadius: 2 },
    ],
  }), [timeline]);

  const ctl = useTableControls(events, {
    searchKeys: ['event_type', 'message', 'event_key'],
    defaultSortKey: 'occurred_at', defaultSortDir: 'desc',
    paginate: true,
  });

  const activeRules = ruleTab === 'firewall' ? (rules.firewall || []) : (rules.traffic || []);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldCheck} title="Security" description="Intrusion prevention status, rogue AP counts and security events">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? (
        <LoadingPanel label="Loading security data…" height={160} />
      ) : data.disabled ? (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          The Security module is disabled for this platform. Enable it under UniFi → Settings → Feature Modules to poll IPS state, firewall rules and threat events.
        </div>
      ) : (
        <>
          <PostureCards posture={posture} />

          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm font-semibold text-ink flex items-center gap-2"><ShieldCheck size={15} className="text-brand" /> IPS / IDS</p>
                <Badge tone={ips.enabled ? 'ok' : 'neutral'}>{ips.enabled ? 'Enabled' : 'Disabled'}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Categories</p>
                  <p className="text-sm text-ink tnum">{fmtNum(ips.categories?.length)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Ad Blocking</p>
                  <p className="text-sm text-ink">{ips.adBlocking ? 'On' : 'Off'}</p>
                </div>
              </div>
            </div>
            <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-sm font-semibold text-ink flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Rogue Access Points</p>
                {rogueChanges.newThisWeek > 0 && <Badge tone="warn">{rogueChanges.newThisWeek} new this week</Badge>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Total Seen</p>
                  <p className="text-lg font-bold text-ink tnum">{fmtNum(rogueCounts.total)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint">Flagged</p>
                  <p className={`text-lg font-bold tnum ${rogueCounts.flagged ? 'text-status-crit' : 'text-ink'}`}>{fmtNum(rogueCounts.flagged)}</p>
                </div>
              </div>
              {flaggedRogues.length > 0 && (
                <div className="mt-3 pt-3 border-t border-cohesity-border/50 flex flex-col gap-1.5">
                  {flaggedRogues.slice(0, 5).map((r) => (
                    <div key={r.bssid} className="flex items-center justify-between gap-2">
                      <p className="text-xs text-ink truncate">{r.essid || '(hidden)'} <span className="text-ink-faint">· {r.bssid}</span></p>
                      <span className="text-[10px] text-ink-faint tnum shrink-0">first seen {r.first_seen_at ? fmtWhen(r.first_seen_at) : '—'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <p className="text-sm font-semibold text-ink mb-3 flex items-center gap-2"><ShieldAlert size={15} className="text-brand" /> Threat Activity (24h)</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            {timeline.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No threat activity in the last 24h.</div>
            ) : (
              <div className="h-48"><Bar data={threatChart} options={chartOpts} /></div>
            )}
          </div>

          <div className="grid sm:grid-cols-3 gap-3 mb-4">
            <CompactList icon={Ban} title="Top Blocked Destinations" rows={topDestinations} labelKey="dst" countKey="count" />
            <CompactList icon={Target} title="Repeat Offenders" rows={topOffenders} labelKey="src" countKey="count" />
            <CompactList icon={ListChecks} title="Policy Hits" rows={policyHits} labelKey="policy" countKey="count" />
          </div>

          <p className="text-sm font-semibold text-ink mb-3">Rules</p>
          <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <div className="flex items-center gap-1 mb-3">
              {['firewall', 'traffic'].map((k) => (
                <button key={k} onClick={() => setRuleTab(k)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold capitalize cursor-pointer transition-colors ${ruleTab === k ? 'bg-brand/10 text-brand border border-brand/30' : 'text-ink-muted border border-transparent hover:text-ink'}`}>
                  {k}
                </button>
              ))}
            </div>
            <RulesTable rows={activeRules} kind={ruleTab} />
          </div>

          <p className="text-sm font-semibold text-ink mb-3">Security Events</p>
          <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
            <TableControls ctl={ctl} rows={events} searchPlaceholder="Filter by event type or message…"
              filters={[{ k: 'event_type', label: 'Types' }]} />
            {events.length === 0 ? (
              <div className="text-sm text-status-ok py-6 text-center">No security events recorded.</div>
            ) : ctl.rows.length === 0 ? (
              <div className="text-sm text-ink-muted py-6 text-center">No events match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                    <SortTh k="occurred_at" label="Time" ctl={ctl} />
                    <SortTh k="event_type" label="Event" ctl={ctl} />
                    <th className="py-2 pr-3">Message</th>
                  </tr></thead>
                  <tbody>
                    {ctl.pageRows.map((e) => (
                      <tr key={e.id} className="border-b border-cohesity-border/50">
                        <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(e.occurred_at)}</td>
                        <td className="py-2 pr-3"><Badge tone="crit">{e.event_type || e.event_key || '—'}</Badge></td>
                        <td className="py-2 pr-3 text-ink-muted max-w-[420px] truncate" title={e.message}>{e.message || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <TablePager ctl={ctl} />
          </div>
        </>
      )}
    </div>
  );
}
