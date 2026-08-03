// v1.2.1 "Compliance" page — kept at /rubrik/compliance for now per the
// v2.0.0 contract (file named backuphistory.jsx; content unchanged). A
// future page WP replaces this with the richer v2 Backup History page.
import { PANEL_BG, BORDER, TEXT, MUTED, DAY_COLORS, panelStyle, MiniBubbleGrid, useFetch, PageShell } from './_shared';

export default function CompliancePage() {
  const { data, error } = useFetch('/compliance');
  const [filter, setFilter] = React.useState('All');
  const names = ['All', ...(data || []).map((o) => o.name)];
  const rows = (data || []).filter((o) => filter === 'All' || o.name === filter);

  return (
    <PageShell title="Rubrik Compliance — 14 Day History" error={error}>
      <div style={{ marginBottom: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 6, padding: '6px 10px', fontSize: 12 }}
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: MUTED }}>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.ok, borderRadius: 2, marginRight: 4 }} />
            OK
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.missed, borderRadius: 2, marginRight: 4 }} />
            Missed
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 10, height: 10, background: DAY_COLORS.none, borderRadius: 2, marginRight: 4 }} />
            No snapshot expected
          </span>
        </div>
      </div>
      {data && (
        <div style={panelStyle({ overflowX: 'auto' })}>
          <MiniBubbleGrid rows={rows} />
        </div>
      )}
    </PageShell>
  );
}
