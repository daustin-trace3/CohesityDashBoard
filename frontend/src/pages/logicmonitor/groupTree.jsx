// Group tree for the LogicMonitor Groups and Service pages (round 14).
// Nodes come from GET /logicmonitor/groups: { id "<src>:<gid>", sourceId, groupId, parentId (group id or null),
// name, fullPath, dynamic, directDevices, counts {crit,warn,ok,total}, state, reasons }.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Badge } from '../../components/ui/primitives';
import { useTableControls, SortTh, TableSearch, TablePager, CsvExportButton } from '../../components/ui/tableTools';
import { TONE_COLOR, fmtNum } from './helpers';
import { headRow } from './ui';

const STATE_TONE = { ok: 'ok', degraded: 'warn', failed: 'crit', unknown: 'neutral' };
const STATE_WORD = { ok: 'Operational', degraded: 'Degraded', failed: 'Failed', unknown: 'No devices' };
const STATE_RANK = { failed: 3, degraded: 2, ok: 1, unknown: 0 };

export const stateWord = (s) => STATE_WORD[s] || STATE_WORD.unknown;
export const stateRankOf = (s) => STATE_RANK[s] ?? 0;
export const stateColor = (s) => TONE_COLOR[STATE_TONE[s] || 'neutral'];
export const stateBadgeTone = (s) => STATE_TONE[s] || 'neutral';

export function StateDot({ state, size = 10 }) {
  return (
    <span
      className="inline-block rounded-full flex-shrink-0"
      style={{ width: size, height: size, background: stateColor(state) }}
      title={stateWord(state)}
      aria-label={stateWord(state)}
    />
  );
}

const sortNodes = (list, worstFirst) => [...list].sort((a, b) => {
  if (worstFirst) {
    const d = stateRankOf(b.state) - stateRankOf(a.state);
    if (d) return d;
  }
  return String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
});

const parentKey = (n) => (n.parentId == null ? null : `${n.sourceId}:${n.parentId}`);
// LogicMonitor's own numOfHosts can exceed what ICC holds (website check targets, scoped-out devices).
const rowTitle = (n) => {
  const total = n.counts?.total || 0;
  if (n.lmHosts != null && n.lmHosts !== total) return `${n.fullPath} (LogicMonitor counts ${n.lmHosts} hosts, ICC holds ${total} devices)`;
  return n.fullPath;
};

function Counts({ counts }) {
  const c = counts || {};
  return (
    <span className="ml-auto flex items-center gap-2 tnum text-[11px] flex-shrink-0">
      {c.crit ? <span style={{ color: TONE_COLOR.crit }}>{fmtNum(c.crit)}</span> : null}
      {c.warn ? <span style={{ color: TONE_COLOR.warn }}>{fmtNum(c.warn)}</span> : null}
      {c.ok ? <span style={{ color: TONE_COLOR.ok }}>{fmtNum(c.ok)}</span> : null}
    </span>
  );
}

export function GroupTree({ nodes, selectedId, onSelect, loadDevices, worstFirst = false, query = '', rootId = null, onOpenDevice }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [devs, setDevs] = useState({}); // nodeId -> { loading, rows, error }
  const [devOpen, setDevOpen] = useState(() => new Set()); // nodeIds whose devices are shown
  const [focusKey, setFocusKey] = useState(null);
  const refs = useRef(new Map());

  const { byId, children, roots } = useMemo(() => {
    const list = Array.isArray(nodes) ? nodes : [];
    const map = new Map(list.map((n) => [n.id, n]));
    const kids = new Map();
    const top = [];
    for (const n of list) {
      const pk = parentKey(n);
      if (pk && map.has(pk)) {
        if (!kids.has(pk)) kids.set(pk, []);
        kids.get(pk).push(n);
      } else top.push(n);
    }
    const rootList = rootId != null && map.has(rootId) ? [map.get(rootId)] : top;
    return { byId: map, children: kids, roots: rootList };
  }, [nodes, rootId]);

  const term = query.trim().toLowerCase();
  const { matchSet, ancestorSet } = useMemo(() => {
    const m = new Set();
    const a = new Set();
    if (!term) return { matchSet: m, ancestorSet: a };
    for (const n of byId.values()) {
      if (String(n.fullPath || n.name).toLowerCase().includes(term)) {
        m.add(n.id);
        let pk = parentKey(n);
        while (pk && byId.has(pk) && !a.has(pk)) { a.add(pk); pk = parentKey(byId.get(pk)); }
      }
    }
    return { matchSet: m, ancestorSet: a };
  }, [byId, term]);

  const isOpen = useCallback((id) => expanded.has(id) || ancestorSet.has(id), [expanded, ancestorSet]);

  // Flatten the visible rows.
  const flat = useMemo(() => {
    const out = [];
    const walk = (n, depth) => {
      if (term && !matchSet.has(n.id) && !ancestorSet.has(n.id)) return;
      const kids = sortNodes(children.get(n.id) || [], worstFirst);
      const hasKids = kids.length > 0;
      const canDevices = (n.directDevices || 0) > 0 || (!hasKids && (n.counts?.total || 0) > 0);
      out.push({ kind: 'group', key: n.id, node: n, depth, expandable: hasKids || canDevices, hasKids, canDevices });
      if (!isOpen(n.id)) return;
      for (const k of kids) walk(k, depth + 1);
      if (canDevices) {
        if (hasKids) out.push({ kind: 'devhead', key: `${n.id}#d`, node: n, depth: depth + 1 });
        if (!hasKids || devOpen.has(n.id)) {
          const st = devs[n.id];
          if (st?.loading) out.push({ kind: 'note', key: `${n.id}#l`, depth: depth + 1, text: 'Loading devices...' });
          else if (st?.error) out.push({ kind: 'note', key: `${n.id}#e`, depth: depth + 1, text: 'Failed to load devices.' });
          else for (const d of st?.rows || []) out.push({ kind: 'device', key: `${n.id}#${d.sourceId ?? ''}-${d.id}`, device: d, depth: depth + 1 });
        }
      }
    };
    const rs = rootId != null ? roots : sortNodes(roots, worstFirst);
    for (const r of rs) walk(r, 0);
    return out;
  }, [roots, children, term, matchSet, ancestorSet, worstFirst, isOpen, devs, devOpen, rootId]);

  // Load devices for a leaf (or a devices pseudo row) the first time it is shown.
  const asked = useRef(new Set());
  const ensureDevices = useCallback((node) => {
    if (!loadDevices || asked.current.has(node.id)) return;
    asked.current.add(node.id);
    setDevs((c) => ({ ...c, [node.id]: { loading: true } }));
    Promise.resolve(loadDevices(node))
      .then((rows) => setDevs((c) => ({ ...c, [node.id]: { rows: Array.isArray(rows) ? rows : [] } })))
      .catch(() => setDevs((c) => ({ ...c, [node.id]: { error: true } })));
  }, [loadDevices]);

  // The cached device lists go stale when the node list refreshes.
  useEffect(() => { asked.current = new Set(); setDevs({}); }, [nodes]);

  useEffect(() => {
    for (const row of flat) {
      if (row.kind === 'group' && isOpen(row.key) && row.canDevices && !row.hasKids) ensureDevices(row.node);
    }
  }, [flat, isOpen, ensureDevices]);

  const toggle = (row) => {
    const id = row.node.id;
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleDevices = (node) => {
    setDevOpen((cur) => {
      const next = new Set(cur);
      if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
      return next;
    });
    ensureDevices(node);
  };

  const keys = flat.map((r) => r.key);
  const activeKey = keys.includes(focusKey) ? focusKey : keys[0];
  const focusRow = (key) => {
    setFocusKey(key);
    const el = refs.current.get(key);
    if (el) el.focus();
  };

  const onKeyDown = (e, row, i) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (i + 1 < flat.length) focusRow(flat[i + 1].key); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) focusRow(flat[i - 1].key); }
    else if (e.key === 'ArrowRight' && row.kind === 'group' && row.expandable) {
      e.preventDefault();
      if (!isOpen(row.node.id)) toggle(row);
    } else if (e.key === 'ArrowLeft' && row.kind === 'group') {
      e.preventDefault();
      if (expanded.has(row.node.id)) toggle(row);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row.kind === 'group') onSelect?.(row.node);
      else if (row.kind === 'device') onOpenDevice?.(row.device);
      else if (row.kind === 'devhead') toggleDevices(row.node);
    }
  };

  if (!flat.length) return <p className="text-sm text-ink-muted py-4 text-center">{term ? 'No groups match.' : 'No groups to show.'}</p>;

  const pad = (depth) => ({ paddingLeft: 6 + depth * 20 });
  const rowCls = 'flex items-center gap-2 py-1 pr-2 rounded cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-brand/60';
  return (
    <div role="tree" aria-label="LogicMonitor groups" className="text-[13px]">
      {flat.map((row, i) => {
        const common = {
          ref: (el) => { if (el) refs.current.set(row.key, el); else refs.current.delete(row.key); },
          tabIndex: row.key === activeKey ? 0 : -1,
          onFocus: () => setFocusKey(row.key),
          onKeyDown: (e) => onKeyDown(e, row, i),
        };
        if (row.kind === 'note') {
          return <div key={row.key} className="py-1 text-[11px] text-ink-faint" style={pad(row.depth)}>{row.text}</div>;
        }
        if (row.kind === 'device') {
          const d = row.device;
          const first = Array.isArray(d.reasons) && d.reasons.length ? d.reasons[0] : '';
          return (
            <div key={row.key} role="treeitem" aria-selected="false" {...common}
              onClick={() => onOpenDevice?.(d)}
              className={`${rowCls} hover:bg-surface-overlay`}
              style={pad(row.depth)}>
              <span className="w-[14px] flex-shrink-0" />
              <StateDot state={d.state} size={8} />
              <span className="truncate text-ink-muted">{d.displayName || d.name}</span>
              {first ? <span className="truncate text-[11px] text-ink-faint ml-auto">{first}</span> : null}
            </div>
          );
        }
        if (row.kind === 'devhead') {
          const open = devOpen.has(row.node.id);
          return (
            <div key={row.key} role="treeitem" aria-selected="false" aria-expanded={open} {...common}
              onClick={() => toggleDevices(row.node)}
              className={`${rowCls} hover:bg-surface-overlay text-ink-faint`}
              style={pad(row.depth)}>
              {open ? <ChevronDown size={14} className="flex-shrink-0" /> : <ChevronRight size={14} className="flex-shrink-0" />}
              <span className="text-[12px]">{fmtNum(row.node.directDevices)} direct device(s)</span>
            </div>
          );
        }
        const n = row.node;
        const open = isOpen(n.id);
        const selected = selectedId === n.id;
        return (
          <div key={row.key} role="treeitem" aria-selected={selected} aria-expanded={row.expandable ? open : undefined} {...common}
            onClick={() => onSelect?.(n)}
            className={`${rowCls} ${selected ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/60'}`}
            style={pad(row.depth)}>
            {row.expandable ? (
              <button type="button" tabIndex={-1} aria-label={open ? 'Collapse' : 'Expand'}
                onClick={(e) => { e.stopPropagation(); toggle(row); }}
                className="flex-shrink-0 text-ink-faint hover:text-ink cursor-pointer">
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : <span className="w-[14px] flex-shrink-0" />}
            <StateDot state={n.state} />
            <span className={`truncate ${selected ? 'text-ink font-semibold' : 'text-ink'}`} title={rowTitle(n)}>{n.name}</span>
            {n.dynamic ? <span className="text-[10px] px-1.5 rounded border border-cohesity-border text-ink-faint flex-shrink-0">dynamic</span> : null}
            <Counts counts={n.counts} />
          </div>
        );
      })}
    </div>
  );
}


export function StateBadge({ state }) {
  return <Badge tone={stateBadgeTone(state)}>{stateWord(state)}</Badge>;
}

// Device table shared by the Groups and Service pages. lastCol is 'subGroup' or 'site'.
export function GroupDevicesTable({ rows, onOpen, lastCol = 'subGroup', csvName = 'devices', showCsv = false, placeholder = 'Search devices...' }) {
  const list = useMemo(() => (rows || []).map((d) => ({
    ...d,
    _name: d.displayName || d.name || '',
    _rank: stateRankOf(d.state),
    _why: Array.isArray(d.reasons) ? d.reasons.join('; ') : '',
    _site: d.siteName || d.siteKey || '',
    _sub: d.subGroup || '',
  })), [rows]);
  const ctl = useTableControls(list, {
    searchKeys: ['_name', 'name', '_why', '_site', '_sub'], defaultSortKey: '_rank', defaultSortDir: 'desc',
    paginate: true, defaultPageSize: 10, deepLink: false,
  });
  const lastKey = lastCol === 'site' ? '_site' : '_sub';
  const lastLabel = lastCol === 'site' ? 'Site' : 'Sub-group';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <TableSearch ctl={ctl} placeholder={placeholder} />
        <span className="text-[11px] text-ink-faint tnum ml-auto">{fmtNum(ctl.rows.length)} device(s)</span>
        {showCsv ? (
          <CsvExportButton filename={csvName} rows={ctl.rows} columns={[
            { label: 'Device', get: (r) => r._name }, { label: 'State', get: (r) => stateWord(r.state) },
            { label: 'Why', get: (r) => r._why }, { label: lastLabel, get: (r) => r[lastKey] },
          ]} />
        ) : null}
      </div>
      {list.length === 0 ? <p className="text-sm text-ink-muted py-4 text-center">No devices in this group.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className={headRow}>
              <SortTh k="_name" label="Device" ctl={ctl} />
              <SortTh k="_rank" label="State" ctl={ctl} />
              <SortTh k="_why" label="Why" ctl={ctl} />
              <SortTh k={lastKey} label={lastLabel} ctl={ctl} />
            </tr></thead>
            <tbody>
              {ctl.pageRows.map((d) => (
                <tr key={`${d.sourceId}-${d.id}`} className="border-b border-cohesity-border/50 cursor-pointer hover:bg-surface-overlay" onClick={() => onOpen?.(d)}>
                  <td className="py-2 pr-3 text-ink">{d._name}</td>
                  <td className="py-2 pr-3"><span className="inline-flex items-center gap-2 text-[12px] text-ink-muted"><StateDot state={d.state} size={8} />{stateWord(d.state)}</span></td>
                  <td className="py-2 pr-3 text-[12px] text-ink-muted">{d._why || '-'}</td>
                  <td className="py-2 pr-3 text-[12px] text-ink-muted">{d[lastKey] || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TablePager ctl={ctl} sizes={[10, 25, 50, 'all']} />
    </>
  );
}

export default GroupTree;
