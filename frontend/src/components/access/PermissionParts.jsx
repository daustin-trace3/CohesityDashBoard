import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import client from '../../api/client';

export const inputClass = 'w-full bg-surface-overlay border border-cohesity-border rounded-lg px-3 py-2 text-xs text-ink focus:border-brand/60 outline-none';
export const LEVELS = ['view', 'manage', '*'];

/* Permission string builder row: namespace / section / level -> ns:section:level */
export function PermissionBuilder({ onAdd, namespaces }) {
  const [namespace, setNamespace] = useState(namespaces[0] || 'cohesity');
  const [section, setSection] = useState('*');
  const [level, setLevel] = useState('view');

  const add = () => {
    const sec = (section || '*').trim() || '*';
    onAdd(`${namespace}:${sec}:${level}`);
    setSection('*');
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-1.5 flex-wrap">
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Platform</label>
          <select value={namespace} onChange={e => setNamespace(e.target.value)} className={`${inputClass} w-auto`}>
            {namespaces.map(n => <option key={n} value={n}>{n === '*' ? '* (all)' : n}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Section</label>
          <input value={section} onChange={e => setSection(e.target.value)} placeholder="*" title="Section within the platform (e.g. alerts, settings). Use * for all sections." className={`${inputClass} w-24`} />
        </div>
        <div>
          <label className="text-[10px] font-medium text-ink-faint uppercase tracking-wider mb-0.5 block">Access level</label>
          <select value={level} onChange={e => setLevel(e.target.value)} className={`${inputClass} w-auto`}>
            {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button onClick={add} type="button"
          className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-2 bg-brand/10 border border-brand/30 text-brand rounded-lg hover:bg-brand/20 transition-colors cursor-pointer">
          <Plus size={12} /> Add
        </button>
      </div>
      <p className="text-[10px] text-ink-faint">Section is the API area within a platform (e.g. clusters, alerts, settings). Use * for all. Manage includes view.</p>
    </div>
  );
}

export function PermissionChip({ perm, onRemove }) {
  return (
    <span className="chip bg-surface-overlay border-cohesity-border text-ink-muted font-mono">
      {perm}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${perm}`} className="ml-1 text-ink-faint hover:text-status-crit cursor-pointer">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

/* Fetch GET /users/permission-catalog once per mount. */
export function useGrantCatalog() {
  const [state, setState] = useState({ catalog: null, error: null });
  useEffect(() => {
    let live = true;
    client.get('/users/permission-catalog')
      .then(({ data }) => { if (live) setState({ catalog: data, error: null }); })
      .catch(err => { if (live) setState({ catalog: null, error: err?.response?.data?.error || 'Could not load the permission catalog.' }); });
    return () => { live = false; };
  }, []);
  return state;
}
