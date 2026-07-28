import { useEffect, useState, useMemo, useCallback } from 'react';
import { FolderTree, Users, MonitorSmartphone, HardDrive, FileText, X } from 'lucide-react';
import client from '../../api/client';
import useDnsResolve from '../../api/useDnsResolve';
import IpWithHost from '../../components/IpWithHost';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableControls, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { BRAND, fmtNum } from './helpers';

// ISO8601 duration → total seconds, for sorting duration columns.
function isoSecs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0);
}

// Turn an ISO8601 duration (e.g. P20DT20H20M48S) into a compact human string.
function fmtDuration(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const m = iso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return iso;
  const [, d, h, mi] = m;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mi) parts.push(`${mi}m`);
  if (!parts.length) return '<1m';
  return parts.slice(0, 2).join(' ');
}

export default function NetAppCifsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/netapp/cifs')
    .then(({ data }) => { setData(data); setLastRefreshed(new Date()); })
    .catch(() => { setData({ sessions: [], shares: [] }); toast({ type: 'error', title: 'Failed to load CIFS data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const sessions = data?.sessions || [];
  const shares = data?.shares || [];
  const uniqueClients = useMemo(() => new Set(sessions.map((s) => s.client_ip)).size, [sessions]);
  const openFiles = useMemo(() => sessions.reduce((n, s) => n + (s.open_files || 0), 0), [sessions]);

  // Reverse-resolve client + server IPs via the configured DNS server.
  const ipList = useMemo(() => {
    const set = new Set();
    for (const s of sessions) { if (s.client_ip) set.add(s.client_ip); if (s.server_ip) set.add(s.server_ip); }
    return [...set];
  }, [sessions]);
  const dns = useDnsResolve(ipList);

  // Group active SMB sessions by the volume they are accessing.
  const [modalVolume, setModalVolume] = useState(null);
  const byVolume = useMemo(() => {
    const groups = new Map();
    for (const s of sessions) {
      const key = `${s.array_name}|${s.svm_name}|${s.volume_name || '(none)'}`;
      if (!groups.has(key)) groups.set(key, { key, volume_name: s.volume_name, svm_name: s.svm_name, array_name: s.array_name, sessions: [] });
      groups.get(key).sessions.push(s);
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        uniqueIps: new Set(g.sessions.map((s) => s.client_ip)).size,
        users: [...new Set(g.sessions.map((s) => s.smb_user).filter(Boolean))].join(', '),
      }))
      .sort((a, b) => b.uniqueIps - a.uniqueIps);
  }, [sessions]);

  // Map each CIFS share to the clients whose active session is using that
  // share's volume — i.e. who currently has the share open. ONTAP reports an
  // open-share *count* per session (not names), so we resolve via the volume
  // the session is accessing. Only shares with active clients are shown.
  const [modalShare, setModalShare] = useState(null);
  const byShare = useMemo(() => {
    return shares
      .map((sh) => {
        const shareSessions = sessions.filter((s) => s.svm_name === sh.svm_name && s.volume_name === sh.volume_name);
        return { ...sh, sessions: shareSessions, uniqueIps: new Set(shareSessions.map((s) => s.client_ip)).size };
      })
      .filter((sh) => sh.uniqueIps > 0)
      .sort((a, b) => b.uniqueIps - a.uniqueIps);
  }, [shares, sessions]);

  const volCtl = useTableControls(byVolume, {
    searchKeys: ['volume_name', 'svm_name', 'array_name', 'users'],
    defaultSortKey: 'uniqueIps', defaultSortDir: 'desc',
    paginate: true,
  });
  const byShareCtl = useTableControls(byShare, {
    searchKeys: ['share_name', 'volume_name', 'svm_name', 'array_name'],
    defaultSortKey: 'uniqueIps', defaultSortDir: 'desc',
    paginate: true,
  });
  const sessionCtl = useTableControls(sessions, {
    searchKeys: ['client_ip', 'smb_user', 'volume_name', 'svm_name', 'array_name'],
    sortValues: { connected_duration: (s) => isoSecs(s.connected_duration), idle_duration: (s) => isoSecs(s.idle_duration) },
    paginate: true,
  });
  const shareCtl = useTableControls(shares, {
    searchKeys: ['share_name', 'path', 'volume_name', 'svm_name', 'array_name'],
    defaultSortKey: 'share_name',
    paginate: true,
  });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={FolderTree} title="NetApp SMB / CIFS" description="Live SMB session-to-volume map and configured CIFS shares">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={MonitorSmartphone} label="Active Sessions" value={fmtNum(sessions.length)} tone="brand" />
        <StatCard icon={Users} label="Unique Clients" value={fmtNum(uniqueClients)} />
        <StatCard icon={HardDrive} label="SMB Shares" value={fmtNum(shares.length)} />
        <StatCard icon={FileText} label="Open Files" value={fmtNum(openFiles)} />
      </div>

      {/* Sessions grouped by volume (click a count for the full list) */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-ink">SMB Clients by Volume</p>
          <CsvExportButton filename="netapp-smb-clients-by-volume" rows={byVolume} columns={[
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Cluster', get: 'array_name' }, { label: 'Users', get: 'users' },
            { label: 'Clients', get: 'uniqueIps' },
          ]} />
        </div>
        <p className="text-[11px] text-ink-faint mb-3">Hosts currently mapped to each CIFS volume. Click a count to see the full client list.</p>
        <TableControls ctl={volCtl} rows={byVolume} searchPlaceholder="Filter by volume, SVM, cluster or user…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byVolume.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No active SMB sessions.</div>
        ) : volCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="volume_name" label="Volume" ctl={volCtl} />
                <SortTh k="svm_name" label="SVM" ctl={volCtl} />
                <SortTh k="array_name" label="Cluster" ctl={volCtl} />
                <SortTh k="users" label="Users" ctl={volCtl} />
                <SortTh k="uniqueIps" label="Clients" ctl={volCtl} align="right" />
              </tr></thead>
              <tbody>
                {volCtl.pageRows.map((g) => (
                  <tr key={g.key} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{g.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] max-w-[220px] truncate">{g.users || '—'}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalVolume(g)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold tnum border border-brand/30 text-brand hover:bg-brand/10 transition-colors cursor-pointer">
                        {g.uniqueIps} <Users size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={volCtl} />
      </div>

      {/* Clients mounting each share */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-ink">Clients Mounting Each Share</p>
          <CsvExportButton filename="netapp-smb-share-clients" rows={byShare} columns={[
            { label: 'Share', get: 'share_name' }, { label: 'Volume', get: 'volume_name' },
            { label: 'SVM', get: 'svm_name' }, { label: 'Cluster', get: 'array_name' },
            { label: 'Clients', get: 'uniqueIps' },
            { label: 'Client IPs', get: (sh) => [...new Set(sh.sessions.map((s) => s.client_ip).filter(Boolean))].join('; ') },
          ]} />
        </div>
        <p className="text-[11px] text-ink-faint mb-3">Shares with a live client session. Resolved via the volume each session is using — when a volume hosts several shares, its clients appear under each. Click a count for the host list.</p>
        <TableControls ctl={byShareCtl} rows={byShare} searchPlaceholder="Filter by share, volume, SVM or cluster…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byShare.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No shares currently have an active client session.</div>
        ) : byShareCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No shares match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="share_name" label="Share" ctl={byShareCtl} />
                <SortTh k="volume_name" label="Volume" ctl={byShareCtl} />
                <SortTh k="svm_name" label="SVM" ctl={byShareCtl} />
                <SortTh k="array_name" label="Cluster" ctl={byShareCtl} />
                <SortTh k="uniqueIps" label="Clients" ctl={byShareCtl} align="right" />
              </tr></thead>
              <tbody>
                {byShareCtl.pageRows.map((sh) => (
                  <tr key={sh.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{sh.share_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.array_name}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalShare(sh)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold tnum border border-brand/30 text-brand hover:bg-brand/10 transition-colors cursor-pointer">
                        {sh.uniqueIps} <Users size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={byShareCtl} />
      </div>

      {/* Active sessions */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Active SMB Sessions</p>
          <CsvExportButton filename="netapp-smb-sessions" rows={sessions} columns={[
            { label: 'Client IP', get: 'client_ip' }, { label: 'VM', get: 'client_name' },
            { label: 'User', get: 'smb_user' },
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Protocol', get: 'protocol' }, { label: 'Auth', get: 'authentication' },
            { label: 'Open Files', get: (s) => s.open_files ?? 0 },
            { label: 'Connected', get: (s) => fmtDuration(s.connected_duration) },
            { label: 'Idle', get: (s) => fmtDuration(s.idle_duration) },
            { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={sessionCtl} rows={sessions} searchPlaceholder="Filter by IP, user, volume or SVM…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }, { k: 'protocol', label: 'Protocols' }]} />
        {data == null ? (
          <LoadingPanel label="Loading sessions…" height={120} />
        ) : sessions.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No active SMB sessions.</div>
        ) : sessionCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No sessions match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="client_ip" label="Client IP" ctl={sessionCtl} />
                <SortTh k="smb_user" label="User" ctl={sessionCtl} />
                <SortTh k="volume_name" label="Volume" ctl={sessionCtl} />
                <SortTh k="svm_name" label="SVM" ctl={sessionCtl} />
                <SortTh k="protocol" label="Protocol" ctl={sessionCtl} />
                <SortTh k="authentication" label="Auth" ctl={sessionCtl} />
                <SortTh k="open_files" label="Files" ctl={sessionCtl} align="right" />
                <SortTh k="connected_duration" label="Connected" ctl={sessionCtl} />
                <SortTh k="idle_duration" label="Idle" ctl={sessionCtl} />
                <SortTh k="array_name" label="Cluster" ctl={sessionCtl} />
              </tr></thead>
              <tbody>
                {sessionCtl.pageRows.map((s) => (
                  <tr key={s.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><IpWithHost ip={s.client_ip} dns={dns} vm={s.client_name} /></td>
                    <td className="py-2 pr-3 text-ink-muted">{s.smb_user || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.svm_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone="info">{s.protocol || '—'}</Badge></td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{s.authentication || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.open_files ?? 0}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.connected_duration)}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.idle_duration)}</td>
                    <td className="py-2 pr-3 text-ink-muted">{s.array_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={sessionCtl} />
      </div>

      {/* CIFS shares */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">CIFS Shares</p>
          <CsvExportButton filename="netapp-cifs-shares" rows={shares} columns={[
            { label: 'Share', get: 'share_name' }, { label: 'Path', get: 'path' },
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={shareCtl} rows={shares} searchPlaceholder="Filter by share, path, volume or SVM…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading shares…" height={120} />
        ) : shares.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No CIFS shares found.</div>
        ) : shareCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No shares match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <SortTh k="share_name" label="Share" ctl={shareCtl} />
                <SortTh k="path" label="Path" ctl={shareCtl} />
                <SortTh k="volume_name" label="Volume" ctl={shareCtl} />
                <SortTh k="svm_name" label="SVM" ctl={shareCtl} />
                <SortTh k="array_name" label="Cluster" ctl={shareCtl} />
              </tr></thead>
              <tbody>
                {shareCtl.pageRows.map((sh) => (
                  <tr key={sh.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{sh.share_name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] font-mono">{sh.path || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.array_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={shareCtl} />
      </div>

      {modalVolume && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setModalVolume(null)}>
          <div className="panel w-full max-w-xl p-5 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink truncate">Clients on {modalVolume.volume_name || '(no open volume)'}</h2>
                <p className="text-[11px] text-ink-muted">{modalVolume.svm_name} · {modalVolume.array_name} · {modalVolume.sessions.length} session{modalVolume.sessions.length === 1 ? '' : 's'}</p>
              </div>
              <button onClick={() => setModalVolume(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">User</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Files</th><th className="py-2 pr-3">Idle</th>
                </tr></thead>
                <tbody>
                  {modalVolume.sessions.map((s) => (
                    <tr key={s.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><IpWithHost ip={s.client_ip} dns={dns} vm={s.client_name} /></td>
                      <td className="py-2 pr-3 text-ink-muted">{s.smb_user || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone="info">{s.protocol || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.open_files ?? 0}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.idle_duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {modalShare && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setModalShare(null)}>
          <div className="panel w-full max-w-xl p-5 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink truncate">Clients on share \\{modalShare.share_name}</h2>
                <p className="text-[11px] text-ink-muted">volume {modalShare.volume_name} · {modalShare.svm_name} · {modalShare.array_name} · {modalShare.uniqueIps} client{modalShare.uniqueIps === 1 ? '' : 's'}</p>
              </div>
              <button onClick={() => setModalShare(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">User</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Files</th><th className="py-2 pr-3">Idle</th>
                </tr></thead>
                <tbody>
                  {modalShare.sessions.map((s) => (
                    <tr key={s.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><IpWithHost ip={s.client_ip} dns={dns} vm={s.client_name} /></td>
                      <td className="py-2 pr-3 text-ink-muted">{s.smb_user || '—'}</td>
                      <td className="py-2 pr-3"><Badge tone="info">{s.protocol || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.open_files ?? 0}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.idle_duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
