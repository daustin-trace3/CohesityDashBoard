import { useEffect, useState, useCallback } from 'react';
import { Bell } from 'lucide-react';
import client from '../api/client';
import { useToast } from './ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from './ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from './ui/tableTools';

// Shared Alerts page for platforms whose "alerts" are computed issues with a
// lifecycle history (aria, vcenter) rather than vendor-raised alert rows.
const CONFIG = {
  aria: { brand: '#00A2C7', base: '/aria', instanceKey: 'instance', instanceLabel: 'Instance',
    description: 'Computed issues across all registered Aria Automation instances, with open/resolved history' },
  vcenter: { brand: '#0091DA', base: '/vcenter', instanceKey: 'vcenter', instanceLabel: 'vCenter',
    description: 'Computed issues across all registered vCenters, with open/resolved history' },
  netbackup: { brand: '#B1181E', base: '/netbackup', instanceKey: 'source', instanceLabel: 'Primary Server',
    description: 'Computed issues across all registered NetBackup sources, with open/resolved history' },
  aws: { brand: '#FF9900', base: '/aws', instanceKey: 'account', instanceLabel: 'Account',
    description: 'Computed issues across AWS accounts, with open/resolved history' },
  proxmox: { brand: '#E57000', base: '/proxmox', instanceKey: 'source', instanceLabel: 'Server',
    description: 'Computed issues across all registered Proxmox VE servers, with open/resolved history' },
  brocade: { brand: '#CC092F', base: '/brocade', instanceKey: 'source', instanceLabel: 'Source',
    description: 'Computed fabric issues across all registered SANnav sources, with open/resolved history' },
  bluecat: { brand: '#0057B8', base: '/bluecat', instanceKey: 'source', instanceLabel: 'Address Manager',
    description: 'Computed IPAM and DNS issues across all registered BlueCat Address Managers, with open/resolved history' },
  logicmonitor: { brand: '#1A73E8', base: '/logicmonitor', instanceKey: 'source', instanceLabel: 'Portal', label: 'LogicMonitor',
    description: 'Computed monitoring issues across connected LogicMonitor portals: dead devices, down interfaces, collector health and site reachability, with open/resolved history' },
};

const RANGES = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];

const sevTone = (sev) => (sev === 'critical' || sev === 'error') ? 'crit' : sev === 'warning' ? 'warn' : 'info';

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).includes('T') ? iso : `${iso}Z`.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function CurrentIssuesPanel({ cfg, rows, history }) {
  // Computed issues carry no timestamp of their own; their open history row
  // (same type + target) knows when the condition first appeared, so each
  // open issue shows a Since time. Unmatched rows show a dash, never a guess.
  const sinceByKey = new Map((history || [])
    .filter((h) => h.status === 'open')
    .map((h) => [`${h.type}|${h.target || ''}`, h.first_seen]));
  const list = (rows || []).map((i) => ({ ...i, since: sinceByKey.get(`${i.type}|${i.target || ''}`) || null }));
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', cfg.instanceKey],
    defaultSortKey: 'severity', defaultSortDir: 'asc',
    paginate: true,
  });
  const csvColumns = [
    { label: 'Severity', get: (i) => i.severity },
    { label: 'Type', get: (i) => i.type },
    { label: cfg.instanceLabel, get: (i) => i[cfg.instanceKey] },
    { label: 'Target', get: (i) => i.target },
    { label: 'Message', get: (i) => i.message },
    { label: 'Open Since', get: (i) => i.since || '' },
  ];
  return (
    <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${cfg.brand}` }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-xs font-semibold text-ink">Open Issues <span className="text-ink-faint font-normal">— current state, recomputed on every request</span></div>
        <CsvExportButton filename={`${cfg.base.slice(1)}-issues`} rows={ctl.rows} columns={csvColumns} />
      </div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter by message, type or target…"
        filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }, { k: cfg.instanceKey, label: `${cfg.instanceLabel}s` }]} />
      {rows == null ? (
        <LoadingPanel label="Loading issues…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-status-ok py-6 text-center">No open issues.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No issues match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <SortTh k="severity" label="Severity" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k={cfg.instanceKey} label={cfg.instanceLabel} ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th className="py-2 pr-3">Message</th>
              <SortTh k="since" label="Open Since" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((i, idx) => (
                <tr key={`${i.type}|${i.target}|${idx}`} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3"><Badge tone={sevTone(i.severity)}>{i.severity}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{i.type || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted whitespace-nowrap">{i[cfg.instanceKey] || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[220px] truncate" title={i.target || ''}>{i.target || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-xs max-w-[460px]">{i.message || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(i.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

function HistoryPanel({ cfg, rows }) {
  // Open issues live in the panel above (with their Since time); history is
  // strictly the resolved record, so nothing appears in both tables. The
  // fetch still returns open rows because the open panel joins on them.
  const list = (rows || []).filter((h) => h.status !== 'open');
  const ctl = useTableControls(list, {
    searchKeys: ['message', 'type', 'target', 'instance', 'vcenter', 'source'],
    defaultSortKey: 'resolved_at', defaultSortDir: 'desc',
    paginate: true,
  });
  return (
    <div className="panel p-4" style={{ borderTop: `3px solid ${cfg.brand}` }}>
      <div className="text-xs font-semibold text-ink mb-2">Resolved Issues <span className="text-ink-faint font-normal">— when each was first detected and when it cleared; anything still open is in the panel above</span></div>
      <TableControls ctl={ctl} rows={list} searchPlaceholder="Filter resolved issues…"
        filters={[{ k: 'severity', label: 'Severities' }, { k: 'type', label: 'Types' }]} />
      {rows == null ? (
        <LoadingPanel label="Loading history…" height={140} />
      ) : list.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No issues resolved in the selected window.</div>
      ) : ctl.rows.length === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">No resolved issues match your filters.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
              <th className="py-2 pr-3">Status</th>
              <SortTh k="severity" label="Was" ctl={ctl} />
              <SortTh k="type" label="Type" ctl={ctl} />
              <SortTh k="target" label="Target" ctl={ctl} />
              <th className="py-2 pr-3">Message</th>
              <SortTh k="first_seen" label="First Seen" ctl={ctl} />
              <SortTh k="resolved_at" label="Resolved" ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((h) => (
                <tr key={h.id} className="border-b border-cohesity-border/50">
                  <td className="py-2 pr-3"><Badge tone="ok">Resolved</Badge></td>
                  <td className="py-2 pr-3"><Badge tone={sevTone(h.severity)}>{h.severity || '—'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] whitespace-nowrap">{h.type || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted max-w-[200px] truncate" title={h.target || ''}>{h.target || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-xs max-w-[380px]">{h.message || '—'}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(h.first_seen)}</td>
                  <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(h.resolved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} />
    </div>
  );
}

export default function IssueAlertsPage({ platform }) {
  const cfg = CONFIG[platform];
  const { toast } = useToast();
  const [issues, setIssues] = useState(null);
  const [history, setHistory] = useState(null);
  const [days, setDays] = useState(30);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => Promise.all([
    client.get(`${cfg.base}/issues`).then(({ data }) => setIssues(Array.isArray(data) ? data : data?.issues || [])),
    client.get(`${cfg.base}/issue-history`, { params: { days } }).then(({ data }) => setHistory(data)).catch(() => setHistory([])),
  ]).then(() => setLastRefreshed(new Date()))
    .catch(() => { setIssues([]); toast({ type: 'error', title: 'Failed to load alerts' }); }), [toast, cfg.base, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Alerts" description={cfg.description}>
        <div className="flex items-center gap-1 mr-2">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${days === r.days ? 'bg-brand text-cohesity-black' : 'text-ink-muted hover:text-ink border border-cohesity-border'}`}>
              {r.label}
            </button>
          ))}
        </div>
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>
      <CurrentIssuesPanel cfg={cfg} rows={issues} history={history} />
      <HistoryPanel cfg={cfg} rows={history} />
    </div>
  );
}
