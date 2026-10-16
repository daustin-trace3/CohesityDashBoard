import { useEffect, useState } from 'react';
import { Wifi } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import { DASH, arr, fmtNum, fmtPct, fmtMbps, fmtWhen } from './helpers';
import { Modal, SectionPanel, Fact, UtilBar, headRow } from './ui';
import { IssuesList, num } from './LmFirewall360';
import { ApStatusBadge, RadioStateBadge, ProfileBadge } from './wirelessShared';

const mbps = (bps) => (num(bps) == null ? DASH : fmtMbps(num(bps) / 1e6));

export default function LmAp360({ controllerId, sourceId, apKey, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get('/logicmonitor/wireless/ap', { params: { controllerId, ap: apKey, ...(sourceId ? { sourceId } : {}) } })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'Access point not found on this controller.' : 'Failed to load the access point.'));
  }, [controllerId, sourceId, apKey]);

  const ap = data?.ap || {};
  return (
    <Modal icon={Wifi} title={apKey} subtitle={[ap.controller, ap.siteName].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-5xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading access point..." height={160} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <ApStatusBadge status={ap.status} />
            {ap.adminText && <Badge tone={ap.adminText === 'enabled' ? 'neutral' : 'warn'}>Admin {ap.adminText}</Badge>}
            {ap.uplinkState && <Badge tone={ap.uplinkState === 'up' ? 'ok' : 'crit'}>Uplink {ap.uplinkState}</Badge>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="Controller">{ap.controller}</Fact>
            <Fact label="Clients">{fmtNum(ap.clients)}</Fact>
            <Fact label="Radios up">{`${fmtNum(ap.radiosUp)} / ${fmtNum(ap.radiosTotal)}`}</Fact>
            <Fact label="Busiest radio">{fmtPct(ap.maxChannelUtilPct)}</Fact>
            <Fact label="Uplink rx / tx">{`${mbps(ap.uplinkRxBps)} / ${mbps(ap.uplinkTxBps)}`}</Fact>
            <Fact label={ap.status === 'missing' ? 'Left controller' : 'Sampled'}>{fmtWhen(ap.since || ap.sampledAt)}</Fact>
          </div>

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          <SectionPanel title="Radios" blurb="Slot 0 is 2.4 GHz and slot 1 is 5 GHz; slot 2 is a second 5 GHz or a 6 GHz radio depending on the AP model. RRM profiles are the controller's pass or fail verdicts.">
            {arr(data.radios).length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No radios collected for this AP.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}>
                    <th className="py-2 pr-3">Radio</th><th className="py-2 pr-3">Band</th><th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3">Channel util</th><th className="py-2 pr-3 text-right">Rx / Tx util</th><th className="py-2 pr-3 text-right">Clients</th>
                    <th className="py-2 pr-3 text-right">Tx power</th><th className="py-2 pr-3">Load</th><th className="py-2 pr-3">Noise</th>
                    <th className="py-2 pr-3">Interference</th><th className="py-2 pr-3">Coverage</th>
                  </tr></thead>
                  <tbody>
                    {data.radios.map((r) => (
                      <tr key={r.radio} className="border-b border-cohesity-border/40 text-[12px]">
                        <td className="py-1.5 pr-3 text-ink">{r.radio}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{r.band}</td>
                        <td className="py-1.5 pr-3"><RadioStateBadge state={r.state} /></td>
                        <td className="py-1.5 pr-3 min-w-[120px]"><UtilBar pct={r.channelUtilPct} /></td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{`${fmtPct(r.rxUtilPct)} / ${fmtPct(r.txUtilPct)}`}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(r.clients)}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{fmtNum(r.txPowerLevel)}</td>
                        <td className="py-1.5 pr-3"><ProfileBadge v={r.loadProfile} /></td>
                        <td className="py-1.5 pr-3"><ProfileBadge v={r.noiseProfile} /></td>
                        <td className="py-1.5 pr-3"><ProfileBadge v={r.interferenceProfile} /></td>
                        <td className="py-1.5 pr-3"><ProfileBadge v={r.coverageProfile} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionPanel>

          <SectionPanel title="Ethernet ports" blurb="Rates are per second as LogicMonitor reports them. Single-uplink APs show their unused second port as down.">
            {arr(data.ports).length === 0 ? <p className="text-[12px] text-ink-muted py-3 text-center">No ethernet ports collected for this AP.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className={headRow}>
                    <th className="py-2 pr-3">Port</th><th className="py-2 pr-3">State</th><th className="py-2 pr-3 text-right">Rx</th><th className="py-2 pr-3 text-right">Tx</th>
                    <th className="py-2 pr-3 text-right">In / out errors</th><th className="py-2 pr-3 text-right">In / out drops</th>
                  </tr></thead>
                  <tbody>
                    {data.ports.map((p) => (
                      <tr key={p.port} className="border-b border-cohesity-border/40 text-[12px]">
                        <td className="py-1.5 pr-3 text-ink">{p.port}</td>
                        <td className="py-1.5 pr-3"><Badge tone={p.state === 'up' ? 'ok' : p.state === 'down' ? 'neutral' : 'neutral'}>{p.state || 'unknown'}</Badge></td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{mbps(p.rxBps)}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{mbps(p.txBps)}</td>
                        <td className={`py-1.5 pr-3 text-right tnum ${(num(p.inErrors) || 0) + (num(p.outErrors) || 0) > 1 ? 'text-status-warn' : 'text-ink-muted'}`}>{`${fmtNum(p.inErrors)} / ${fmtNum(p.outErrors)}`}</td>
                        <td className="py-1.5 pr-3 text-right tnum text-ink-muted">{`${fmtNum(p.inDrops)} / ${fmtNum(p.outDrops)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionPanel>
        </div>
      )}
    </Modal>
  );
}
