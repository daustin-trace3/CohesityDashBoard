// NetApp SMB/CIFS — ported from frontend/src/pages/netapp/NetAppCifsPage.jsx.
import { FolderTree, Users, MonitorSmartphone, HardDrive, FileText } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtNum, useTableControls, SortTh, TableControls, TablePager, CsvExportButton, useDnsResolve, IpWithHost, Modal } from '../ui.jsx';

function isoSecs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0);
}

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

export default function CifsPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/netapp/cifs')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ sessions: [], shares: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  const sessions = data?.sessions || [];
  const shares = data?.shares || [];
  const uniqueClients = React.useMemo(() => new Set(sessions.map((s) => s.client_ip)).size, [sessions]);
  const openFiles = React.useMemo(() => sessions.reduce((n, s) => n + (s.open_files || 0), 0), [sessions]);

  const ipList = React.useMemo(() => {
    const set = new Set();
    for (const s of sessions) { if (s.client_ip) set.add(s.client_ip); if (s.server_ip) set.add(s.server_ip); }
    return [...set];
  }, [sessions]);
  const dns = useDnsResolve(ipList);

  const [modalVolume, setModalVolume] = React.useState(null);
  const byVolume = React.useMemo(() => {
    const groups = new Map();
    for (const s of sessions) {
      const key = `${s.array_name}|${s.svm_name}|${s.volume_name || '(none)'}`;
      if (!groups.has(key)) groups.set(key, { key, volume_name: s.volume_name, svm_name: s.svm_name, array_name: s.array_name, sessions: [] });
      groups.get(key).sessions.push(s);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, uniqueIps: new Set(g.sessions.map((s) => s.client_ip)).size, users: [...new Set(g.sessions.map((s) => s.smb_user).filter(Boolean))].join(', ') }))
      .sort((a, b) => b.uniqueIps - a.uniqueIps);
  }, [sessions]);

  const [modalShare, setModalShare] = React.useState(null);
  const byShare = React.useMemo(() => shares
    .map((sh) => {
      const shareSessions = sessions.filter((s) => s.svm_name === sh.svm_name && s.volume_name === sh.volume_name);
      return { ...sh, sessions: shareSessions, uniqueIps: new Set(shareSessions.map((s) => s.client_ip)).size };
    })
    .filter((sh) => sh.uniqueIps > 0)
    .sort((a, b) => b.uniqueIps - a.uniqueIps), [shares, sessions]);

  const volCtl = useTableControls(byVolume, { searchKeys: ['volume_name', 'svm_name', 'array_name', 'users'], defaultSortKey: 'uniqueIps', defaultSortDir: 'desc', paginate: true });
  const byShareCtl = useTableControls(byShare, { searchKeys: ['share_name', 'volume_name', 'svm_name', 'array_name'], defaultSortKey: 'uniqueIps', defaultSortDir: 'desc', paginate: true });
  const sessionCtl = useTableControls(sessions, { searchKeys: ['client_ip', 'smb_user', 'volume_name', 'svm_name', 'array_name'], sortValues: { connected_duration: (s) => isoSecs(s.connected_duration), idle_duration: (s) => isoSecs(s.idle_duration) }, paginate: true });
  const shareCtl = useTableControls(shares, { searchKeys: ['share_name', 'path', 'volume_name', 'svm_name', 'array_name'], defaultSortKey: 'share_name', paginate: true });

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

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-ink">SMB Clients by Volume</p>
          <CsvExportButton filename="netapp-smb-clients-by-volume" rows={byVolume} columns={[
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' }, { label: 'Cluster', get: 'array_name' },
            { label: 'Users', get: 'users' }, { label: 'Clients', get: 'uniqueIps' },
          ]} />
        </div>
        <p className="text-[11px] text-ink-faint mb-3">Hosts currently mapped to each CIFS volume. Click a count to see the full client list.</p>
        <TableControls ctl={volCtl} rows={byVolume} searchPlaceholder="Filter by volume, SVM, cluster or user…" filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byVolume.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No active SMB sessions.</div>
        ) : volCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="volume_name" label="Volume" ctl={volCtl} />
                <SortTh k="svm_name" label="SVM" ctl={volCtl} />
                <SortTh k="array_name" label="Cluster" ctl={volCtl} />
                <SortTh k="users" label="Users" ctl={volCtl} />
                <SortTh k="uniqueIps" label="Clients" ctl={volCtl} align="right" />
              </tr></thead>
              <tbody>
                {volCtl.pageRows.map((g) => (
                  <tr key={g.key} className="border-b">
                    <td className="py-2 pr-3 text-ink">{g.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] truncate max-w-[220px]">{g.users || '—'}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalVolume(g)} className="na-chip" style={{ border: '1px solid rgba(0,103,197,.3)', color: BRAND, background: 'transparent', cursor: 'pointer', fontWeight: 600 }}>
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

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-ink">Clients Mounting Each Share</p>
          <CsvExportButton filename="netapp-smb-share-clients" rows={byShare} columns={[
            { label: 'Share', get: 'share_name' }, { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Cluster', get: 'array_name' }, { label: 'Clients', get: 'uniqueIps' },
            { label: 'Client IPs', get: (sh) => [...new Set(sh.sessions.map((s) => s.client_ip).filter(Boolean))].join('; ') },
          ]} />
        </div>
        <p className="text-[11px] text-ink-faint mb-3">Shares with a live client session. Resolved via the volume each session is using. Click a count for the host list.</p>
        <TableControls ctl={byShareCtl} rows={byShare} searchPlaceholder="Filter by share, volume, SVM or cluster…" filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byShare.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No shares currently have an active client session.</div>
        ) : byShareCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No shares match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="share_name" label="Share" ctl={byShareCtl} />
                <SortTh k="volume_name" label="Volume" ctl={byShareCtl} />
                <SortTh k="svm_name" label="SVM" ctl={byShareCtl} />
                <SortTh k="array_name" label="Cluster" ctl={byShareCtl} />
                <SortTh k="uniqueIps" label="Clients" ctl={byShareCtl} align="right" />
              </tr></thead>
              <tbody>
                {byShareCtl.pageRows.map((sh) => (
                  <tr key={sh.id} className="border-b">
                    <td className="py-2 pr-3 text-ink">{sh.share_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{sh.array_name}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalShare(sh)} className="na-chip" style={{ border: '1px solid rgba(0,103,197,.3)', color: BRAND, background: 'transparent', cursor: 'pointer', fontWeight: 600 }}>
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

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Active SMB Sessions</p>
          <CsvExportButton filename="netapp-smb-sessions" rows={sessions} columns={[
            { label: 'Client IP', get: 'client_ip' }, { label: 'VM', get: 'client_name' }, { label: 'User', get: 'smb_user' },
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' }, { label: 'Protocol', get: 'protocol' },
            { label: 'Auth', get: 'authentication' }, { label: 'Open Files', get: (s) => s.open_files ?? 0 },
            { label: 'Connected', get: (s) => fmtDuration(s.connected_duration) }, { label: 'Idle', get: (s) => fmtDuration(s.idle_duration) },
            { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={sessionCtl} rows={sessions} searchPlaceholder="Filter by IP, user, volume or SVM…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }, { k: 'protocol', label: 'Protocols' }]} />
        {data == null ? (
          <LoadingPanel label="Loading sessions…" height={120} />
        ) : sessions.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No active SMB sessions.</div>
        ) : sessionCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No sessions match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
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
                  <tr key={s.id} className="border-b">
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

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">CIFS Shares</p>
          <CsvExportButton filename="netapp-cifs-shares" rows={shares} columns={[
            { label: 'Share', get: 'share_name' }, { label: 'Path', get: 'path' }, { label: 'Volume', get: 'volume_name' },
            { label: 'SVM', get: 'svm_name' }, { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={shareCtl} rows={shares} searchPlaceholder="Filter by share, path, volume or SVM…" filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading shares…" height={120} />
        ) : shares.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No CIFS shares found.</div>
        ) : shareCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No shares match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="share_name" label="Share" ctl={shareCtl} />
                <SortTh k="path" label="Path" ctl={shareCtl} />
                <SortTh k="volume_name" label="Volume" ctl={shareCtl} />
                <SortTh k="svm_name" label="SVM" ctl={shareCtl} />
                <SortTh k="array_name" label="Cluster" ctl={shareCtl} />
              </tr></thead>
              <tbody>
                {shareCtl.pageRows.map((sh) => (
                  <tr key={sh.id} className="border-b">
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
        <Modal title={`Clients on ${modalVolume.volume_name || '(no open volume)'}`} subtitle={`${modalVolume.svm_name} · ${modalVolume.array_name} · ${modalVolume.sessions.length} session${modalVolume.sessions.length === 1 ? '' : 's'}`} onClose={() => setModalVolume(null)} maxWidth="min(640px,92vw)">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
              <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">User</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Files</th><th className="py-2 pr-3">Idle</th>
            </tr></thead>
            <tbody>
              {modalVolume.sessions.map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="py-2 pr-3"><IpWithHost ip={s.client_ip} dns={dns} vm={s.client_name} /></td>
                  <td className="py-2 pr-3 text-ink-muted">{s.smb_user || '—'}</td>
                  <td className="py-2 pr-3"><Badge tone="info">{s.protocol || '—'}</Badge></td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.open_files ?? 0}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.idle_duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {modalShare && (
        <Modal title={`Clients on share \\\\${modalShare.share_name}`} subtitle={`volume ${modalShare.volume_name} · ${modalShare.svm_name} · ${modalShare.array_name} · ${modalShare.uniqueIps} client${modalShare.uniqueIps === 1 ? '' : 's'}`} onClose={() => setModalShare(null)} maxWidth="min(640px,92vw)">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
              <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">User</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3 text-right">Files</th><th className="py-2 pr-3">Idle</th>
            </tr></thead>
            <tbody>
              {modalShare.sessions.map((s) => (
                <tr key={s.id} className="border-b">
                  <td className="py-2 pr-3"><IpWithHost ip={s.client_ip} dns={dns} vm={s.client_name} /></td>
                  <td className="py-2 pr-3 text-ink-muted">{s.smb_user || '—'}</td>
                  <td className="py-2 pr-3"><Badge tone="info">{s.protocol || '—'}</Badge></td>
                  <td className="py-2 pr-3 text-right tnum text-ink-muted">{s.open_files ?? 0}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px] tnum">{fmtDuration(s.idle_duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
