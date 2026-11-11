import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Wand2 } from 'lucide-react';
import { PermissionBuilder, PermissionChip, inputClass } from './PermissionParts';

const SEG = [
  { key: 'none', label: 'None' },
  { key: 'view', label: 'View' },
  { key: 'manage', label: 'Manage' },
];
const RANK = { none: 0, view: 1, manage: 2 };
const STORE_KEY = 'icc.grants.sections';

// Level of the explicit grant `ns:section:*|manage|view`. Level `*` reads as manage.
function levelOf(draft, ns, section) {
  if (draft.has(`${ns}:${section}:*`) || draft.has(`${ns}:${section}:manage`)) return 'manage';
  if (draft.has(`${ns}:${section}:view`)) return 'view';
  return 'none';
}
const maxLevel = (a, b) => (RANK[a] >= RANK[b] ? a : b);

function withLevel(draft, ns, section, level) {
  const next = new Set(draft);
  for (const l of ['view', 'manage', '*']) next.delete(`${ns}:${section}:${l}`);
  if (level !== 'none') next.add(`${ns}:${section}:${level}`);
  return next;
}

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeStore(obj) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

function Segmented({ label, value, inherited, mixed, onChange, disabledNone, noneTitle }) {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {mixed && <span className="text-[10px] text-ink-faint">Mixed</span>}
      <div role="group" aria-label={label} className="flex rounded-lg border border-cohesity-border overflow-hidden">
        {SEG.map(l => {
          const active = !mixed && value === l.key;
          const dis = l.key === 'none' && disabledNone;
          return (
            <button key={l.key} type="button" aria-pressed={active} disabled={dis}
              title={dis ? noneTitle : undefined}
              onClick={() => onChange(l.key)}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? l.key === 'none'
                    ? 'bg-surface-overlay text-ink'
                    : inherited ? 'bg-brand/5 text-brand/70' : 'bg-brand/15 text-brand'
                  : 'text-ink-faint hover:text-ink hover:bg-surface-overlay'
              }`}>
              {l.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RowBlock({ row, draft, setDraft, allLevel, derivedLabel, topBorder, isAll }) {
  const [open, setOpen] = useState(false);
  const sections = row.sections || [];
  const direct = levelOf(draft, row.ns, '*');
  const inheritsAll = !isAll && row.ns !== 'admin';
  const effective = inheritsAll ? maxLevel(direct, allLevel) : direct;
  const inherited = inheritsAll && RANK[effective] > RANK[direct];
  const scoped = sections.filter(s => levelOf(draft, row.ns, s.key) !== 'none').length;

  return (
    <div className={`${topBorder ? 'border-t border-cohesity-border' : ''} ${isAll ? 'bg-surface-overlay' : ''}`}>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink flex items-center gap-2 flex-wrap">
            {row.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: row.color }} />}
            {row.label}
            {row.enabled === false && <span className="chip bg-surface-overlay border-cohesity-border text-ink-faint">disabled</span>}
            {inherited && <span className="text-[10px] font-normal text-ink-faint">via all platforms</span>}
          </p>
          {derivedLabel && <p className="text-[10px] text-ink-faint mt-0.5">via {derivedLabel}</p>}
          {row.hint && <p className="text-[10px] text-ink-faint mt-0.5">{row.hint}</p>}
          {sections.length > 0 && (
            <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
              className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-ink-faint hover:text-ink cursor-pointer">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Sections ({scoped})
            </button>
          )}
        </div>
        <Segmented label={`${row.label} access`} value={effective} inherited={inherited}
          onChange={lvl => setDraft(withLevel(draft, row.ns, '*', lvl))} />
      </div>
      {open && sections.length > 0 && (
        <div className="bg-surface-overlay/40 border-t border-cohesity-border/60">
          {sections.map(s => {
            const own = levelOf(draft, row.ns, s.key);
            const eff = maxLevel(own, effective);
            const covered = effective !== 'none';
            const fromRow = covered && RANK[effective] >= RANK[own];
            return (
              <div key={s.key} className="flex items-center justify-between gap-3 pl-8 pr-3 py-1.5 border-t border-cohesity-border/40 first:border-t-0">
                <p className="text-[11px] text-ink-muted">{s.label || s.key}</p>
                <Segmented label={`${row.label} ${s.label || s.key} access`} value={eff} inherited={fromRow}
                  disabledNone={covered} noneTitle="Covered by the platform level"
                  onChange={lvl => setDraft(withLevel(draft, row.ns, s.key, lvl))} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryBlock({ cat, draft, setDraft, allLevel, expanded, onToggle, connectorLabel }) {
  const rows = cat.platforms;
  const eff = rows.map(p => maxLevel(levelOf(draft, p.id, '*'), allLevel));
  const counts = { view: 0, manage: 0, none: 0 };
  eff.forEach(l => { counts[l] += 1; });
  const common = eff.length && eff.every(l => l === eff[0]) ? eff[0] : null;
  const allInherited = rows.length > 0 && rows.every(p => levelOf(draft, p.id, '*') === 'none') && allLevel !== 'none';
  let summary;
  if (allInherited) summary = 'All via all platforms';
  else if (counts.view === 0 && counts.manage === 0) summary = 'None';
  else summary = `View ${counts.view}, Manage ${counts.manage}, None ${counts.none}`;

  const setAll = (lvl) => {
    let next = new Set(draft);
    rows.forEach(p => { next = withLevel(next, p.id, '*', lvl); });
    setDraft(next);
  };

  return (
    <div className="border-t border-cohesity-border">
      <div className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-overlay/50">
        <button type="button" onClick={onToggle} aria-expanded={expanded}
          className="flex items-center gap-2 min-w-0 text-left cursor-pointer">
          {expanded ? <ChevronDown size={13} className="text-ink-faint" /> : <ChevronRight size={13} className="text-ink-faint" />}
          <span className="text-xs font-semibold text-ink">{cat.label}</span>
          <span className="text-[10px] text-ink-faint">{rows.length} {rows.length === 1 ? 'platform' : 'platforms'}</span>
          <span className="text-[10px] text-ink-faint">{summary}</span>
        </button>
        <Segmented label={`${cat.label} access`} value={common} mixed={common === null} inherited={allInherited}
          onChange={setAll} />
      </div>
      {expanded && rows.map(p => (
        <RowBlock key={p.id} row={{ ...p, ns: p.id }} draft={draft} setDraft={setDraft} allLevel={allLevel}
          derivedLabel={p.derived && p.derivedFrom ? connectorLabel(p.derivedFrom) : null} topBorder />
      ))}
    </div>
  );
}

export default function GrantEditor({ grants, catalog, onSave, saving, copySources, onCopyFrom, onDirtyChange, live }) {
  const seed = useMemo(() => new Set(grants || []), [grants]);
  const [draft, setLocalDraft] = useState(seed);
  // live mode (create forms with no id yet): every change is pushed up at once, no Save bar.
  const setDraft = (next) => { setLocalDraft(next); if (live) onSave([...next].sort()); };
  useEffect(() => { setLocalDraft(new Set(grants || [])); }, [grants]);
  const [store, setStore] = useState(readStore);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [copyId, setCopyId] = useState('');

  const changes = useMemo(() => {
    let n = 0;
    draft.forEach(p => { if (!seed.has(p)) n += 1; });
    seed.forEach(p => { if (!draft.has(p)) n += 1; });
    return n;
  }, [draft, seed]);
  const dirty = changes > 0;
  useEffect(() => { if (onDirtyChange) onDirtyChange(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = catalog?.categories || [];
  const platformRows = cats.flatMap(c => c.platforms);
  const connectorLabel = (id) => platformRows.find(p => p.id === id)?.label || id;

  const allLevel = levelOf(draft, '*', '*');
  const opsRow = catalog?.ops ? { ...catalog.ops, ns: 'ops' } : { ns: 'ops', label: 'Ops', sections: [] };
  const adminRow = catalog?.admin ? { ...catalog.admin, ns: 'admin' } : { ns: 'admin', label: 'Administration', sections: [] };
  const allRow = { ns: '*', label: catalog?.all?.label || 'All platforms', hint: catalog?.all?.hint, sections: [] };

  // Grants the editor cannot place: unknown namespace, wildcard namespace with a
  // section, or a section the catalog does not list.
  const placeable = useMemo(() => {
    const secs = new Map();
    platformRows.forEach(p => secs.set(p.id, new Set((p.sections || []).map(s => s.key))));
    secs.set('ops', new Set((opsRow.sections || []).map(s => s.key)));
    secs.set('admin', new Set((adminRow.sections || []).map(s => s.key)));
    secs.set('*', new Set());
    return secs;
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const advancedGrants = [...draft].filter(p => {
    const [ns, sec] = p.split(':');
    const set = placeable.get(ns);
    if (!set) return true;
    return sec !== '*' && !set.has(sec);
  }).sort();
  const knownNs = ['*', 'ops', ...platformRows.map(p => p.id), 'admin'];

  const toggleCat = (key, current) => {
    const next = { ...store, [key]: !current };
    setStore(next);
    writeStore(next);
  };

  const heldAdmin = () => [...draft].filter(p => p.startsWith('admin:'));
  const applyPreset = (list) => { setDraft(new Set(list)); setPresetsOpen(false); };
  const doCopy = async () => {
    if (!copyId || !onCopyFrom) return;
    const list = await onCopyFrom(Number(copyId) || copyId);
    if (Array.isArray(list)) { setDraft(new Set(list)); setPresetsOpen(false); setCopyId(''); }
  };

  if (!catalog) return <p className="text-[11px] text-ink-faint">Loading...</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">Changes apply when you press Save.</p>
        <div className="relative">
          <button type="button" onClick={() => setPresetsOpen(o => !o)} aria-expanded={presetsOpen}
            className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 border border-cohesity-border rounded-lg text-ink-muted hover:text-ink hover:bg-surface-overlay cursor-pointer">
            <Wand2 size={12} /> Presets <ChevronDown size={11} />
          </button>
          {presetsOpen && (
            <div className="absolute right-0 mt-1 z-20 w-64 panel p-1 flex flex-col gap-0.5 shadow-xl">
              <button type="button" className="text-left text-[11px] px-2.5 py-1.5 rounded hover:bg-surface-overlay cursor-pointer"
                onClick={() => applyPreset(['*:*:view', ...heldAdmin()])}>Read-only on every platform</button>
              <button type="button" className="text-left text-[11px] px-2.5 py-1.5 rounded hover:bg-surface-overlay cursor-pointer"
                onClick={() => applyPreset(['*:*:manage', ...heldAdmin()])}>Operate every platform, no administration</button>
              <button type="button" className="text-left text-[11px] px-2.5 py-1.5 rounded hover:bg-surface-overlay cursor-pointer"
                onClick={() => applyPreset(['*:*:*', 'admin:*:*'])}>Administrator</button>
              {copySources && copySources.length > 0 && (
                <div className="px-2.5 py-1.5 flex items-center gap-1.5">
                  <select aria-label="Copy from group" value={copyId} onChange={e => setCopyId(e.target.value)} className={`${inputClass} w-auto flex-1`}>
                    <option value="">Copy from group...</option>
                    {copySources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button type="button" disabled={!copyId} onClick={doCopy}
                    className="text-[11px] px-2 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg disabled:opacity-40 cursor-pointer">Load</button>
                </div>
              )}
              <button type="button" className="text-left text-[11px] px-2.5 py-1.5 rounded hover:bg-surface-overlay text-status-crit cursor-pointer"
                onClick={() => applyPreset([])}>Clear all</button>
            </div>
          )}
        </div>
      </div>

      <div className="border border-cohesity-border rounded-lg overflow-hidden">
        <RowBlock row={allRow} draft={draft} setDraft={setDraft} allLevel={allLevel} isAll />
        {cats.map(cat => {
          const hasDirect = cat.platforms.some(p => levelOf(draft, p.id, '*') !== 'none');
          const expanded = store[cat.key] ?? hasDirect;
          return (
            <CategoryBlock key={cat.key} cat={cat} draft={draft} setDraft={setDraft} allLevel={allLevel}
              expanded={expanded} onToggle={() => toggleCat(cat.key, expanded)} connectorLabel={connectorLabel} />
          );
        })}
        <RowBlock row={opsRow} draft={draft} setDraft={setDraft} allLevel={allLevel} topBorder />
        <RowBlock row={{ ...adminRow, hint: `${adminRow.hint || ''}${adminRow.hint ? '. ' : ''}Not covered by All platforms; grant it here explicitly.` }}
          draft={draft} setDraft={setDraft} allLevel={allLevel} topBorder />
      </div>

      <div>
        <button type="button" onClick={() => setShowAdvanced(o => !o)}
          className="flex items-center gap-1 text-[11px] font-medium text-ink-faint hover:text-ink transition-colors cursor-pointer">
          {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Advanced: other grants{advancedGrants.length > 0 ? ` (${advancedGrants.length})` : ''}
        </button>
        {showAdvanced && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {advancedGrants.length === 0 && <p className="text-[11px] text-ink-faint">No other grants.</p>}
              {advancedGrants.map(p => (
                <PermissionChip key={p} perm={p} onRemove={() => { const n = new Set(draft); n.delete(p); setDraft(n); }} />
              ))}
            </div>
            <PermissionBuilder namespaces={knownNs} onAdd={(p) => setDraft(new Set([...draft, p]))} />
          </div>
        )}
      </div>

      {dirty && !live && (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 px-3 py-2 bg-cohesity-gray border border-brand/30 rounded-lg shadow-xl">
          <p className="text-xs text-ink">{changes} {changes === 1 ? 'change' : 'changes'}</p>
          <div className="flex items-center gap-2">
            <button type="button" disabled={saving} onClick={() => setDraft(new Set(seed))}
              className="text-[11px] font-medium px-3 py-1.5 border border-cohesity-border rounded-lg text-ink-muted hover:text-ink cursor-pointer disabled:opacity-40">Cancel</button>
            <button type="button" disabled={saving} onClick={() => onSave([...draft].sort())}
              className="text-[11px] font-medium px-3 py-1.5 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 cursor-pointer disabled:opacity-40">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
