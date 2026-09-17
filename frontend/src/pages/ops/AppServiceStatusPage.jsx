import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Sparkles, X, ChevronDown, ChevronRight, Search, Plus, Trash2 } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge, LoadingPanel, RefreshButton, LastUpdated, timeAgo } from '../../components/ui/primitives';
import { AnalysisModal } from './ServiceStatusPage';

const REFRESH_MS = 60_000;
const DEBOUNCE_MS = 300;

const STATE_META = {
  critical: { label: 'Critical', color: '#EF4444' },
  degraded: { label: 'Degraded', color: '#F59E0B' },
  ok: { label: 'Operational', color: '#22C55E' },
  unknown: { label: 'No data', color: '#94A3B3' },
};

const STATE_ORDER = { critical: 0, degraded: 1, unknown: 2, ok: 3 };
const STATE_FILTERS = ['all', 'critical', 'degraded', 'ok', 'unknown'];

function stateMeta(state) {
  return STATE_META[state] || STATE_META.unknown;
}

function StatePill({ state }) {
  const m = stateMeta(state);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border flex-shrink-0"
      style={{ color: m.color, borderColor: `${m.color}40`, backgroundColor: `${m.color}1A` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.color }} />
      {m.label}
    </span>
  );
}

function StateDot({ state, title }) {
  const m = stateMeta(state);
  return <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} title={title} />;
}

function yesNo(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return 'Unknown';
}

/* ---- Shared modal shell (copied from ServiceStatusPage.jsx) ---- */
function ModalShell({ title, subtitle, icon: Icon, onClose, children, footer, wide }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative panel w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[85vh] flex flex-col border-t-2 border-brand`}>
        <div className="flex items-start justify-between p-4 pb-3 border-b border-cohesity-border">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={17} className="text-brand shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink truncate">{title}</p>
              {subtitle && <p className="text-[11px] text-ink-faint truncate">{subtitle}</p>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-md text-ink-muted hover:text-ink hover:bg-surface-overlay transition-colors cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="p-4 pt-3 border-t border-cohesity-border flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ---- Expanded detail: Servers section ---- */
function ServersSection({ servers }) {
  if (!servers || servers.length === 0) {
    return <p className="text-xs text-ink-faint">Nothing mapped.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="font-medium pb-1.5 pr-2"></th>
            <th className="font-medium pb-1.5 pr-2">Name</th>
            <th className="font-medium pb-1.5 pr-2">Power</th>
            <th className="font-medium pb-1.5 pr-2">Tools</th>
            <th className="font-medium pb-1.5">IP</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <tr key={s.name} className="border-t border-cohesity-border/60">
              <td className="py-1.5 pr-2"><StateDot state={s.state} /></td>
              <td className="py-1.5 pr-2 text-ink truncate max-w-[160px]" title={s.name}>{s.name}</td>
              <td className="py-1.5 pr-2 text-ink-muted">{s.powerState || '-'}</td>
              <td className="py-1.5 pr-2 text-ink-muted">{s.toolsStatus || '-'}</td>
              <td className="py-1.5 text-ink-muted">{s.ipAddress || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Expanded detail: ESX hosts section ---- */
function HostsSection({ hosts }) {
  if (!hosts || hosts.length === 0) {
    return <p className="text-xs text-ink-faint">Nothing mapped.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((h) => {
        const sp = h.sanPaths || { total: 0, missing: 0, ports: [] };
        const missingPorts = (sp.ports || []).filter((p) => p.isMissing);
        const portTitle = (sp.ports || [])
          .map((p) => `${p.switchName} port ${p.portNumber} ${p.wwn} ${p.isMissing ? 'MISSING' : p.switchPortState}`)
          .join('\n');
        return (
          <div key={h.name} className="text-xs border-t border-cohesity-border/60 pt-2 first:border-t-0 first:pt-0">
            <div className="flex items-center gap-2">
              <StateDot state={h.state} />
              <span className="text-ink font-medium truncate" title={h.name}>{h.name}</span>
              <span className="text-ink-faint">{h.cluster || '-'}</span>
              <span className="text-ink-muted">{h.connectionState || '-'}</span>
              {h.inMaintenance && <Badge tone="warn">Maintenance</Badge>}
              {sp.total > 0 && (
                <span
                  className={sp.missing > 0 ? 'text-status-crit' : 'text-ink-muted'}
                  title={portTitle || undefined}
                >
                  paths {sp.missing}/{sp.total} missing
                </span>
              )}
            </div>
            {missingPorts.length > 0 && (
              <ul className="mt-1 ml-4 text-[11px] text-status-crit list-disc">
                {missingPorts.map((p) => (
                  <li key={`${p.switchName}-${p.portNumber}`}>{p.switchName} port {p.portNumber} ({p.wwn})</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Expanded detail: Storage section ---- */
function StorageSection({ storage }) {
  if (!storage || storage.length === 0) {
    return <p className="text-xs text-ink-faint">Nothing mapped.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="font-medium pb-1.5 pr-2"></th>
            <th className="font-medium pb-1.5 pr-2">Name</th>
            <th className="font-medium pb-1.5 pr-2">Platform</th>
            <th className="font-medium pb-1.5 pr-2">Accessible</th>
            <th className="font-medium pb-1.5">Array</th>
          </tr>
        </thead>
        <tbody>
          {storage.map((s) => (
            <tr key={`${s.kind}-${s.name}`} className="border-t border-cohesity-border/60">
              <td className="py-1.5 pr-2"><StateDot state={s.state} /></td>
              <td className="py-1.5 pr-2 text-ink truncate max-w-[160px]" title={s.name}>{s.name}</td>
              <td className="py-1.5 pr-2 text-ink-muted">{s.platform}</td>
              <td className="py-1.5 pr-2 text-ink-muted">{yesNo(s.accessible)}</td>
              <td className="py-1.5 text-ink-muted">
                {s.array || '-'}
                {s.arrayPoll === 'error' && <span className="text-status-crit"> (poll error)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Expanded detail: Backup section ---- */
function BackupSection({ backup }) {
  if (!backup || backup.length === 0) {
    return <p className="text-xs text-ink-faint">Nothing mapped.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="font-medium pb-1.5 pr-2"></th>
            <th className="font-medium pb-1.5 pr-2">VM</th>
            <th className="font-medium pb-1.5 pr-2">Platform</th>
            <th className="font-medium pb-1.5 pr-2">Protected</th>
            <th className="font-medium pb-1.5 pr-2">Last backup</th>
            <th className="font-medium pb-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {backup.map((b) => (
            <tr key={`${b.platform}-${b.vm}`} className="border-t border-cohesity-border/60">
              <td className="py-1.5 pr-2"><StateDot state={b.state} /></td>
              <td className="py-1.5 pr-2 text-ink truncate max-w-[140px]" title={b.vm}>{b.vm}</td>
              <td className="py-1.5 pr-2 text-ink-muted" title={(b.clusters || []).join(', ') || undefined}>
                {b.platform}{b.clusters && b.clusters.length > 1 ? ` (${b.clusters.length} clusters)` : ''}
              </td>
              <td className="py-1.5 pr-2 text-ink-muted">{yesNo(b.protected)}</td>
              <td className="py-1.5 pr-2 text-ink-muted">
                {b.lastBackupAt ? `${timeAgo(b.lastBackupAt)}${b.ageHours != null ? ` (${Math.round(b.ageHours)}h)` : ''}` : 'Never'}
              </td>
              <td className="py-1.5 text-ink-muted">{b.status || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Expanded row detail ---- */
function ExpandedDetail({ usageId }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    client.get(`/app-services/apps/${usageId}`)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load this app service.'));
  }, [usageId]);

  useEffect(() => { setDetail(null); load(); }, [load]);

  if (error) {
    return (
      <div className="text-center py-6">
        <p className="text-xs text-status-crit mb-2">{error}</p>
        <button onClick={load} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
      </div>
    );
  }

  if (!detail) {
    return <LoadingPanel label="Loading app details" height={120} />;
  }

  const findings = detail.findings || [];
  const sections = buildSections(detail);

  return (
    <div className="flex flex-col gap-3">
      {findings.length > 0 && (
        <div className="flex flex-col gap-1">
          {findings.map((f, i) => (
            <p key={i} className={`text-xs ${f.level === 'critical' ? 'text-status-crit' : 'text-status-warn'}`}>{f.text}</p>
          ))}
        </div>
      )}
      <div className="flex flex-col divide-y divide-cohesity-border/60 border border-cohesity-border rounded-lg">
        {sections.map((s) => <SectionRow key={s.key} section={s} />)}
      </div>
    </div>
  );
}

/* Worst state across a list of component states. */
const SECTION_RANK = { ok: 0, unknown: 1, degraded: 2, critical: 3 };
function worstState(states) {
  return states.reduce((acc, s) => ((SECTION_RANK[s] || 0) > (SECTION_RANK[acc] || 0) ? s : acc), 'ok');
}

/* One summary row per component group. Groups with nothing mapped (no backup
 * configured, no storage found) are left out entirely; a group that is
 * configured but unhealthy (backup older than 24 h) stays and shows it. */
function buildSections(detail) {
  const counts = detail.counts || {};
  const servers = detail.servers || [];
  const hosts = detail.hosts || [];
  const storage = detail.storage || [];
  const backup = detail.backup || [];
  const out = [];

  if (servers.length) {
    const offline = counts.vmsOffline || 0;
    const serverState = offline === 0 ? 'ok' : (offline / servers.length > 0.10 ? 'critical' : 'degraded');
    out.push({
      key: 'servers', title: 'Servers', state: serverState,
      summary: offline ? `${servers.length - offline} of ${servers.length} online, ${offline} offline` : `${servers.length} online`,
      body: <ServersSection servers={servers} />,
    });
  }
  if (hosts.length) {
    const bad = hosts.filter((h) => h.state !== 'ok').length;
    out.push({
      key: 'hosts', title: 'ESX hosts', state: worstState(hosts.map((h) => h.state)),
      summary: `${hosts.length} host${hosts.length === 1 ? '' : 's'}${bad ? `, ${bad} with issues` : ''}${counts.pathsTotal ? `, SAN paths ${counts.pathsMissing || 0}/${counts.pathsTotal} lost` : ''}`,
      body: <HostsSection hosts={hosts} />,
    });
  }
  if (storage.length) {
    const bad = storage.filter((s) => s.state !== 'ok').length;
    out.push({
      key: 'storage', title: 'Storage', state: worstState(storage.map((s) => s.state)),
      summary: `${storage.length} datastore${storage.length === 1 ? '' : 's'} and volume${storage.length === 1 ? '' : 's'}${bad ? `, ${bad} with issues` : ''}`,
      body: <StorageSection storage={storage} />,
    });
  }
  if (backup.length) {
    const stale = backup.filter((b) => b.state !== 'ok').length;
    out.push({
      key: 'backup', title: 'Backup', state: worstState(backup.map((b) => b.state)),
      summary: `${backup.length} protected server${backup.length === 1 ? '' : 's'}${stale ? `, ${stale} without a backup in 24 h` : ''}`,
      body: <BackupSection backup={backup} />,
    });
  }
  return out;
}

function SectionRow({ section }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 text-left cursor-pointer"
        aria-expanded={open}
      >
        <span className="text-ink-faint flex-shrink-0">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <StatePill state={section.state} />
        <span className="text-xs font-semibold text-ink">{section.title}</span>
        <span className="text-[11px] text-ink-faint truncate">{section.summary}</span>
      </button>
      {open && <div className="mt-2 ml-6">{section.body}</div>}
    </div>
  );
}

/* ---- App row ---- */
function AppRow({ app, onOpenAnalysis }) {
  const [expanded, setExpanded] = useState(false);

  const counts = app.counts || {};
  const parts = [];
  if (counts.vms > 0) parts.push(`servers ${counts.vmsOnline || 0}/${counts.vms} online`);
  if (counts.pathsTotal > 0) parts.push(`paths ${counts.pathsMissing || 0}/${counts.pathsTotal} lost`);
  if (counts.datastoresInaccessible > 0) parts.push(`storage ${counts.datastoresInaccessible} issue${counts.datastoresInaccessible === 1 ? '' : 's'}`);
  if (counts.backupsStale > 0) parts.push(`backup ${counts.backupsStale} stale`);

  const showAnalysis = app.eventId != null;
  const analysisPending = app.analysisStatus === 'pending' || app.analysisStatus === 'running';

  return (
    <Panel className="!mb-0">
      <div className="flex items-start gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-ink-faint hover:text-ink cursor-pointer flex-shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <StatePill state={app.state} />
            {app.label ? (
              <>
                <span className="text-sm font-semibold text-ink truncate">{app.label}</span>
                <span className="text-[11px] text-ink-faint font-mono">{app.displayId}</span>
              </>
            ) : (
              <span className="text-sm font-semibold text-ink font-mono">{app.displayId}</span>
            )}
          </div>
          {app.reason && <p className="text-xs text-ink-muted mt-1 truncate">{app.reason}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-ink-faint">
            {app.since && <span>since {timeAgo(app.since)}</span>}
            {parts.map((p, i) => <span key={i}>{p}</span>)}
          </div>
        </div>
        {showAnalysis && (
          <button
            onClick={() => onOpenAnalysis(app.eventId)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-muted hover:text-ink cursor-pointer whitespace-nowrap flex-shrink-0"
          >
            <Sparkles size={11} /> {analysisPending ? 'Analysis pending' : 'AI analysis'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-cohesity-border">
          <ExpandedDetail usageId={app.usageId} />
        </div>
      )}
    </Panel>
  );
}

/* ---- Manage list modal ---- */
function ManageListModal({ onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [resultsError, setResultsError] = useState(null);
  const [watchList, setWatchList] = useState(null);
  const [watchError, setWatchError] = useState(null);
  const debounceRef = useRef(null);

  const loadResults = useCallback((q) => {
    setResultsError(null);
    client.get('/app-services/usage-ids', { params: { q } })
      .then((r) => setResults(r.data?.usageIds || []))
      .catch((e) => setResultsError(e.response?.data?.error || 'Could not search usage-ids.'));
  }, []);

  const loadWatch = useCallback(() => {
    setWatchError(null);
    client.get('/app-services/watch')
      .then((r) => setWatchList(r.data?.watch || []))
      .catch((e) => setWatchError(e.response?.data?.error || 'Could not load the watch list.'));
  }, []);

  useEffect(() => { loadResults(''); loadWatch(); }, [loadResults, loadWatch]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadResults(query), DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query, loadResults]);

  const watchedIds = new Set((watchList || []).map((w) => w.usageId));

  const addWatch = async (item) => {
    try {
      await client.post('/app-services/watch', { usageId: item.usageId });
      loadWatch();
    } catch (e) {
      setWatchError(e.response?.data?.error || 'Could not add this usage-id.');
    }
  };

  const removeWatch = async (usageId) => {
    try {
      await client.delete(`/app-services/watch/${encodeURIComponent(usageId)}`);
      setWatchList((list) => (list || []).filter((w) => w.usageId !== usageId));
    } catch (e) {
      setWatchError(e.response?.data?.error || 'Could not remove this usage-id.');
    }
  };

  const saveLabel = async (usageId, label) => {
    try {
      await client.put(`/app-services/watch/${encodeURIComponent(usageId)}`, { label });
      setWatchList((list) => (list || []).map((w) => (w.usageId === usageId ? { ...w, label } : w)));
    } catch (e) {
      setWatchError(e.response?.data?.error || 'Could not save this label.');
    }
  };

  return (
    <ModalShell title="Manage list" subtitle="Choose the usage-ids to watch" icon={Layers} onClose={onClose} wide>
      <div className="flex flex-col gap-5">
        <div>
          <div className="relative mb-2">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search usage-id or label"
              className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded border border-cohesity-border bg-surface-overlay text-ink placeholder:text-ink-faint focus:outline-none focus:border-brand/50"
            />
          </div>
          {resultsError ? (
            <p className="text-xs text-status-crit">{resultsError}</p>
          ) : results === null ? (
            <LoadingPanel label="Searching" height={80} />
          ) : results.length === 0 ? (
            <p className="text-xs text-ink-faint py-2">No usage-ids match.</p>
          ) : (
            <div className="overflow-x-auto max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="font-medium pb-1.5 pr-2">Usage-id</th>
                    <th className="font-medium pb-1.5 pr-2">VMs</th>
                    <th className="font-medium pb-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((item) => {
                    const watched = watchedIds.has(item.usageId);
                    return (
                      <tr key={item.usageId} className="border-t border-cohesity-border/60">
                        <td className="py-1.5 pr-2 text-ink truncate max-w-[220px]" title={item.displayId}>{item.displayId}</td>
                        <td className="py-1.5 pr-2 text-ink-muted">{item.vmCount}</td>
                        <td className="py-1.5 text-right">
                          {watched ? (
                            <button
                              onClick={() => removeWatch(item.usageId)}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-status-crit border border-status-crit/30 rounded px-2 py-1 hover:bg-status-crit/10 cursor-pointer"
                            >
                              <Trash2 size={11} /> Remove
                            </button>
                          ) : (
                            <button
                              onClick={() => addWatch(item)}
                              className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand border border-brand/30 rounded px-2 py-1 hover:bg-brand/10 cursor-pointer"
                            >
                              <Plus size={11} /> Add
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Currently watched</p>
          {watchError && <p className="text-xs text-status-crit mb-2">{watchError}</p>}
          {watchList === null ? (
            <LoadingPanel label="Loading watch list" height={80} />
          ) : watchList.length === 0 ? (
            <p className="text-xs text-ink-faint py-2">Nothing watched yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {watchList.map((w) => (
                <div key={w.usageId} className="flex items-center gap-2 text-xs">
                  <span className="text-ink truncate w-32 flex-shrink-0" title={w.displayId || w.usageId}>{w.displayId || w.usageId}</span>
                  <input
                    defaultValue={w.label || ''}
                    onBlur={(e) => saveLabel(w.usageId, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                    placeholder="Label"
                    className="flex-1 min-w-0 px-2 py-1 rounded border border-cohesity-border bg-surface-overlay text-ink placeholder:text-ink-faint focus:outline-none focus:border-brand/50"
                  />
                  <button
                    onClick={() => removeWatch(w.usageId)}
                    aria-label={`Remove ${w.usageId}`}
                    className="text-ink-faint hover:text-status-crit cursor-pointer flex-shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

/* ---- Main page ---- */
export default function AppServiceStatusPage() {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterState, setFilterState] = useState('all');
  const [manageOpen, setManageOpen] = useState(false);
  const [analysisEventId, setAnalysisEventId] = useState(null);

  const load = useCallback(({ silent } = {}) => {
    if (!silent) setRefreshing(true);
    setError(null);
    return client.get('/app-services/board')
      .then((r) => setBoard(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the app services board.'))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setInterval(() => load({ silent: true }), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const evaluate = () => {
    setEvaluating(true);
    client.post('/app-services/evaluate')
      .then((r) => setBoard(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not re-evaluate app services.'))
      .finally(() => setEvaluating(false));
  };

  const apps = board?.apps || [];
  const counts = { all: apps.length, critical: 0, degraded: 0, ok: 0, unknown: 0 };
  for (const a of apps) {
    if (counts[a.state] != null) counts[a.state] += 1;
  }

  const q = filterText.trim().toLowerCase();
  const filtered = apps
    .filter((a) => filterState === 'all' || a.state === filterState)
    .filter((a) => {
      if (!q) return true;
      return (a.displayId || '').toLowerCase().includes(q)
        || (a.label || '').toLowerCase().includes(q)
        || (a.reason || '').toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const oa = STATE_ORDER[a.state] ?? 4;
      const ob = STATE_ORDER[b.state] ?? 4;
      if (oa !== ob) return oa - ob;
      return (a.displayId || '').localeCompare(b.displayId || '');
    });

  return (
    <div>
      <PageHeader
        icon={Layers}
        title="App services"
        description="Application status from the usage-id tag on vCenter VMs, rolled up with the ESX host, SAN paths, storage and backup state of those servers"
      >
        <LastUpdated date={board?.generatedAt} />
        <RefreshButton onClick={() => load()} refreshing={refreshing} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by usage-id, label, or reason"
          className="flex-1 min-w-[200px] px-3 py-1.5 text-xs rounded border border-cohesity-border bg-surface-overlay text-ink placeholder:text-ink-faint focus:outline-none focus:border-brand/50"
        />
        <div className="flex items-center gap-1 rounded-lg border border-cohesity-border p-0.5">
          {STATE_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilterState(s)}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition-colors cursor-pointer ${s === filterState ? 'bg-brand/10 text-brand' : 'text-ink-muted hover:text-ink'}`}
            >
              {s === 'all' ? 'All' : stateMeta(s).label} ({counts[s]})
            </button>
          ))}
        </div>
        <button
          onClick={() => setManageOpen(true)}
          className="px-3 py-1.5 rounded text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors cursor-pointer"
        >
          Manage list
        </button>
        <button
          onClick={evaluate}
          disabled={evaluating}
          className="px-3 py-1.5 rounded text-xs font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {evaluating ? 'Evaluating...' : 'Re-evaluate now'}
        </button>
      </div>

      {!board && !error ? (
        <LoadingPanel label="Loading app services" />
      ) : error ? (
        <Panel>
          <p className="text-xs text-status-crit mb-2">{error}</p>
          <button onClick={() => load()} className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer">Retry</button>
        </Panel>
      ) : apps.length === 0 ? (
        <Panel>
          <p className="text-xs text-ink-muted mb-2">No app services selected yet. Use Manage list to choose the usage-ids to watch.</p>
          <button
            onClick={() => setManageOpen(true)}
            className="text-xs font-semibold text-brand hover:text-brand-bright cursor-pointer"
          >
            Manage list
          </button>
        </Panel>
      ) : filtered.length === 0 ? (
        <Panel><p className="text-xs text-ink-muted">No app services match your filters.</p></Panel>
      ) : (
        <div className="flex flex-col gap-2.5">
          {filtered.map((app) => (
            <AppRow key={app.usageId} app={app} onOpenAnalysis={(id) => setAnalysisEventId(id)} />
          ))}
        </div>
      )}

      {manageOpen && (
        <ManageListModal
          onClose={() => { setManageOpen(false); load(); }}
        />
      )}
      {analysisEventId != null && (
        <AnalysisModal eventId={analysisEventId} onClose={() => setAnalysisEventId(null)} />
      )}
    </div>
  );
}
