import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ShieldAlert, CableCar, CalendarClock, BellOff, Eye, Clock3 } from 'lucide-react';
import client from '../../api/client';
import { useToast } from '../../components/ui/Toaster';
import { PageHeader, LoadingPanel, RefreshButton, LastUpdated } from '../../components/ui/primitives';
import { BRAND } from './helpers';
import { ListSection, deviceColumns } from './governanceSections';

const DEFAULT_SECTION = 'noInterfaceDatasource';
const deviceSearch = ['displayName', 'vendor', 'role'];

export default function LmCoveragePage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(() => client.get('/logicmonitor/governance')
    .then(({ data: d }) => { setData(d || {}); setLastRefreshed(new Date()); })
    .catch(() => { setData((cur) => cur || {}); toast({ type: 'error', title: 'Failed to load coverage data' }); }), [toast]);

  useEffect(() => { load(); }, [load]);

  const cov = (data && data.coverage) || {};
  const list = (k) => (Array.isArray(cov[k]) ? cov[k] : []);
  const openDevice = (r) => r.id && navigate(`/logicmonitor/devices?device=${r.id}`);

  const items = [
    { id: 'noInterfaceDatasource', label: 'No Interface DataSource', icon: CableCar, tone: 'warn' },
    { id: 'inSdt', label: 'In SDT', icon: CalendarClock, tone: 'default' },
    { id: 'alertingDisabled', label: 'Alerting Disabled', icon: BellOff, tone: 'warn' },
    { id: 'notPolled24h', label: 'No Data 24h', icon: Clock3, tone: 'warn' },
  ];
  const raw = searchParams.get('section') || DEFAULT_SECTION;
  const section = items.some((i) => i.id === raw) ? raw : DEFAULT_SECTION;
  const selectSection = (id) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="animate-fade-in">
      <PageHeader icon={ShieldAlert} title="Coverage" description="Network devices LogicMonitor is not fully watching: no interface DataSource, in scheduled downtime, alerting disabled, or no interface data in 24 hours.">
        <LastUpdated date={lastRefreshed} prefix="Updated" />
        <RefreshButton onClick={load} />
      </PageHeader>

      {data == null ? <LoadingPanel label="Loading coverage data..." height={200} /> : (
        <div className="flex gap-4 items-start">
          <div className="panel p-2 w-56 shrink-0" style={{ borderTop: `3px solid ${BRAND}` }}>
            {items.map((n) => {
              const count = list(n.id).length;
              const cls = n.tone === 'warn' ? 'bg-status-warn/15 text-status-warn' : 'bg-surface-overlay text-ink-faint';
              return (
                <button key={n.id} type="button" onClick={() => selectSection(n.id)}
                  className={`flex items-center gap-2 w-full text-left text-xs rounded-lg px-2.5 py-2 transition-colors cursor-pointer ${section === n.id ? 'bg-surface-overlay text-ink font-semibold' : 'text-ink-muted hover:text-ink hover:bg-surface-overlay/60'}`}>
                  <n.icon size={14} className={section === n.id ? 'text-brand' : 'text-ink-faint'} />
                  <span className="truncate">{n.label}</span>
                  {count ? <span className={`ml-auto tnum text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${cls}`}>{count}</span> : null}
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-w-0">
            {section === 'noInterfaceDatasource' && (
              <ListSection key={section} section={section} icon={CableCar} title="Network Devices Without an Interface DataSource" rows={list('noInterfaceDatasource')} onRow={openDevice}
                blurb="Network devices where none of SNMP_Network_Interfaces, snmp64_If- or snmpIf- applies, so ICC has no interface data for them. Usually an SNMP credential or applies-to problem."
                columns={deviceColumns} searchKeys={deviceSearch} defaultSortKey="displayName" emptyText="Every network device has interface data." />
            )}
            {section === 'inSdt' && (
              <ListSection key={section} section={section} icon={CalendarClock} title="Devices in Scheduled Downtime" rows={list('inSdt')} onRow={openDevice}
                blurb="Devices with any SDT slot active. Long-running SDT hides real outages; check the SDT tab on the device for the window."
                columns={deviceColumns} searchKeys={deviceSearch} defaultSortKey="displayName" emptyText="No devices in SDT." />
            )}
            {section === 'alertingDisabled' && (
              <ListSection key={section} section={section} icon={BellOff} title="Alerting Disabled" rows={list('alertingDisabled')} onRow={openDevice}
                blurb="Devices with alerting turned off in LogicMonitor. They are monitored but nobody hears about them."
                columns={deviceColumns} searchKeys={deviceSearch} defaultSortKey="displayName" emptyText="No devices with alerting disabled." />
            )}
            {section === 'notPolled24h' && (
              <ListSection key={section} section={section} icon={Eye} title="No Interface Data in 24 Hours" rows={list('notPolled24h')} onRow={openDevice}
                blurb="Network devices ICC has not received an interface sample for in the last 24 hours."
                columns={deviceColumns} searchKeys={deviceSearch} defaultSortKey="displayName" emptyText="Every network device reported in the last 24 hours." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
