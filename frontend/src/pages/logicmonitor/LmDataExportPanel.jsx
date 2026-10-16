import { useEffect, useMemo, useState } from 'react';
import { Database, Download } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { LoadingPanel } from '../../components/ui/primitives';
import { fmtNum, saveBlob } from './helpers';
import { SectionPanel, inp, btnGhost, headRow, chipBtn } from './ui';
import { RawCollectionGroup } from './LmRawDatasources';

const today = () => new Date().toISOString().slice(0, 10);

function Table({ cols, rows, max = 200 }) {
  return (
    <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead><tr className={headRow}>{cols.map(([k, l]) => <th key={k} className="py-2 pr-3">{l}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i} className="border-b border-cohesity-border/50">
              {cols.map(([k]) => <td key={k} className="py-1.5 pr-3 text-[12px] text-ink-muted truncate max-w-[320px]" title={r[k] == null ? '' : String(r[k])}>{r[k] == null || r[k] === '' ? '-' : typeof r[k] === 'number' ? fmtNum(r[k]) : String(r[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <p className="text-[11px] text-ink-faint py-2">Showing {max} of {fmtNum(rows.length)}. The JSON export has everything.</p>}
    </div>
  );
}

export default function LmDataExportPanel() {
  const { toast } = useToast();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('datasources');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.get('/logicmonitor/settings/discovery').then(({ data }) => setD(data)).catch(() => setD({}));
  }, []);

  const exportJson = async (history) => {
    setBusy(true);
    try {
      const { data } = await client.get('/logicmonitor/settings/export.json', { params: { history: history ? 1 : 0 }, responseType: 'blob' });
      saveBlob(data, `logicmonitor-export${history ? '-with-history' : ''}-${today()}.json`);
    } catch { toast({ type: 'error', title: 'Export failed' }); }
    finally { setBusy(false); }
  };

  const term = q.trim().toLowerCase();
  const match = (r) => !term || Object.values(r).some((v) => v != null && String(v).toLowerCase().includes(term));
  const rows = useMemo(() => {
    if (!d) return [];
    if (tab === 'datasources') return (d.datasources || []).filter(match);
    if (tab === 'vendors') return (d.devicesByVendorRole || []).filter(match);
    if (tab === 'deviceProps') return (d.devicePropertyKeys || []).filter(match);
    return (d.interfacePropertyKeys || []).filter(match);
  }, [d, tab, term]); // eslint-disable-line react-hooks/exhaustive-deps

  const cov = d?.circuitCoverage;
  const cols = {
    datasources: [['name', 'DataSource'], ['devices', 'Devices'], ['instances', 'Instances'], ['vendors', 'Vendors'], ['collected', 'ICC collects']],
    vendors: [['vendor', 'Vendor'], ['role', 'Role'], ['isNetwork', 'Network'], ['devices', 'Devices']],
    deviceProps: [['scope', 'Scope'], ['key', 'Property'], ['count', 'Devices'], ['sample', 'Sample value']],
    ifProps: [['scope', 'Scope'], ['key', 'Property'], ['count', 'Interfaces'], ['sample', 'Sample value']],
  }[tab];

  return (
    <SectionPanel icon={Database} title="Data Export"
      blurb="Everything ICC has collected from LogicMonitor, plus what the portals offer that ICC does not yet use."
      right={(
        <div className="flex gap-2">
          <button className={btnGhost} disabled={busy} onClick={() => exportJson(false)}><Download size={12} className="inline mr-1" />{busy ? 'Exporting...' : 'Export JSON'}</button>
          <button className={btnGhost} disabled={busy} onClick={() => exportJson(true)} title="Includes interface/check history; can be large">With history</button>
        </div>
      )}>
      {d == null ? <LoadingPanel label="Reading collected data..." height={160} /> : (
        <>
          {cov && (
            <p className="text-[12px] text-ink-muted mb-3">
              Interfaces {fmtNum(cov.interfaces)}, with description {fmtNum(cov.withDescription)}, with ifAlias {fmtNum(cov.withAlias)},
              {' '}with a circuit ID {fmtNum(cov.withCircuitId)} (WAN {fmtNum(cov.wanWithCircuitId)} of {fmtNum(cov.wan)}).
              {' '}Devices with no DataSource inventory: {fmtNum(d.devicesWithoutDatasourceInventory)}.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {[['datasources', 'DataSources'], ['vendors', 'Vendors / roles'], ['deviceProps', 'Device properties'], ['ifProps', 'Interface properties']].map(([k, l]) => (
              <button key={k} className={chipBtn(tab === k)} onClick={() => setTab(k)}>{l}</button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter..." className={`${inp} max-w-[240px] ml-auto`} spellCheck={false} />
          </div>
          <Table cols={cols} rows={rows} />
          <RawCollectionGroup raw={d.raw} />
        </>
      )}
    </SectionPanel>
  );
}
