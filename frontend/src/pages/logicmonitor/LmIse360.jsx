import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint } from 'lucide-react';
import client from '../../api/client';
import { Badge, LoadingPanel } from '../../components/ui/primitives';
import {
  DASH, arr, fmtNum, fmtPct, fmtWhen, stateTone, stateLabel, hostStatusTone, hostStatusLabel,
} from './helpers';
import { Modal, SectionPanel, Fact } from './ui';
import { TrendLine, AutoTable, IssuesList, pointsOf } from './LmFirewall360';
import { RawDatapointsSection, RawState } from './servicesShared';

export default function LmIse360({ deviceId, sourceId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    client.get(`/logicmonitor/ise/${deviceId}`, { params: sourceId ? { sourceId } : {} })
      .then(({ data: d }) => setData(d || {}))
      .catch((e) => setError(e?.response?.status === 404 ? 'ISE node not found. It may have been removed.' : 'Failed to load the ISE node.'));
  }, [deviceId, sourceId]);

  const s = data?.summary || {};
  const d = data?.device || {};

  return (
    <Modal icon={Fingerprint} title={s.deviceName || d.displayName || `ISE node ${deviceId}`} subtitle={[s.vendor, s.model, s.version].filter(Boolean).join(' - ')} onClose={onClose} width="max-w-6xl">
      {error ? <p className="text-sm text-status-crit py-6 text-center">{error}</p> : data == null ? <LoadingPanel label="Loading ISE node..." height={200} /> : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={stateTone(s.state)}>{stateLabel(s.state)}</Badge>
            <Badge tone={hostStatusTone(s.hostStatus)}>{hostStatusLabel(s.hostStatus)}</Badge>
            <button onClick={() => navigate(`/logicmonitor/issues?q=${encodeURIComponent(s.deviceName || '')}`)} className="text-[11px] text-brand hover:underline cursor-pointer ml-auto">Open issues page</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <Fact label="Site">{s.siteName || s.siteKey}</Fact>
            <Fact label="Active sessions">{fmtNum(s.sessions)}</Fact>
            <Fact label="CPU">{fmtPct(s.cpuPct)}</Fact>
            <Fact label="Memory">{fmtPct(s.memPct)}</Fact>
            <Fact label="Fullest disk">{fmtPct(s.diskUsedMaxPct)}</Fact>
            <Fact label="Application"><RawState raw={s.appStateRaw} ok={s.appStateRaw == null ? null : !s.appDown} label={s.appDown ? 'Down' : 'Running'} badTone="crit" /></Fact>
            <Fact label="Certificate days left">{s.certDaysMin == null ? DASH : fmtNum(s.certDaysMin)}</Fact>
            <Fact label="Deployment nodes">{s.nodes ? `${fmtNum(s.nodes)} (${fmtNum(s.nodesDown)} down)` : DASH}</Fact>
            <Fact label="Sampled">{s.sampledAt ? fmtWhen(s.sampledAt) : DASH}</Fact>
          </div>

          <SectionPanel title="Open issues"><IssuesList issues={data.issues} /></SectionPanel>

          <div className="grid lg:grid-cols-3 gap-4">
            <SectionPanel title="Sessions, 24 hours"><TrendLine series={[{ label: 'Sessions', points: pointsOf(data.history, ['sessions']) }]} /></SectionPanel>
            <SectionPanel title="CPU, 24 hours"><TrendLine pct series={[{ label: 'CPU %', points: pointsOf(data.history, ['cpuPct']), color: '#3FB950' }]} /></SectionPanel>
            <SectionPanel title="Memory, 24 hours"><TrendLine pct series={[{ label: 'Memory %', points: pointsOf(data.history, ['memPct']), color: '#D4A24E' }]} /></SectionPanel>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <SectionPanel title="Certificates" blurb="Shortest first. Under 30 days raises a warning, under 7 critical.">
              <AutoTable rows={arr(data.certificates)} empty="No certificate rows collected." pageSize={6} preferred={['name', 'kind', 'daysLeft']} />
            </SectionPanel>
            <SectionPanel title="Disks"><AutoTable rows={arr(data.disks)} empty="No disks collected." pageSize={6} /></SectionPanel>
          </div>

          <SectionPanel title="Application and deployment" blurb="Raw state values; polarity is read from the estate majority because the enum is unverified.">
            <AutoTable rows={arr(data.nodes)} empty="No application or deployment rows collected." pageSize={6} />
          </SectionPanel>

          <RawDatapointsSection deviceId={deviceId} sourceId={sourceId || s.sourceId} />
        </div>
      )}
    </Modal>
  );
}
