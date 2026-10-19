import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, Badge, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND, fmtNum, fmtWhen, severityTone, useVisibleInterval } from './helpers';
import { inp, sel, headRow, chipBtn, Modal, Fact, ServerSortTh, ServerPager, btnGhost } from './ui';

const REFRESH_MS = 60000;
const SEVERITIES = [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']];

function AlertModal({ alert, onClose }) {
  const navigate = useNavigate();
  const a = alert;
  return (
    <Modal icon={Bell} title={`${a.monitorObjectName || '-'} - ${a.datasource || ''}`} subtitle={a.internalId || a.id} onClose={onClose} width="max-w-3xl">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={severityTone(a.severityNorm)}>{a.severityNorm || a.severity}</Badge>
        {a.cleared ? <Badge tone="neutral">Cleared</Badge> : <Badge tone="crit">Open</Badge>}
        {a.acked ? <Badge tone="info">Acked</Badge> : null}
        {a.sdted ? <Badge tone="neutral">In SDT</Badge> : null}
        {a.anomaly ? <Badge tone="warn">Anomaly</Badge> : null}
        {a.duplicateOf ? <Badge tone="neutral">{`Relay of ${String(a.duplicateOf).replace('duplicate:', '')}`}</Badge> : null}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <Fact label="Resource">{a.monitorObjectName}</Fact>
        <Fact label="DataSource">{a.datasource}</Fact>
        <Fact label="Instance">{a.instanceName}</Fact>
        <Fact label="Datapoint">{a.dataPointName}</Fact>
        <Fact label="Value">{a.alertValue}</Fact>
        <Fact label="Threshold">{a.threshold}</Fact>
        <Fact label="Started">{fmtWhen(a.startedAt)}</Fact>
        <Fact label="Ended">{a.endedAt ? fmtWhen(a.endedAt) : '-'}</Fact>
        <Fact label="Type">{a.type}</Fact>
        <Fact label="Acked by">{a.ackedBy || '-'}</Fact>
        <Fact label="Rule">{a.rule || '(no rule)'}</Fact>
        <Fact label="Chain">{a.chain || '-'}</Fact>
        <Fact label="Suppressor">{a.suppressor || '-'}</Fact>
        <Fact label="LM alert id">{a.id}</Fact>
      </div>
      {a.ackComment && (
        <div className="mb-3">
          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Ack comment</p>
          <p className="text-xs text-ink bg-surface-overlay rounded-lg p-2 whitespace-pre-wrap">{a.ackComment}</p>
        </div>
      )}
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Condition key</p>
      <p className="text-[11px] text-ink-muted font-mono break-all mb-4">{a.conditionKey}</p>
      {a.deviceId && (
        <button onClick={() => navigate(`/logicmonitor/devices?device=${a.deviceId}`)} className={btnGhost}>Open device</button>
      )}
    </Modal>
  );
}

export default function LmAlertsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({});
  const [duplicates, setDuplicates] = useState({ total: 0, byPlatform: [] });
  const [datasources, setDatasources] = useState([]);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('startedAt');
  const [dir, setDir] = useState('desc');
  const [pageSize, setPageSize] = useState(25);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [detail, setDetail] = useState(null);
  const limit = pageSize === 'all' ? 500 : pageSize;

  const severity = searchParams.get('severity') || '';
  const cleared = searchParams.get('cleared') || '0';
  const acked = searchParams.get('acked') || '';
  const datasource = searchParams.get('datasource') || '';
  const deviceId = searchParams.get('deviceId') || '';
  const duplicate = searchParams.get('duplicate') || '';

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
    setPage(1);
  };

  const load = useCallback(() => {
    const params = { page, limit, sort, dir, cleared };
    if (q.trim()) params.q = q.trim();
    if (severity) params.severity = severity;
    if (acked) params.acked = acked;
    if (datasource) params.datasource = datasource;
    if (deviceId) params.deviceId = deviceId;
    if (duplicate) params.duplicate = duplicate;
    return client.get('/logicmonitor/alerts', { params })
      .then(({ data }) => {
        setRows(Array.isArray(data?.items) ? data.items : []);
        setTotal(data?.total ?? 0);
        setCounts(data?.counts || {});
        setDuplicates(data?.duplicates || { total: 0, byPlatform: [] });
        setLastRefreshed(new Date());
      })
      .catch(() => { setRows([]); setTotal(0); toast({ type: 'error', title: 'Failed to load alerts' }); });
  }, [q, page, limit, sort, dir, cleared, severity, acked, datasource, deviceId, duplicate, toast]);

  useEffect(() => { load(); }, [load]);
  useVisibleInterval(load, REFRESH_MS);
  useEffect(() => {
    client.get('/logicmonitor/summary')
      .then(({ data }) => setDatasources((Array.isArray(data?.alertsByDatasource) ? data.alertsByDatasource : []).filter((d) => d && d.name)))
      .catch(() => setDatasources([]));
  }, []);

  const onSort = (k) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(k === 'startedAt' ? 'desc' : 'asc'); }
    setPage(1);
  };

  const dsNames = datasources.map((d) => d.name);
  const dsCounts = Object.fromEntries(datasources.map((d) => [d.name, d.count]));
  const dsOptions = datasource && !dsNames.includes(datasource) ? [datasource, ...dsNames] : dsNames;

  return (
    <div className="animate-fade-in">
      <PageHeader icon={Bell} title="Alerts" description="LogicMonitor alerts as raised by the portal. Computed ICC issues live on the Issues page.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      <div className="panel p-4" style={{ borderTop: `3px solid ${BRAND}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search resource, instance or datapoint..." className={`${inp} flex-1 min-w-[200px]`} spellCheck={false} />
          <select value={severity} onChange={(e) => setParam('severity', e.target.value)} className={sel} aria-label="Severity">
            <option value="">{`All open (${fmtNum(counts.total ?? ((counts.critical || 0) + (counts.warning || 0) + (counts.info || 0)))})`}</option>
            {SEVERITIES.map(([k, l]) => <option key={k} value={k}>{`${l} (${fmtNum(counts[k] || 0)})`}</option>)}
          </select>
          <select value={cleared} onChange={(e) => setParam('cleared', e.target.value === '0' ? '' : e.target.value)} className={sel} aria-label="State">
            <option value="0">Open</option>
            <option value="1">Cleared</option>
            <option value="all">Open and cleared</option>
          </select>
          <select value={acked} onChange={(e) => setParam('acked', e.target.value)} className={sel} aria-label="Acked">
            <option value="">Any ack state</option>
            <option value="1">{`Acked (${fmtNum(counts.acked || 0)})`}</option>
            <option value="0">Unacked</option>
          </select>
          {(duplicates.total > 0 || duplicate === '1' || duplicate === 'all') && (
            <select
              value={duplicate}
              onChange={(e) => setParam('duplicate', e.target.value)}
              className={sel}
              aria-label="Relays"
              title={duplicates.byPlatform.length
                ? `Relays of feeds ICC already polls directly, kept out of the counts and the Ops Agent: ${duplicates.byPlatform.map((p) => `${p.label} ${p.count}`).join(', ')}`
                : 'Alerts that relay a feed ICC already polls directly'}
            >
              <option value="">Hide relays</option>
              <option value="1">{`Only relays (${fmtNum(duplicates.total || 0)})`}</option>
              <option value="all">Include relays</option>
            </select>
          )}
          <select value={datasource} onChange={(e) => setParam('datasource', e.target.value)} className={sel} aria-label="DataSource">
            <option value="">All DataSources</option>
            {dsOptions.map((d) => <option key={d} value={d}>{dsCounts[d] != null ? `${d} (${fmtNum(dsCounts[d])})` : d}</option>)}
          </select>
          {deviceId && <button onClick={() => setParam('deviceId', '')} className={chipBtn(true)}>Device {deviceId} x</button>}
        </div>
        <p className="text-[11px] text-ink-faint mb-3">In SDT: {fmtNum(counts.sdted || 0)} (counts are over the open set)</p>

        {rows == null ? <LoadingPanel label="Loading alerts..." height={200} /> : rows.length === 0 ? (
          <div className="text-sm text-ink-muted py-6 text-center">No alerts match.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className={headRow}>
                  <ServerSortTh k="severity" label="Severity" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="monitorObjectName" label="Resource" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="datasource" label="DataSource" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Instance</th>
                  <ServerSortTh k="dataPointName" label="Datapoint" sort={sort} dir={dir} onSort={onSort} />
                  <th className="py-2 pr-3">Value</th>
                  <th className="py-2 pr-3">Threshold</th>
                  <ServerSortTh k="startedAt" label="Started" sort={sort} dir={dir} onSort={onSort} />
                  <ServerSortTh k="acked" label="State" sort={sort} dir={dir} onSort={onSort} />
                </tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={`${a.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => setDetail(a)}>
                      <td className="py-2 pr-3"><Badge tone={severityTone(a.severityNorm)}>{a.severityNorm || a.severity}</Badge></td>
                      <td className="py-2 pr-3 text-ink truncate max-w-[200px]">{a.monitorObjectName}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{a.datasource}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px] truncate max-w-[180px]">{a.instanceName || '-'}</td>
                      <td className="py-2 pr-3 text-ink-muted text-[12px]">{a.dataPointName || '-'}</td>
                      <td className="py-2 pr-3 tnum text-ink text-[12px]">{a.alertValue ?? '-'}</td>
                      <td className="py-2 pr-3 tnum text-ink-faint text-[11px] truncate max-w-[120px]">{a.threshold || '-'}</td>
                      <td className="py-2 pr-3 text-ink-faint text-[11px] tnum whitespace-nowrap">{fmtWhen(a.startedAt)}</td>
                      <td className="py-2 pr-3">
                        <div className="flex gap-1 flex-wrap">
                          {a.cleared ? <Badge tone="neutral">Cleared</Badge> : null}
                          {a.acked ? <Badge tone="info">Acked</Badge> : null}
                          {a.sdted ? <Badge tone="neutral">SDT</Badge> : null}
                          {a.duplicateOf ? <Badge tone="neutral">Duplicate</Badge> : null}
                          {!a.cleared && !a.acked && !a.sdted ? <span className="text-[11px] text-ink-faint">Open</span> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ServerPager shown={rows.length} total={total} page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} noun="alert(s)" />
          </>
        )}
      </div>

      {detail && <AlertModal alert={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
