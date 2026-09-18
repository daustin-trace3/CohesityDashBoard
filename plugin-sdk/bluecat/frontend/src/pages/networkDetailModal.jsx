// Network detail modal - ported from the built-in NetworkDetailModal.jsx.
// Uses the plugin's portalOrInline guard instead of react-dom's
// createPortal directly (window.ReactDOM on some hosts has no createPortal).
import { Network, ListTree, Save, Trash2 } from '../icons.jsx';
import client from '../api.js';
import {
  useToast, Badge, LoadingPanel, ErrorPanel, Modal,
  BRAND, fmtNum, fmtPct, fmtWhen, gatewaySourceLabel, gatewaySourceTone, freeStaticTone,
} from '../ui.jsx';

const inp = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-sm text-ink focus:border-brand/60 outline-none';
const btnPrimary = 'px-4 py-2 rounded-lg text-sm font-semibold bg-brand text-cohesity-black hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer';
const btnGhost = 'px-4 py-2 rounded-lg text-sm font-semibold border border-cohesity-border text-ink-muted hover:text-ink transition-colors cursor-pointer disabled:opacity-50';

const Fact = ({ label, value }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    <p className="text-sm text-ink tnum">{value ?? '-'}</p>
  </div>
);

function UsageBar({ used, free, capacity }) {
  if (capacity == null || !capacity) return <p className="text-xs text-ink-faint">not enumerated</p>;
  const usedPct = Math.max(0, Math.min(100, ((used || 0) / capacity) * 100));
  return (
    <div>
      <div className="h-2 rounded-full bg-surface-overlay overflow-hidden">
        <div className="h-full bg-brand" style={{ width: `${usedPct}%` }} />
      </div>
      <p className="text-[11px] text-ink-faint mt-1">{fmtNum(used)} used / {fmtNum(free)} free / {fmtNum(capacity)} capacity</p>
    </div>
  );
}

function RangesTable({ ranges }) {
  if (!ranges.length) return <p className="text-xs text-ink-muted py-1">No DHCP ranges.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-1.5 pr-3">Name</th>
          <th className="py-1.5 pr-3">Start</th>
          <th className="py-1.5 pr-3">End</th>
          <th className="py-1.5 pr-3 text-right">Size</th>
          <th className="py-1.5 pr-3 text-right">Used</th>
          <th className="py-1.5 pr-3 text-right">Free</th>
        </tr></thead>
        <tbody>
          {ranges.map((r) => (
            <tr key={r.id} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 text-ink-muted">{r.name || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-faint tnum">{r.startIp || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-faint tnum">{r.endIp || '-'}</td>
              <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(r.size)}</td>
              <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(r.dhcpUsed)}</td>
              <td className="py-1.5 pr-3 text-right tnum"><Badge tone={freeStaticTone(r.freeDhcp)}>{fmtNum(r.freeDhcp)}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddressesTable({ addresses }) {
  if (!addresses.length) return <p className="text-xs text-ink-muted py-1">No addresses recorded - network may not be enumerated yet.</p>;
  return (
    <div className="overflow-x-auto max-h-64 overflow-y-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border sticky top-0 bg-surface">
          <th className="py-1.5 pr-3">Address</th>
          <th className="py-1.5 pr-3">State</th>
          <th className="py-1.5 pr-3">Name</th>
          <th className="py-1.5 pr-3">MAC</th>
        </tr></thead>
        <tbody>
          {addresses.map((a) => (
            <tr key={a.id} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 tnum text-ink">{a.address}</td>
              <td className="py-1.5 pr-3 text-ink-faint">{a.state || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-muted">{a.name || '-'}</td>
              <td className="py-1.5 pr-3 text-ink-faint tnum">{a.mac || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordsTable({ records }) {
  if (!records.length) return <p className="text-xs text-ink-muted py-1">No DNS records tied to this network.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-[10px] uppercase tracking-wide text-ink-faint border-b border-cohesity-border">
          <th className="py-1.5 pr-3">Name</th>
          <th className="py-1.5 pr-3">Type</th>
          <th className="py-1.5 pr-3">Data</th>
        </tr></thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} className="border-b border-cohesity-border/40">
              <td className="py-1.5 pr-3 text-ink">{r.absoluteName || r.name}</td>
              <td className="py-1.5 pr-3 text-ink-faint">{r.rrType}</td>
              <td className="py-1.5 pr-3 text-ink-muted tnum">{r.rdata || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function NetworkDetailModal({ networkId, onClose, onChanged }) {
  const { toast } = useToast();
  const [detail, setDetail] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  const [gateway, setGateway] = React.useState('');
  const [excludeLowSpace, setExcludeLowSpace] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const load = React.useCallback(() => {
    setFailed(false);
    return client.get(`/bluecat/networks/${networkId}`)
      .then(({ data }) => {
        setDetail(data);
        const n = data?.network;
        setGateway(n?.override?.gateway || '');
        setExcludeLowSpace(!!n?.override?.excludeLowSpace);
        setNote(n?.override?.note || '');
      })
      .catch(() => { setFailed(true); toast({ type: 'error', title: 'Failed to load network' }); });
  }, [networkId, toast]);

  React.useEffect(() => { load(); }, [load]);

  if (failed) {
    return (
      <Modal title="Network" icon={Network} onClose={onClose}>
        <ErrorPanel label="Could not load network detail." onRetry={load} height={160} />
      </Modal>
    );
  }
  if (!detail) {
    return (
      <Modal title="Loading..." icon={Network} onClose={onClose}>
        <LoadingPanel label="Loading network..." height={160} />
      </Modal>
    );
  }

  const { network, ranges = [], addresses = [], records = [] } = detail;

  const saveOverride = async () => {
    setSaving(true);
    try {
      await client.put(`/bluecat/networks/${networkId}/override`, {
        gateway: gateway.trim() || null,
        excludeLowSpace,
        note: note.trim() || null,
      });
      toast({ type: 'success', title: 'Override saved' });
      await load();
      onChanged?.();
    } catch (err) {
      toast({ type: 'error', title: 'Save failed', message: err?.response?.data?.error });
    } finally {
      setSaving(false);
    }
  };

  const clearOverride = async () => {
    setClearing(true);
    try {
      await client.delete(`/bluecat/networks/${networkId}/override`);
      toast({ type: 'success', title: 'Override cleared' });
      await load();
      onChanged?.();
    } catch (err) {
      toast({ type: 'error', title: 'Clear failed', message: err?.response?.data?.error });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal title={network.range} subtitle={[network.name, network.sourceName].filter(Boolean).join(' - ')} icon={Network} onClose={onClose} maxWidth="min(900px,92vw)">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Badge tone={gatewaySourceTone(network.gatewaySource)}>Gateway: {network.gateway || 'none'} ({gatewaySourceLabel(network.gatewaySource)})</Badge>
        {network.countsSource === 'usage' && <Badge tone="info">Counts from BAM usage</Badge>}
        {network.countsSource === 'enumerated' && <Badge tone="neutral">Counts from last enumeration</Badge>}
        {network.excludeLowSpace ? <Badge tone="neutral">Excluded from low-space alerts</Badge> : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Fact label="Prefix" value={network.prefix != null ? `/${network.prefix}` : null} />
        <Fact label="Location" value={network.locationName} />
        <Fact label="DHCP pool" value={fmtNum(network.dhcpPool)} />
        <Fact label="DHCP used" value={fmtNum(network.dhcpUsed)} />
        <Fact label="Free %" value={fmtPct(network.freePct)} />
        <Fact label="Enumerated" value={fmtWhen(network.enumeratedAt)} />
        <Fact label="Low water mark" value={network.lowWaterMark} />
        <Fact label="High water mark" value={network.highWaterMark} />
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2">Usage</p>
        <UsageBar used={network.usedStatic} free={network.freeStatic} capacity={network.capacity} />
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2 flex items-center gap-1.5"><ListTree size={13} className="text-brand" /> Ranges ({ranges.length})</p>
        <RangesTable ranges={ranges} />
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2">Addresses ({addresses.length})</p>
        <AddressesTable addresses={addresses} />
      </div>

      <div className="mb-4">
        <p className="text-xs font-semibold text-ink mb-2">DNS Records ({records.length})</p>
        <RecordsTable records={records} />
      </div>

      <div className="panel p-3 bg-surface-overlay">
        <p className="text-xs font-semibold text-ink mb-2">Override</p>
        <div className="grid md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-[11px] font-semibold text-ink mb-1">Gateway</label>
            <input value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder="e.g. 10.0.0.254" className={inp} spellCheck={false} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-[11px] font-semibold text-ink mb-1">Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={inp} spellCheck={false} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" checked={excludeLowSpace} onChange={(e) => setExcludeLowSpace(e.target.checked)} className="accent-brand cursor-pointer" />
            <span className="text-xs text-ink-muted">Exclude from low-space alerts</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={saveOverride} disabled={saving} className={`${btnPrimary} inline-flex items-center gap-1.5`}>
            <Save size={13} /> {saving ? 'Saving...' : 'Save'}
          </button>
          <button onClick={clearOverride} disabled={clearing || !network.override} className={`${btnGhost} inline-flex items-center gap-1.5`}>
            <Trash2 size={13} /> {clearing ? 'Clearing...' : 'Clear'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
