import { useEffect, useState, useMemo, useCallback } from 'react';
import { Share2, RefreshCw, Users, ShieldCheck, X } from 'lucide-react';
import client from '../../api/client';
import useDnsResolve from '../../api/useDnsResolve';
import IpWithHost from '../../components/IpWithHost';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, StatCard, Badge, LoadingPanel } from '../../components/ui/primitives';
import { BRAND, fmtNum } from './helpers';

export default function NetAppNfsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);

  const load = useCallback(() => client.get('/netapp/nfs')
    .then(({ data }) => setData(data))
    .catch(() => { setData({ clients: [], exportRules: [] }); toast({ type: 'error', title: 'Failed to load NFS data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const clients = data?.clients || [];
  const rules = data?.exportRules || [];
  const uniqueClients = useMemo(() => new Set(clients.map((c) => c.client_ip)).size, [clients]);
  const policies = useMemo(() => new Set(rules.map((r) => `${r.svm_name}/${r.policy_name}`)).size, [rules]);

  // Reverse-resolve client + server IPs via the configured DNS server.
  const ipList = useMemo(() => {
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

  // Group connected clients by volume for a drill-down summary.
  const [modalVolume, setModalVolume] = useState(null);
  const byVolume = useMemo(() => {
    const groups = new Map();
    for (const c of clients) {
      const key = `${c.array_name}|${c.svm_name}|${c.volume_name}`;
      if (!groups.has(key)) groups.set(key, { key, volume_name: c.volume_name, svm_name: c.svm_name, array_name: c.array_name, clients: [] });
      groups.get(key).clients.push(c);
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        uniqueIps: new Set(g.clients.map((c) => c.client_ip)).size,
        protocols: [...new Set(g.clients.map((c) => c.protocol).filter(Boolean))].join(', '),
      }))
      .sort((a, b) => b.uniqueIps - a.uniqueIps);
  }, [clients]);

  // Group export-policy rules by policy (≈ volume) so a policy that permits
  // several clients — across multiple rules or a comma-separated rule — shows a
  // single clickable count that opens the full permitted-client list.
  const [modalPolicy, setModalPolicy] = useState(null);
  const byPolicy = useMemo(() => {
    const groups = new Map();
    for (const r of rules) {
      const key = `${r.array_name}|${r.svm_name}|${r.policy_name}`;
      if (!groups.has(key)) groups.set(key, { key, policy_name: r.policy_name, svm_name: r.svm_name, array_name: r.array_name, entries: [] });
      const specs = String(r.clients || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) {
        groups.get(key).entries.push({ client: spec, ro: r.ro_rule, rw: r.rw_rule, superuser: r.superuser, protocols: r.protocols, rule_index: r.rule_index });
      }
    }
    return [...groups.values()]
      .map((g) => ({ ...g, count: g.entries.length, volume: g.policy_name.replace(/^ep_/, '') }))
      .sort((a, b) => b.count - a.count);
  }, [rules]);

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Share2} title="NetApp NFS" description="Live NFS client-to-volume map and export-policy access rules">
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink hover:border-brand/40 transition-colors">
          <RefreshCw size={15} /> Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={Users} label="Connected Clients" value={fmtNum(clients.length)} tone="brand" />
        <StatCard icon={Users} label="Unique Client IPs" value={fmtNum(uniqueClients)} />
        <StatCard icon={ShieldCheck} label="Export Policies" value={fmtNum(policies)} />
        <StatCard icon={ShieldCheck} label="Policy Rules" value={fmtNum(rules.length)} />
      </div>

      {/* Clients grouped by volume (click a count for the full list) */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">NFS Clients by Volume</p>
        {data == null ? (
          <LoadingPanel label="Loading…" height={100} />
        ) : byVolume.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No NFS clients currently connected.</div>
        ) : (
          <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Volume</th><th className="py-2 pr-3">SVM</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3">Protocols</th><th className="py-2 pr-3 text-right">Clients</th>
              </tr></thead>
              <tbody>
                {byVolume.map((g) => (
                  <tr key={g.key} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{g.volume_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-ink-muted text-[11px]">{g.protocols || '—'}</td>
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
      </div>

      {/* Connected clients */}
      <div className="panel p-4 mb-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Connected NFS Clients</p>
        {data == null ? (
          <LoadingPanel label="Loading clients…" height={120} />
        ) : clients.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No NFS clients currently connected.</div>
        ) : (
          <div className="overflow-x-auto max-h-[45vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">SVM</th><th className="py-2 pr-3">Volume</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3">Server IP</th><th className="py-2 pr-3">Cluster</th>
              </tr></thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3"><IpWithHost ip={c.client_ip} dns={dns} /></td>
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
      </div>

      {/* Export policy rules */}
      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-1">Permitted Clients by Export Policy</p>
        <p className="text-[11px] text-ink-faint mb-3">Click a client count to see every host permitted by that policy.</p>
        {data == null ? (
          <LoadingPanel label="Loading export rules…" height={120} />
        ) : byPolicy.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No export policy rules found.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Export Policy</th><th className="py-2 pr-3">Volume</th><th className="py-2 pr-3">SVM</th><th className="py-2 pr-3">Cluster</th><th className="py-2 pr-3 text-right">Clients</th>
              </tr></thead>
              <tbody>
                {byPolicy.map((g) => (
                  <tr key={g.key} className="border-b border-cohesity-border/50">
                    <td className="py-2 pr-3 text-ink">{g.policy_name}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.volume || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.svm_name || '—'}</td>
                    <td className="py-2 pr-3 text-ink-muted">{g.array_name}</td>
                    <td className="py-2 pr-3 text-right">
                      <button onClick={() => setModalPolicy(g)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold tnum border border-brand/30 text-brand hover:bg-brand/10 transition-colors cursor-pointer">
                        {g.count} <Users size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Raw export policy rules */}
      <div className="panel p-4 mt-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <p className="text-sm font-semibold text-ink mb-3">Export Policy Rules</p>
        {data == null ? (
          <LoadingPanel label="Loading export rules…" height={120} />
        ) : rules.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No export policy rules found.</div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                <th className="py-2 pr-3">Policy</th><th className="py-2 pr-3">SVM</th><th className="py-2 pr-3 text-right">#</th><th className="py-2 pr-3">Clients</th><th className="py-2 pr-3">Protocols</th><th className="py-2 pr-3">RO</th><th className="py-2 pr-3">RW</th><th className="py-2 pr-3">Superuser</th>
              </tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-cohesity-border/50">
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
      </div>

      {modalVolume && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setModalVolume(null)}>
          <div className="panel w-full max-w-lg p-5 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink truncate">Clients on {modalVolume.volume_name}</h2>
                <p className="text-[11px] text-ink-muted">{modalVolume.svm_name} · {modalVolume.array_name} · {modalVolume.clients.length} connection{modalVolume.clients.length === 1 ? '' : 's'}</p>
              </div>
              <button onClick={() => setModalVolume(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Client IP</th><th className="py-2 pr-3">Protocol</th><th className="py-2 pr-3">Node</th><th className="py-2 pr-3">Server IP</th>
                </tr></thead>
                <tbody>
                  {modalVolume.clients.map((c) => (
                    <tr key={c.id} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3"><IpWithHost ip={c.client_ip} dns={dns} /></td>
                      <td className="py-2 pr-3"><Badge tone="info">{c.protocol || '—'}</Badge></td>
                      <td className="py-2 pr-3 text-ink-muted">{c.node_name || '—'}</td>
                      <td className="py-2 pr-3"><IpWithHost ip={c.server_ip} dns={dns} muted /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {modalPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setModalPolicy(null)}>
          <div className="panel w-full max-w-xl p-5 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-ink truncate">Clients permitted by {modalPolicy.policy_name}</h2>
                <p className="text-[11px] text-ink-muted">{modalPolicy.svm_name} · {modalPolicy.array_name} · {modalPolicy.count} client{modalPolicy.count === 1 ? '' : 's'}</p>
              </div>
              <button onClick={() => setModalPolicy(null)} aria-label="Close" className="text-ink-faint hover:text-ink flex-shrink-0"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
                  <th className="py-2 pr-3">Client</th><th className="py-2 pr-3">Protocols</th><th className="py-2 pr-3">RO</th><th className="py-2 pr-3">RW</th><th className="py-2 pr-3">Superuser</th>
                </tr></thead>
                <tbody>
                  {modalPolicy.entries.map((e, i) => (
                    <tr key={`${e.client}-${i}`} className="border-b border-cohesity-border/50">
                      <td className="py-2 pr-3">{/^\d{1,3}(\.\d{1,3}){3}$/.test(e.client) ? <IpWithHost ip={e.client} dns={dns} /> : <span className="text-ink">{e.client}</span>}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.protocols || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.ro || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.rw || '—'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[11px]">{e.superuser || '—'}</td>
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
