import { ACCENT, PANEL_BG, BORDER, TEXT, MUTED, panelStyle, thStyle, tdStyle, StatusPill, useFetch, PageShell, formatWhen } from './_shared';

const EVENT_TYPES = ['All', 'Backup', 'Replication', 'Archival', 'Security', 'System', 'Maintenance'];
const SEVERITIES = ['All', 'Critical', 'Warning', 'Info'];

export default function EventsPage() {
  const [severity, setSeverity] = React.useState('All');
  const [type, setType] = React.useState('All');
  const { data, error } = useFetch(`/events?days=7${severity !== 'All' ? `&severity=${severity}` : ''}`);
  const rows = (data || []).filter((e) => type === 'All' || e.eventType === type);

  return (
    <PageShell title="Rubrik Events" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {SEVERITIES.map((s) => (
            <button
              key={s}
              onClick={() => setSeverity(s)}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${severity === s ? ACCENT : BORDER}`,
                background: severity === s ? `${ACCENT}26` : PANEL_BG,
                color: severity === s ? ACCENT : TEXT,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <div style={panelStyle({ padding: 0, overflow: 'hidden' })}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Cluster</th>
                <th style={thStyle}>Object</th>
                <th style={thStyle}>Message</th>
                <th style={thStyle}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td style={tdStyle}>
                    <StatusPill status={e.severity} />
                  </td>
                  <td style={tdStyle}>{e.eventType}</td>
                  <td style={tdStyle}>{e.cluster || '—'}</td>
                  <td style={tdStyle}>{e.objectName || '—'}</td>
                  <td style={{ ...tdStyle, color: MUTED }}>{e.message}</td>
                  <td style={tdStyle}>{formatWhen(e.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}
