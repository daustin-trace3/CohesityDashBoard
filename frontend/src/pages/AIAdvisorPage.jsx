import { useEffect, useState, useCallback } from 'react';
import {
  Sparkles, Database, ArrowLeftRight, FileText, Clock,
  Newspaper, ShieldAlert, Gauge, BellRing, ShieldCheck, GitCompareArrows, ArrowUpCircle,
} from 'lucide-react';
import client from '../api/client';
import AdvisorReportModal from '../components/AdvisorReportModal';
import AiPrivacyModal from '../components/AiPrivacyModal';

const TABS = [
  { slug: 'executive-digest', label: 'Executive Digest', icon: Newspaper,
    blurb: 'A leadership brief across capacity, alerts, backup, and DR — top risks and where to focus this week.' },
  { slug: 'capacity', label: 'Capacity Planning', icon: Database,
    blurb: 'Fleet-wide capacity runway, growth trends, and a procurement timeline from 30 days of metrics history.' },
  { slug: 'dr-readiness', label: 'DR Readiness', icon: ArrowLeftRight,
    blurb: 'Replication health, off-site policy coverage, and disaster-recovery gaps across the estate.' },
  { slug: 'backup-failures', label: 'Backup Failure Analysis', icon: ShieldAlert,
    blurb: 'Fleet backup success rate plus root-cause clustering of recurring protection-job failures (7 days).' },
  { slug: 'storage-efficiency', label: 'Storage Efficiency', icon: Gauge,
    blurb: 'Data-reduction across the fleet — low-dedup outliers, likely causes, and where to reclaim space.' },
  { slug: 'alert-triage', label: 'Alert Triage', icon: BellRing,
    blurb: 'Cross-cluster alert patterns — systemic issues vs noise, and a prioritized triage order.' },
  { slug: 'ransomware-resilience', label: 'Ransomware Resilience', icon: ShieldCheck,
    blurb: 'Immutability (DataLock) and off-site coverage, unprotected data, and recovery readiness vs an attack.' },
  { slug: 'what-changed', label: "What Changed", icon: GitCompareArrows,
    blurb: 'Week-over-week digest: alert spikes, backup regressions, and the biggest capacity movers.' },
  { slug: 'upgrade-advisory', label: 'Upgrade Advisory', icon: ArrowUpCircle,
    blurb: 'Software-version drift across the fleet and an ordered convergence/upgrade plan.' },
];

function timeAgo(ts) {
  if (!ts) return null;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ReportTile({ tab, state, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;

  return (
    <div className="panel p-5 flex flex-col gap-4 min-h-[200px]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 border border-brand/20 flex-shrink-0">
          <Icon size={20} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-base font-bold text-ink">{tab.label}</p>
          <p className="text-xs text-ink-muted leading-relaxed mt-0.5">{tab.blurb}</p>
        </div>
      </div>

      {/* Status line */}
      <div className="flex items-center gap-2 text-[11px] flex-wrap mt-auto">
        {!loaded ? (
          <span className="text-ink-faint">Loading…</span>
        ) : !enabled ? (
          <span className="text-amber-400">AI not configured</span>
        ) : report?.generatedAt ? (
          <>
            <Clock size={12} className="text-ink-faint" />
            <span className="text-ink-muted">Last run {timeAgo(report.generatedAt)}</span>
            {report.stale && (
              <span className="text-amber-400 border border-amber-400/40 bg-amber-400/10 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide">Stale</span>
            )}
            {report.model && <span className="text-ink-faint">· {report.model}</span>}
          </>
        ) : (
          <span className="text-ink-faint">Not run yet</span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpen}
          disabled={!report?.generatedAt}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <FileText size={13} /> Open last run
        </button>
        <button
          onClick={onRun}
          disabled={!enabled}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors disabled:opacity-50 cursor-pointer"
        >
          <Sparkles size={13} /> Run new
        </button>
      </div>
    </div>
  );
}

export default function AIAdvisorPage() {
  const [states, setStates] = useState({}); // slug -> { enabled, report }
  const [open, setOpen] = useState(null);   // { slug, autoRun }
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const loadOne = useCallback(async (slug) => {
    try {
      const { data } = await client.get(`/advisor/${slug}`);
      setStates(s => ({ ...s, [slug]: { enabled: data.enabled, report: data.report || null } }));
    } catch {
      setStates(s => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, []);

  useEffect(() => { TABS.forEach(t => loadOne(t.slug)); }, [loadOne]);

  const openTab = open ? TABS.find(t => t.slug === open.slug) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand/10 border border-brand/20">
            <Sparkles size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-ink">AI Advisor</h1>
            <p className="text-xs text-ink-muted">Estate-wide AI analyses. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h.</p>
          </div>
        </div>
        <button
          onClick={() => setPrivacyOpen(true)}
          title="See exactly what each AI request sent — all names anonymized — and the local mapping that never left this server"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand transition-colors cursor-pointer"
        >
          <ShieldCheck size={13} /> Privacy Inspector
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {TABS.map(tab => (
          <ReportTile
            key={tab.slug}
            tab={tab}
            state={states[tab.slug]}
            onOpen={() => setOpen({ slug: tab.slug, autoRun: false })}
            onRun={() => setOpen({ slug: tab.slug, autoRun: true })}
          />
        ))}
      </div>

      {openTab && (
        <AdvisorReportModal
          tab={openTab}
          initialReport={states[openTab.slug]?.report || null}
          enabled={states[openTab.slug]?.enabled !== false}
          autoRun={open.autoRun}
          onClose={() => setOpen(null)}
          onUpdated={(data) => setStates(s => ({ ...s, [openTab.slug]: { enabled: true, report: data } }))}
        />
      )}

      {privacyOpen && <AiPrivacyModal onClose={() => setPrivacyOpen(false)} />}
    </div>
  );
}
