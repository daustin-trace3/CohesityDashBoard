import { useEffect, useState, useCallback } from 'react';
import { Sparkles, FileText, Clock, ShieldCheck } from 'lucide-react';
import client from '../api/client';
import AdvisorReportModal from './AdvisorReportModal';
import AiPrivacyModal from './AiPrivacyModal';
import { PageHeader } from './ui/primitives';

function timeAgo(ts) {
  if (!ts) return null;
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ReportTile({ tab, state, brand, onOpen, onRun }) {
  const Icon = tab.icon;
  const report = state?.report;
  const enabled = state?.enabled !== false;
  const loaded = state !== undefined;
  const accentStyle = brand ? { color: brand } : undefined;
  const boxStyle = brand ? { backgroundColor: `${brand}1a`, borderColor: `${brand}33` } : undefined;

  return (
    <div className="panel p-5 flex flex-col gap-4 min-h-[200px]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 border border-brand/20 flex-shrink-0" style={boxStyle}>
          <Icon size={20} className="text-brand" style={accentStyle} />
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

export default function PlatformAdvisorPage({ platform, brand, title = 'AI Advisor', tabs }) {
  const [states, setStates] = useState({}); // slug -> { enabled, report }
  const [open, setOpen] = useState(null);   // { slug, autoRun }
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const basePath = `/${platform}/advisor`;

  const loadOne = useCallback(async (slug) => {
    try {
      const { data } = await client.get(`${basePath}/${slug}`);
      setStates(s => ({ ...s, [slug]: { enabled: data.enabled, report: data.report || null } }));
    } catch {
      setStates(s => ({ ...s, [slug]: { enabled: true, report: null } }));
    }
  }, [basePath]);

  useEffect(() => { tabs.forEach(t => loadOne(t.slug)); }, [loadOne, tabs]);

  const openTab = open ? tabs.find(t => t.slug === open.slug) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={Sparkles}
        title={title}
        description="AI analyses for this platform. Reports run only when you ask — open the last run or generate a fresh one. Cached results are flagged stale after 24h."
      >
        <button
          onClick={() => setPrivacyOpen(true)}
          title="See exactly what each AI request sent — all names anonymized — and the local mapping that never left this server"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 border border-cohesity-border text-ink rounded-lg hover:border-brand/50 hover:text-brand transition-colors cursor-pointer"
        >
          <ShieldCheck size={13} /> Privacy Inspector
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {tabs.map(tab => (
          <ReportTile
            key={tab.slug}
            tab={tab}
            state={states[tab.slug]}
            brand={brand}
            onOpen={() => setOpen({ slug: tab.slug, autoRun: false })}
            onRun={() => setOpen({ slug: tab.slug, autoRun: true })}
          />
        ))}
      </div>

      {openTab && (
        <AdvisorReportModal
          tab={openTab}
          basePath={basePath}
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
