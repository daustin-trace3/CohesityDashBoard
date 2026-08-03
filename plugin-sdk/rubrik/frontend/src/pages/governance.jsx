// Rubrik v2.0.0 — Governance & Audit page. Mirrors the host
// GovernancePage.jsx (policy audit / retention drift / software versions /
// source coverage) using the rbk- kit exclusively. Rubrik has no Views
// concept and no per-object agent inventory, so those two host tabs are
// not mirrored — the WP brief scopes this page to 4 tabs.

import {
  injectStyles, PageHeader, Panel, Badge, StatCard, LoadingPanel, RefreshButton, LastUpdated,
  ClipboardIcon, FileIcon, ShieldIcon as ShieldOffIcon, LayersIcon, LockIcon, ArrowsIcon,
} from '../ui';

injectStyles();

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b >= 1e15) return (b / 1e15).toFixed(2) + ' PB';
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(1) + ' MB';
}

function fmtRetention(days) {
  if (days == null) return '—';
  if (days % 365 === 0 && days >= 365) return `${days / 365}y`;
  if (days % 30 === 0 && days >= 30) return `${days / 30}mo`;
  if (days % 7 === 0 && days >= 7) return `${days / 7}w`;
  return `${days}d`;
}

function useRbkFetch(path) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [nonce, setNonce] = React.useState(0);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);
  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`/api/rubrik${path}`, { credentials: 'include' })
      .then((res) => { if (!res.ok) throw new Error(`request failed: ${res.status}`); return res.json(); })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [path, nonce]);
  return { data, error, reload };
}

const GOV_TABS = [
  { key: 'policies', label: 'Policy Audit', icon: FileIcon },
  { key: 'drift', label: 'Retention Drift', icon: ArrowsIcon },
  { key: 'versions', label: 'Software Versions', icon: LayersIcon },
  { key: 'sources', label: 'Source Coverage', icon: ShieldOffIcon },
];

function TargetChips({ targets }) {
  if (!targets || targets.length === 0) return <span style={{ color: 'var(--rbk-ink-faint)' }}>None</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 240 }}>
      {[...new Set(targets)].map((t) => (
        <span key={t} style={{ display: 'inline-flex', padding: '2px 6px', borderRadius: 4, background: 'var(--rbk-surface-overlay)', border: '1px solid var(--rbk-border)', fontSize: 11, color: 'var(--rbk-ink)', whiteSpace: 'nowrap' }}>{t}</span>
      ))}
    </div>
  );
}

export default function GovernancePage() {
  const { data, error, reload } = useRbkFetch('/governance');
  const [lastRefreshed, setLastRefreshed] = React.useState(null);
  const [tab, setTab] = React.useState('policies');
  const [policyFilter, setPolicyFilter] = React.useState('all');

  React.useEffect(() => { if (data) setLastRefreshed(new Date()); }, [data]);

  const summary = data?.summary || {};
  const policies = data?.policies || [];
  const sources = data?.sources || [];
  const versions = data?.versions || [];

  // Retention drift: same-named policies with different retention values —
  // only meaningful if the policies rows carry a per-cluster association.
  const retentionDrift = React.useMemo(() => {
    const byName = new Map();
    for (const p of policies) {
      if (!p.cluster) continue;
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push(p);
    }
    const out = [];
    for (const [name, variants] of byName) {
      const distinct = new Set(variants.map((v) => v.retentionDays));
      if (distinct.size > 1) out.push({ name, variants });
    }
    return out;
  }, [policies]);
  const driftNames = new Set(retentionDrift.map((d) => d.name));

  const visiblePolicies = policyFilter === 'flagged'
    ? policies.filter((p) => p.noOffsite || driftNames.has(p.name))
    : policies;

  const loading = !data && !error;
  const hasAnyData = policies.length > 0 || sources.length > 0;

  return (
    <div className="rbk-root rbk-fade-in">
      <PageHeader icon={ClipboardIcon} title="Governance &amp; Audit" description="SLA policy compliance, unprotected sources, and software version drift across the estate">
        <RefreshButton onClick={reload} />
        <LastUpdated date={lastRefreshed} prefix="Last refreshed" />
      </PageHeader>

      {loading ? (
        <div className="rbk-panel"><LoadingPanel label="Loading governance data…" height={320} /></div>
      ) : error ? (
        <div className="rbk-panel" style={{ padding: 24, textAlign: 'center', color: 'var(--rbk-ink-muted)', fontSize: 13 }}>
          Could not load governance data. <button onClick={reload} className="rbk-btn-ghost" style={{ display: 'inline-flex', marginLeft: 6 }}>Retry</button>
        </div>
      ) : !hasAnyData ? (
        <div className="rbk-panel" style={{ padding: 40, textAlign: 'center' }}>
          <ClipboardIcon size={28} style={{ color: 'var(--rbk-ink-faint)' }} />
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--rbk-ink)', margin: '10px 0 4px' }}>No governance data collected yet</p>
          <p style={{ fontSize: 12, color: 'var(--rbk-ink-muted)', maxWidth: 380, margin: '0 auto' }}>
            Policies and source registrations are collected during each poll cycle. Refresh after the next scheduled run.
          </p>
        </div>
      ) : (
        <>
          <div className="rbk-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
            <div style={{ '--rbk-i': 0 }}>
              <StatCard icon={FileIcon} label="SLA Policies" value={summary.policyCount ?? '—'} tone="brand" onClick={() => setTab('policies')} />
            </div>
            <div style={{ '--rbk-i': 1 }}>
              <StatCard icon={ShieldOffIcon} label="No Off-site Copy" value={summary.noOffsiteCount ?? '—'} sub="3-2-1 rule violations" tone="warn" onClick={() => setTab('policies')} />
            </div>
            <div style={{ '--rbk-i': 2 }}>
              <StatCard icon={ShieldOffIcon} label="Unprotected Objects" value={summary.totalUnprotected ?? '—'} tone={(summary.totalUnprotected || 0) > 0 ? 'warn' : 'ok'} onClick={() => setTab('sources')} />
            </div>
            <div style={{ '--rbk-i': 3 }}>
              <StatCard icon={LayersIcon} label="Software Versions" value={summary.versionSpread ?? '—'} sub={summary.dominantVersion ? `Dominant: ${summary.dominantVersion}` : undefined} tone="info" onClick={() => setTab('versions')} />
            </div>
          </div>

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'var(--rbk-surface)', border: '1px solid var(--rbk-border)', padding: 4, marginBottom: 16, flexWrap: 'wrap' }}>
            {GOV_TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6,
                    fontSize: 12, fontWeight: 500, cursor: 'pointer', border: 'none',
                    background: active ? 'var(--rbk-surface-overlay)' : 'transparent',
                    color: active ? 'var(--rbk-ink)' : 'var(--rbk-ink-muted)',
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,.4)' : 'none',
                  }}>
                  <Icon size={13} style={{ color: active ? 'var(--rbk-brand)' : undefined }} /> {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'policies' && (
            <Panel title="Policy Audit" icon={FileIcon}
              actions={
                <div style={{ display: 'flex', gap: 4 }}>
                  {['all', 'flagged'].map((f) => (
                    <button key={f} onClick={() => setPolicyFilter(f)}
                      className={f === policyFilter ? 'rbk-pill rbk-pill-active' : 'rbk-pill'}
                      style={{ padding: '4px 10px', fontSize: 11 }}>
                      {f === 'flagged' ? `Flagged (${policies.filter((p) => p.noOffsite || driftNames.has(p.name)).length})` : 'All'}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)', borderBottom: '1px solid var(--rbk-border)' }}>
                      <th style={{ padding: '8px 12px 8px 0' }}>Policy</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>Retention</th>
                      <th style={{ padding: '8px 12px 8px 0' }}>Replication</th>
                      <th style={{ padding: '8px 12px 8px 0' }}>Archival</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>DataLock</th>
                      <th style={{ padding: '8px 0' }}>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePolicies.map((p, i) => (
                      <tr key={`${p.name}-${i}`} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                        <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', fontWeight: 500, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>{p.name}</td>
                        <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtRetention(p.retentionDays)}</td>
                        <td style={{ padding: '8px 12px 8px 0' }}><TargetChips targets={p.replicationTargets} /></td>
                        <td style={{ padding: '8px 12px 8px 0' }}><TargetChips targets={p.archivalTargets} /></td>
                        <td style={{ padding: '8px 12px 8px 0', textAlign: 'center' }}>{p.dataLock ? <LockIcon size={13} style={{ color: 'var(--rbk-brand)' }} /> : <span style={{ color: 'var(--rbk-ink-faint)' }}>—</span>}</td>
                        <td style={{ padding: '8px 0' }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {p.noOffsite && <Badge tone="warn">No off-site copy</Badge>}
                            {driftNames.has(p.name) && <Badge tone="info">Retention drift</Badge>}
                            {!p.noOffsite && !driftNames.has(p.name) && <span style={{ color: 'var(--rbk-ink-faint)' }}>—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visiblePolicies.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--rbk-ink-faint)' }}>No policies {policyFilter === 'flagged' ? 'flagged' : 'collected'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {tab === 'drift' && (
            <Panel title="Retention Drift" icon={ArrowsIcon}>
              {retentionDrift.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--rbk-ok)', textAlign: 'center', padding: '24px 0' }}>No retention drift detected — same-named policies agree across clusters.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {retentionDrift.map((d) => (
                    <div key={d.name} style={{ borderRadius: 8, border: '1px solid var(--rbk-border)', background: 'rgba(30,42,54,0.4)', padding: '10px 14px' }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--rbk-ink)', margin: '0 0 6px' }}>{d.name}</p>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {d.variants.map((v, i) => (
                          <Badge key={i} tone="neutral">{v.cluster}: {fmtRetention(v.retentionDays)}</Badge>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === 'versions' && (
            <Panel title="Software Versions" icon={LayersIcon}>
              {versions.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--rbk-ink-faint)', textAlign: 'center', padding: '24px 0' }}>No version data collected yet.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {versions.map((v) => (
                    <div key={v.cluster} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--rbk-border)', padding: '6px 0' }}>
                      <span style={{ fontSize: 12, color: 'var(--rbk-ink)' }}>{v.cluster}</span>
                      {v.softwareVersion ? (
                        <Badge tone={v.isOutlier ? 'warn' : 'ok'}>{v.softwareVersion}{v.isOutlier && ' (outlier)'}</Badge>
                      ) : (
                        <Badge tone="neutral">unknown</Badge>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          )}

          {tab === 'sources' && (
            <Panel title="Source Protection Coverage" icon={ShieldOffIcon}>
              <div className="rbk-scroll" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--rbk-ink-muted)', borderBottom: '1px solid var(--rbk-border)' }}>
                      <th style={{ padding: '8px 12px 8px 0' }}>Source</th>
                      <th style={{ padding: '8px 12px 8px 0' }}>Cluster</th>
                      <th style={{ padding: '8px 12px 8px 0' }}>Environment</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>Protected</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>Unprotected</th>
                      <th style={{ padding: '8px 12px 8px 0', textAlign: 'right' }}>Unprotected Size</th>
                      <th style={{ padding: '8px 0', width: 140 }}>Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s, i) => {
                      const total = (s.protectedCount || 0) + (s.unprotectedCount || 0);
                      const pct = total > 0 ? ((s.protectedCount || 0) / total) * 100 : null;
                      const barColor = pct == null ? 'var(--rbk-border)' : pct >= 95 ? 'var(--rbk-ok)' : pct >= 75 ? 'var(--rbk-warn)' : 'var(--rbk-crit)';
                      return (
                        <tr key={`${s.cluster}-${s.name}-${i}`} className="rbk-row" style={{ borderBottom: '1px solid var(--rbk-border)' }}>
                          <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink)', fontWeight: 500, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name || '—'}</td>
                          <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.cluster}</td>
                          <td style={{ padding: '8px 12px 8px 0', color: 'var(--rbk-ink-muted)' }}>{s.environment || '—'}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink)' }}>{s.protectedCount ?? '—'}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', fontWeight: 600, color: (s.unprotectedCount || 0) > 0 ? 'var(--rbk-warn)' : 'var(--rbk-ok)' }}>{s.unprotectedCount ?? '—'}</td>
                          <td className="rbk-tnum" style={{ padding: '8px 12px 8px 0', textAlign: 'right', color: 'var(--rbk-ink-muted)' }}>{fmtBytes(s.unprotectedBytes)}</td>
                          <td style={{ padding: '8px 0' }}>
                            {pct != null ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 1.5, background: 'var(--rbk-surface-base)', borderRadius: 999, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${pct}%`, background: barColor }} />
                                </div>
                                <span className="rbk-tnum" style={{ fontSize: 10, color: 'var(--rbk-ink-muted)', width: 36, textAlign: 'right' }}>{pct.toFixed(0)}%</span>
                              </div>
                            ) : <span style={{ color: 'var(--rbk-ink-faint)' }}>—</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {sources.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: '24px 0', color: 'var(--rbk-ink-faint)' }}>No source registration data collected yet</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
