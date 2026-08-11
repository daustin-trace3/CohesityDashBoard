import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Crosshair, Search, Server, ShieldCheck, ArrowLeftRight, FolderTree, Package, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, Badge } from '../../components/ui/primitives';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
  if (b >= 1e9) return `${(b / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  if (b >= 1e6) return `${(b / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  return `${Number(b).toLocaleString()} B`;
};
const fmtMem = (mb) => mb == null ? '—' : mb >= 1024 ? `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB` : `${mb} MB`;
const fmtUptime = (s) => s == null ? '—' : `${(s / 86400).toLocaleString(undefined, { maximumFractionDigits: 1 })} d`;
const statusTone = (s) => s === 'green' ? 'ok' : s === 'yellow' ? 'warn' : s === 'red' ? 'crit' : 'neutral';
const runTone = (s) => s === 'Succeeded' || s === 'SucceededWithWarning' ? 'ok' : s === 'Failed' ? 'crit' : s ? 'warn' : 'neutral';
const fmtAgo = (ms) => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

// Same brand colors as the global search dropdown's platform dots.
const PLATFORM_META = {
  cohesity: { label: 'Cohesity', color: '#6CB33F' },
  netapp: { label: 'NetApp', color: '#0067C5' },
  zerto: { label: 'Zerto', color: '#EE3124' },
  vcenter: { label: 'vCenter', color: '#0091DA' },
  aria: { label: 'Aria Automation', color: '#00A2C7' },
};

function PlatformChip({ platform }) {
  const meta = PLATFORM_META[platform];
  if (!meta) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: `${meta.color}55`, color: meta.color, backgroundColor: `${meta.color}14` }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.label}
    </span>
  );
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <div className="text-sm text-ink truncate">{children ?? '—'}</div>
    </div>
  );
}

/** Cross-platform "everything we know about this server" view. */
export default function ServerStatusPage() {
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get('name') || '');
  const [suggestions, setSuggestions] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const load = useCallback((name) => {
    if (!name) return;
    setLoading(true);
    setSuggestions([]);
    client.get('/server360', { params: { name } })
      .then(({ data }) => setData(data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    setParams({ name }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    const name = params.get('name');
    if (name) load(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = input.trim();
    if (q.length < 2 || q === params.get('name')) { setSuggestions([]); return undefined; }
    const id = ++seqRef.current;
    const t = setTimeout(() => {
      client.get('/server360/suggest', { params: { q } })
        .then(({ data }) => { if (seqRef.current === id) setSuggestions(data.names || []); })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const vm = data?.vcenter;
  const pluginSections = data?.plugins || [];
  const nothingFound = data && !data.vcenter && !data.cohesity && !data.zerto && !data.netapp && !data.aria && !pluginSections.length;

  return (
    <div className="animate-fade-in flex flex-col gap-4">
      <PageHeader icon={Crosshair} title="Server 360"
        description="Everything the estate knows about one server — provisioning, compute, backup, DR, and live storage mounts" />

      {/* Picker */}
      <div className="panel p-4">
        <div className="relative max-w-lg">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(suggestions[0] && input !== params.get('name') ? suggestions[0] : input.trim()); }}
            placeholder="Server name or hostname…"
            className="w-full bg-surface border border-cohesity-border text-sm text-ink rounded-lg pl-9 pr-3 py-2 placeholder-ink-faint focus:border-brand/60 transition-colors"
          />
          {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint animate-spin" />}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-40 bg-cohesity-gray border border-cohesity-border rounded-lg shadow-xl overflow-hidden">
              {suggestions.map((n) => (
                <button key={n} onClick={() => { setInput(n); load(n); }}
                  className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-brand/10 transition-colors cursor-pointer">{n}</button>
              ))}
            </div>
          )}
        </div>
        {data?.identity && (
          <p className="text-[11px] text-ink-faint mt-2 tnum">
            Pivoting on {data.identity.names.join(', ')}{data.identity.ips.length ? ` · IPs ${data.identity.ips.join(', ')}` : ' · no known IPs'}
          </p>
        )}
      </div>

      {nothingFound && (
        <div className="panel p-6 text-sm text-ink-muted text-center">
          No platform has data for “{data.query}”. Check the spelling, or the server may not be inventoried yet.
        </div>
      )}

      {/* vCenter — identity & compute */}
      {vm && (
        <Panel title={`Compute — ${vm.vcenter_name}`} icon={Server} actions={<PlatformChip platform="vcenter" />}>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="VM">{vm.name}</Fact>
            <Fact label="Guest Hostname">{vm.guest_hostname || '—'}</Fact>
            <Fact label="Power"><Badge tone={String(vm.power_state).includes('ON') || String(vm.power_state) === 'poweredOn' ? 'ok' : 'neutral'}>{String(vm.power_state || '—').replace(/^POWERED_/, '')}</Badge></Fact>
            <Fact label="Health"><Badge tone={statusTone(vm.overall_status)}>{vm.overall_status || 'unknown'}</Badge></Fact>
            <Fact label="CPU">{vm.cpu_count ?? '—'} vCPU{vm.cpu_pct != null ? ` · ${vm.cpu_pct}%` : ''}</Fact>
            <Fact label="Memory">{fmtMem(vm.memory_mb)}{vm.mem_pct != null ? ` · ${vm.mem_pct}%` : ''}</Fact>
            <Fact label="Guest OS">{vm.guest_os || '—'}</Fact>
            <Fact label="ESX Host">{vm.host_name || '—'}</Fact>
            <Fact label="Cluster">{vm.cluster_name || '—'}</Fact>
            <Fact label="Uptime">{fmtUptime(vm.uptime_seconds)}</Fact>
            <Fact label="Datastores">{(vm.datastores || []).join(', ') || '—'}</Fact>
            <Fact label="Networks">{(vm.networks || []).join(', ') || '—'}</Fact>
          </div>
        </Panel>
      )}

      {/* vRA provenance */}
      {data?.aria && (
        <Panel title="Provisioning" icon={Package} actions={<PlatformChip platform="aria" />}>
          {data.aria.deployments.map((d) => (
            <div key={d.id} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-2">
              <Fact label="Deployment">{d.name}</Fact>
              <Fact label="Project">{d.project_name || '—'}</Fact>
              <Fact label="Status"><Badge tone={String(d.status).includes('SUCCESS') || String(d.status) === 'CREATE_SUCCESSFUL' ? 'ok' : 'info'}>{d.status || '—'}</Badge></Fact>
              <Fact label="Created By">{d.created_by || '—'}</Fact>
              <Fact label="Created">{d.created_at_src ? String(d.created_at_src).slice(0, 10) : '—'}</Fact>
              <Fact label="Lease Expires">{d.lease_expire_at ? String(d.lease_expire_at).slice(0, 10) : '—'}</Fact>
            </div>
          ))}
          {data.aria.resources.map((r) => (
            <p key={r.id} className="text-[11px] text-ink-faint tnum">
              resource {r.name} · {r.type || 'unknown type'} · {r.state || '—'}{r.ip_addresses.length ? ` · ${r.ip_addresses.join(', ')}` : ''} · {r.instance_name}
            </p>
          ))}
        </Panel>
      )}

      {/* Cohesity backup posture */}
      {data?.cohesity && (
        <Panel title="Backup" icon={ShieldCheck} actions={<PlatformChip platform="cohesity" />}>
          {data.cohesity.objects.map((o) => (
            <div key={o.id} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-2 border-b border-cohesity-border/40 last:border-0 pb-2">
              <Fact label="Object">{o.name} <span className="text-ink-faint text-[11px]">({o.environment})</span></Fact>
              <Fact label="Protected"><Badge tone={o.is_protected ? 'ok' : 'warn'}>{o.is_protected ? 'protected' : 'unprotected'}</Badge></Fact>
              <Fact label="Cluster">{o.cluster_name}</Fact>
              <Fact label="Protection Group">{o.protection_groups.join(', ') || '—'}</Fact>
              <Fact label="Last Backup">
                {o.last_backup_status ? <Badge tone={runTone(o.last_backup_status)}>{o.last_backup_status}</Badge> : '—'}
                {o.last_backup_ms ? (
                  <span className={`ml-1.5 text-[11px] tnum ${Date.now() - o.last_backup_ms > 7 * 86400000 ? 'text-amber-400' : 'text-ink-faint'}`}>
                    {new Date(o.last_backup_ms).toLocaleDateString()} · {fmtAgo(o.last_backup_ms)}
                  </span>
                ) : null}
              </Fact>
              <Fact label="Logical">{fmtBytes(o.logical_bytes)}</Fact>
              <div className="col-span-full -mt-1">
                <Link to={`/cohesity/object-360?name=${encodeURIComponent(o.name)}`}
                  className="text-[11px] text-brand hover:text-brand-bright" title="Open Cohesity Object 360">
                  Open Object 360 →
                </Link>
              </div>
            </div>
          ))}
          {data.cohesity.agents.map((a) => (
            <p key={a.id} className="text-[11px] text-ink-faint tnum">
              agent {String(a.agent_version || 'unknown').split('_release')[0]} · {a.agent_status || '—'} · {a.upgradability === 'Upgradable' ? 'upgrade available' : a.upgradability || '—'} · {a.cluster_name}
            </p>
          ))}
        </Panel>
      )}

      {/* Installed plugins (display-ready sections from manifest.server360) */}
      {pluginSections.map((p) => (
        <Panel key={p.id} title={p.title} icon={ShieldCheck}
          actions={p.chip ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
              style={{ borderColor: `${p.chip.color}55`, color: p.chip.color, backgroundColor: `${p.chip.color}14` }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p.chip.color }} />
              {p.chip.label}
            </span>
          ) : null}>
          {(p.groups || []).map((g, i) => (
            <div key={i} className="mb-2 border-b border-cohesity-border/40 last:border-0 pb-2 last:pb-0 last:mb-0">
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
                {(g.facts || []).map((f, j) => (
                  <Fact key={j} label={f.label}>
                    {f.tone ? <Badge tone={f.tone}>{f.value ?? '—'}</Badge> : (f.value ?? '—')}
                  </Fact>
                ))}
              </div>
              {(g.lines || []).map((line, j) => (
                <p key={j} className="text-[11px] text-ink-faint tnum mt-1">{line}</p>
              ))}
              {g.link && (
                <Link to={g.link.href} className="inline-block text-[11px] text-brand hover:text-brand-bright mt-1" title={g.link.label}>
                  {g.link.label}
                </Link>
              )}
            </div>
          ))}
        </Panel>
      ))}

      {/* Zerto DR */}
      {data?.zerto && (
        <Panel title="Disaster Recovery" icon={ArrowLeftRight} actions={<PlatformChip platform="zerto" />}>
          {data.zerto.vms.map((z) => (
            <div key={z.id} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
              <Fact label="VPG">{z.vpg_names || '—'}</Fact>
              <Fact label="VPG Status">{z.vpg_statuses || '—'}</Fact>
              <Fact label="Protected Site">{z.protected_site || '—'}</Fact>
              <Fact label="Recovery Site">{z.recovery_site || '—'}</Fact>
              <Fact label="Journal Storage">{z.used_storage_mb != null ? fmtMem(z.used_storage_mb) : '—'}</Fact>
            </div>
          ))}
        </Panel>
      )}

      {/* NetApp live mounts */}
      {data?.netapp && (
        <Panel title="Storage Mounts" icon={FolderTree} actions={<PlatformChip platform="netapp" />}>
          {[...data.netapp.nfs.map((m) => ({ ...m, proto: m.protocol || 'NFS' })),
            ...data.netapp.smb.map((m) => ({ ...m, proto: m.protocol || 'SMB' }))].map((m, i) => (
            <div key={i} className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3 mb-2 border-b border-cohesity-border/40 last:border-0 pb-2">
              <Fact label="Protocol"><Badge tone="info">{m.proto}</Badge></Fact>
              <Fact label="Volume">{m.volume_name || '—'}</Fact>
              <Fact label="SVM / Cluster">{m.svm_name || '—'} · {m.array_name}</Fact>
              <Fact label="Client IP">{m.client_ip}</Fact>
              <Fact label={m.smb_user != null ? 'User' : 'Server IP'}>{m.smb_user ?? m.server_ip ?? '—'}</Fact>
              <Fact label="Volume Used">{m.volume?.size_bytes != null ? `${fmtBytes(m.volume.used_bytes)} / ${fmtBytes(m.volume.size_bytes)}${m.volume.used_percent != null ? ` (${Math.round(m.volume.used_percent)}%)` : ''}` : '—'}</Fact>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
