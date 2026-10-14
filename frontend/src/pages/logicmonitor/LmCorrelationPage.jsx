import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitMerge, HardDriveDownload, Repeat, GitCommitHorizontal, Crosshair } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, arr } from './helpers';
import { BackupLoadSection, ReplicationSection, ChangesSection, BlameSection } from './correlationSections';

const DEFAULT_SECTION = 'backupLoad';
const ALIASES = { backupWindows: 'backupLoad' };

export default function LmCorrelationPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/correlation')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch((e) => {
      setData((cur) => cur || {});
      if (e?.response?.status !== 404) toast({ type: 'error', title: 'Failed to load correlation data' });
    }), [toast]);

  useEffect(() => { load(); }, [load]);

  const backupLoad = arr(data?.backupLoad);
  const replication = arr(data?.replicationVsCircuits);
  const changes = arr(data?.changesThenIncidents);
  const blame = data?.blameHistory && typeof data.blameHistory === 'object' ? data.blameHistory : {};

  const items = [
    { id: 'backupLoad', label: 'Backup load on switch ports', icon: HardDriveDownload, count: backupLoad.length },
    { id: 'replication', label: 'Replication vs circuits', icon: Repeat, count: replication.length },
    { id: 'changes', label: 'Changes then incidents', icon: GitCommitHorizontal, count: changes.length },
    { id: 'blames', label: 'Blame history', icon: Crosshair, count: arr(blame.hops).length },
  ];
  const requested = searchParams.get('section') || DEFAULT_SECTION;
  const raw = ALIASES[requested] || requested;
  const section = items.some((i) => i.id === raw) ? raw : DEFAULT_SECTION;
  const selectSection = (id) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    setSearchParams(next, { replace: true });
  };
  const icon = items.find((i) => i.id === section).icon;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={GitMerge} title="Correlation" description="Cross-platform findings from the network data: backup load on switch ports, replication against circuits, changes followed by incidents, and the hops ICC keeps blaming.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? <LoadingPanel label="Loading correlation data..." height={200} /> : (
        <div className="flex gap-4 items-start">
          <div className="panel p-2 w-56 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
            {items.map((n) => (
              <button key={n.id} type="button" onClick={() => selectSection(n.id)}
                className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'}`}>
                <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
                <span className="truncate">{n.label}</span>
                {n.count ? <span className="ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-status-warn/15 text-status-warn">{n.count}</span> : null}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {section === 'backupLoad' && <BackupLoadSection rows={backupLoad} icon={icon} />}
            {section === 'replication' && <ReplicationSection rows={replication} icon={icon} />}
            {section === 'changes' && <ChangesSection rows={changes} icon={icon} />}
            {section === 'blames' && <BlameSection blame={blame} icon={icon} />}
          </div>
        </div>
      )}
    </div>
  );
}
