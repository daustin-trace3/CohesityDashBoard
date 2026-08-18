// NetApp NFS — ported from frontend/src/pages/netapp/NetAppNfsPage.jsx.
// The two drill-down popups (clients-by-volume, clients-by-policy) use ui.jsx's
// Modal (portalOrInline-backed) instead of a hand-rolled fixed overlay.
import { Share2, Users, ShieldCheck } from '../icons.jsx';
import { apiFetch, PageHeader, StatCard, Badge, LoadingPanel, RefreshButton, LastUpdated, BRAND, fmtNum, useTableControls, SortTh, TableControls, TablePager, CsvExportButton, useDnsResolve, IpWithHost, Modal } from '../ui.jsx';

export default function NfsPage() {
  const [data, setData] = React.useState(null);
  const [lastRefreshed, setLastRefreshed] = React.useState(null);

  const load = React.useCallback(() => apiFetch('/netapp/nfs')
    .then((d) => { setData(d); setLastRefreshed(new Date()); })
    .catch(() => setData({ clients: [], exportRules: [] })), []);

  React.useEffect(() => { load(); }, [load]);

  const clients = data?.clients || [];
  const rules = data?.exportRules || [];
  const uniqueClients = React.useMemo(() => new Set(clients.map((c) => c.client_ip)).size, [clients]);
  const policies = React.useMemo(() => new Set(rules.map((r) => `${r.svm_name}/${r.policy_name}`)).size, [rules]);

  const ipList = React.useMemo(() => {
    const s = new Set();
    for (const c of clients) { if (c.client_ip) s.add(c.client_ip); if (c.server_ip) s.add(c.server_ip); }
    for (const r of rules) {
      for (const spec of String(r.clients || '').split(',').map((x) => x.trim())) {
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(spec)) s.add(spec);
      }
    }
    return [...s];
  }, [clients, rules]);
  const dns = useDnsResolve(ipList);

  const [modalVolume, setModalVolume] = React.useState(null);
  const byVolume = React.useMemo(() => {
    const groups = new Map();
    for (const c of clients) {
      const key = `${c.array_name}|${c.svm_name}|${c.volume_name}`;
      if (!groups.has(key)) groups.set(key, { key, volume_name: c.volume_name, svm_name: c.svm_name, array_name: c.array_name, clients: [] });
      groups.get(key).clients.push(c);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, uniqueIps: new Set(g.clients.map((c) => c.client_ip)).size, protocols: [...new Set(g.clients.map((c) => c.protocol).filter(Boolean))].join(', ') }))
      .sort((a, b) => b.uniqueIps - a.uniqueIps);
  }, [clients]);

  const [modalPolicy, setModalPolicy] = React.useState(null);
  const byPolicy = React.useMemo(() => {
    const groups = new Map();
    for (const r of rules) {
      const key = `${r.array_name}|${r.svm_name}|${r.policy_name}`;
      if (!groups.has(key)) groups.set(key, { key, policy_name: r.policy_name, svm_name: r.svm_name, array_name: r.array_name, entries: [] });
      const specs = String(r.clients || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) groups.get(key).entries.push({ client: spec, ro: r.ro_rule, rw: r.rw_rule, superuser: r.superuser, protocols: r.protocols, rule_index: r.rule_index });
    }
    return [...groups.values()].map((g) => ({ ...g, count: g.entries.length, volume: g.policy_name.replace(/^ep_/, '') })).sort((a, b) => b.count - a.count);
  }, [rules]);

  const volCtl = useTableControls(byVolume, { searchKeys: ['volume_name', 'svm_name', 'array_name', 'protocols'], defaultSortKey: 'uniqueIps', defaultSortDir: 'desc', paginate: true });
  const clientCtl = useTableControls(clients, { searchKeys: ['client_ip', 'svm_name', 'volume_name', 'node_name', 'server_ip', 'array_name'], paginate: true });
  const policyCtl = useTableControls(byPolicy, { searchKeys: ['policy_name', 'volume', 'svm_name', 'array_name'], defaultSortKey: 'count', defaultSortDir: 'desc', paginate: true });
  const ruleCtl = useTableControls(rules, { searchKeys: ['policy_name', 'svm_name', 'clients', 'protocols'], paginate: true });

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Share2} title="NetApp NFS" description="Live NFS client-to-volume map and export-policy access rules">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Users} label="Connected Clients" value={fmtNum(clients.length)} tone="brand" />
        <StatCard icon={Users} label="Unique Client IPs" value={fmtNum(uniqueClients)} />
        <StatCard icon={ShieldCheck} label="Export Policies" value={fmtNum(policies)} />
        <StatCard icon={ShieldCheck} label="Policy Rules" value={fmtNum(rules.length)} />
      </div>

      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">NFS Clients by Volume</p>
          <CsvExportButton filename="netapp-nfs-clients-by-volume" rows={byVolume} columns={[
            { label: 'Volume', get: 'volume_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Cluster', get: 'array_name' }, { label: 'Protocols', get: 'protocols' },
            { label: 'Clients', get: 'uniqueIps' },
          ]} />
        </div>
        <TableControls ctl={volCtl} rows={byVolume} searchPlaceholder="Filter by volume, SVM or cluster…" filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byVolume.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No NFS clients currently connected.</div>
        ) : volCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No volumes match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="volume_name" label="Volume" ctl={volCtl} />
                <SortTh k="svm_name" label="SVM" ctl={volCtl} />
                <SortTh k="array_name" label="Cluster" ctl={volCtl} />
                <SortTh k="protocols" label="Protocols" ctl={volCtl} />
                <SortTh k="uniqueIps" label="Clients" ctl={volCtl} align="right" />
              </tr></thead>
              <tbody>
                {volCtl.pageRows.map((g) => (
                  <tr key={g.key} className="border-b">
                    <td className="py-2 pr-3 text-ink">{g.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{g.protocols || '—'}</td>
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
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Connected NFS Clients</p>
          <CsvExportButton filename="netapp-nfs-clients" rows={clients} columns={[
            { label: 'Client IP', get: 'client_ip' }, { label: 'VM', get: 'client_name' }, { label: 'SVM', get: 'svm_name' },
            { label: 'Volume', get: 'volume_name' }, { label: 'Node', get: 'node_name' }, { label: 'Protocol', get: 'protocol' },
            { label: 'Server IP', get: 'server_ip' }, { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={clientCtl} rows={clients} searchPlaceholder="Filter by IP, volume, SVM or node…"
          filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }, { k: 'protocol', label: 'Protocols' }]} />
        {data == null ? (
          <LoadingPanel label="Loading clients…" height={120} />
        ) : clients.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No NFS clients currently connected.</div>
        ) : clientCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No clients match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="client_ip" label="Client IP" ctl={clientCtl} />
                <SortTh k="svm_name" label="SVM" ctl={clientCtl} />
                <SortTh k="volume_name" label="Volume" ctl={clientCtl} />
                <SortTh k="node_name" label="Node" ctl={clientCtl} />
                <SortTh k="protocol" label="Protocol" ctl={clientCtl} />
                <SortTh k="server_ip" label="Server IP" ctl={clientCtl} />
                <SortTh k="array_name" label="Cluster" ctl={clientCtl} />
              </tr></thead>
              <tbody>
                {clientCtl.pageRows.map((c) => (
                  <tr key={c.id} className="border-b">
                    <td className="py-2 pr-3"><IpWithHost ip={c.client_ip} dns={dns} vm={c.client_name} /></td>
                    <td className="py-2 pr-3 text-ink-muted">{c.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{c.node_name || '—'}</td>
                    <td className="py-2 pr-3"><Badge tone="info">{c.protocol || '—'}</Badge></td>
                    <td className="py-2 pr-3"><IpWithHost ip={c.server_ip} dns={dns} muted /></td>
                    <td className="py-2 pr-3 text-ink-muted">{c.array_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={clientCtl} />
      </div>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-ink">Permitted Clients by Export Policy</p>
          <CsvExportButton filename="netapp-nfs-policy-clients" rows={byPolicy} columns={[
            { label: 'Export Policy', get: 'policy_name' }, { label: 'Volume', get: 'volume' },
            { label: 'SVM', get: 'svm_name' }, { label: 'Cluster', get: 'array_name' }, { label: 'Clients', get: 'count' },
            { label: 'Permitted Clients', get: (g) => g.entries.map((e) => e.client).join('; ') },
          ]} />
        </div>
        <p className="text-[11px] text-ink-faint mb-3">Click a client count to see every host permitted by that policy.</p>
        <TableControls ctl={policyCtl} rows={byPolicy} searchPlaceholder="Filter by policy, volume, SVM or cluster…" filters={[{ k: 'array_name', label: 'Clusters' }, { k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading export rules…" height={120} />
        ) : byPolicy.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No export policy rules found.</div>
        ) : policyCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No policies match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="policy_name" label="Export Policy" ctl={policyCtl} />
                <SortTh k="volume" label="Volume" ctl={policyCtl} />
                <SortTh k="svm_name" label="SVM" ctl={policyCtl} />
                <SortTh k="array_name" label="Cluster" ctl={policyCtl} />
                <SortTh k="count" label="Clients" ctl={policyCtl} align="right" />
              </tr></thead>
              <tbody>
                {policyCtl.pageRows.map((g) => (
                  <tr key={g.key} className="border-b">
                    <td className="py-2 pr-3 text-ink">{g.policy_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.volume || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalPolicy(g)} className="na-chip" style={{ border: '1px solid rgba(0,103,197,.3)', color: BRAND, background: 'transparent', cursor: 'pointer', fontWeight: 600 }}>
                        {g.count} <Users size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={policyCtl} />
      </div>

      <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink">Export Policy Rules</p>
          <CsvExportButton filename="netapp-nfs-export-rules" rows={rules} columns={[
            { label: 'Policy', get: 'policy_name' }, { label: 'SVM', get: 'svm_name' }, { label: 'Rule #', get: 'rule_index' },
            { label: 'Clients', get: 'clients' }, { label: 'Protocols', get: 'protocols' }, { label: 'RO', get: 'ro_rule' },
            { label: 'RW', get: 'rw_rule' }, { label: 'Superuser', get: 'superuser' }, { label: 'Cluster', get: 'array_name' },
          ]} />
        </div>
        <TableControls ctl={ruleCtl} rows={rules} searchPlaceholder="Filter by policy, SVM or client…" filters={[{ k: 'svm_name', label: 'SVMs' }]} />
        {data == null ? (
          <LoadingPanel label="Loading export rules…" height={120} />
        ) : rules.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No export policy rules found.</div>
        ) : ruleCtl.rows.length === 0 ? (
          <div className="text-sm text-ink-muted p-6 text-center">No rules match your filters.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
                <SortTh k="policy_name" label="Policy" ctl={ruleCtl} />
                <SortTh k="svm_name" label="SVM" ctl={ruleCtl} />
                <SortTh k="rule_index" label="#" ctl={ruleCtl} align="right" />
                <SortTh k="clients" label="Clients" ctl={ruleCtl} />
                <SortTh k="protocols" label="Protocols" ctl={ruleCtl} />
                <SortTh k="ro_rule" label="RO" ctl={ruleCtl} />
                <SortTh k="rw_rule" label="RW" ctl={ruleCtl} />
                <SortTh k="superuser" label="Superuser" ctl={ruleCtl} />
              </tr></thead>
              <tbody>
                {ruleCtl.pageRows.map((r) => (
                  <tr key={r.id} className="border-b">
                    <td className="py-2 pr-3 text-ink">{r.policy_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{r.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-right tnum text-ink-faint">{r.rule_index}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px] tnum max-w-[280px] break-words">{r.clients || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.protocols || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.ro_rule || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.rw_rule || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{r.superuser || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TablePager ctl={ruleCtl} />
      </div>

      {modalVolume && (
        <Modal title={`Clients on ${modalVolume.volume_name}`} subtitle={`${modalVolume.svm_name} · ${modalVolume.array_name} · ${modalVolume.clients.length} connection${modalVolume.clients.length === 1 ? '' : 's'}`} onClose={() => setModalVolume(null)} maxWidth="min(560px,92vw)">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
              <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">Server IP</th>
            </tr></thead>
            <tbody>
              {modalVolume.clients.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="py-2 pr-3"><IpWithHost ip={c.client_ip} dns={dns} vm={c.client_name} /></td>
                  <td className="py-2 pr-3"><Badge tone="info">{c.protocol || '—'}</Badge></td>
                  <td className="py-2 pr-3 text-ink-muted">{c.node_name || '—'}</td>
                  <td className="py-2 pr-3"><IpWithHost ip={c.server_ip} dns={dns} muted /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {modalPolicy && (
        <Modal title={`Clients permitted by ${modalPolicy.policy_name}`} subtitle={`${modalPolicy.svm_name} · ${modalPolicy.array_name} · ${modalPolicy.count} client${modalPolicy.count === 1 ? '' : 's'}`} onClose={() => setModalPolicy(null)} maxWidth="min(640px,92vw)">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b">
              <th className="py-2 pr-3">Client</th><th className="py-2 pr-3">Protocols</th><th className="py-2 pr-3">RO</th><th className="py-2 pr-3">RW</th><th className="py-2 pr-3">Superuser</th>
            </tr></thead>
            <tbody>
              {modalPolicy.entries.map((e, i) => (
                <tr key={`${e.client}-${i}`} className="border-b">
                  <td className="py-2 pr-3">{/^\d{1,3}(\.\d{1,3}){3}$/.test(e.client) ? <IpWithHost ip={e.client} dns={dns} /> : <span className="text-ink">{e.client}</span>}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.protocols || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.ro || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.rw || '—'}</td>
                  <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.superuser || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
