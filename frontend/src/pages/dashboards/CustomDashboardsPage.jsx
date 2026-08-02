// Custom dashboards (phase 2): private per-user dashboards built from the
// declared dataset catalog. Stacked layout — drag/resize is phase 3.
import { useCallback, useEffect, useState } from 'react';
import { LayoutGrid, Plus, Trash2, Pencil, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import { PageHeader, Panel, LoadingPanel } from '../../components/ui/primitives';
import { useToast } from '../../components/ui/Toaster';
import WidgetBuilder from './WidgetBuilder';
import { WidgetView } from './widgets';

export default function CustomDashboardsPage() {
  const { toast } = useToast();
  const [datasets, setDatasets] = useState(null);
  const [list, setList] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [building, setBuilding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const loadList = useCallback(async (selectFirst = false) => {
    try {
      const res = await client.get('/user-dashboards');
      setList(res.data.dashboards);
      if (selectFirst && res.data.dashboards.length && !selectedId) {
        setSelectedId(res.data.dashboards[0].id);
      }
    } catch (err) {
      setList([]);
      // The app-level gate 404s every /user-dashboards call while the feature
      // is switched off in Global Settings (the list route itself never 404s).
      if (err.response?.status === 404) {
        setFeatureDisabled(true);
        return;
      }
      toast({ type: 'error', title: 'Failed to load dashboards' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    client.get('/datasets').then((res) => setDatasets(res.data.datasets)).catch(() => setDatasets([]));
    loadList(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedId == null) { setDashboard(null); return; }
    setDashboard(null);
    client.get(`/user-dashboards/${selectedId}`)
      .then((res) => setDashboard(res.data))
      .catch(() => { setDashboard(null); toast({ type: 'error', title: 'Failed to load dashboard' }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const create = async () => {
    const name = window.prompt('Dashboard name');
    if (!name || !name.trim()) return;
    try {
      const res = await client.post('/user-dashboards', { name: name.trim(), widgets: [] });
      await loadList();
      setSelectedId(res.data.id);
      setBuilding(true);
    } catch (err) {
      toast({ type: 'error', title: err.response?.data?.message || 'Failed to create dashboard' });
    }
  };

  const saveWidgets = async (widgets) => {
    try {
      await client.put(`/user-dashboards/${dashboard.id}`, { widgets });
      setDashboard((d) => ({ ...d, widgets }));
      loadList();
    } catch (err) {
      toast({ type: 'error', title: err.response?.data?.message || 'Failed to save dashboard' });
    }
  };

  const rename = async () => {
    if (!nameDraft.trim()) { setRenaming(false); return; }
    try {
      await client.put(`/user-dashboards/${dashboard.id}`, { name: nameDraft.trim() });
      setDashboard((d) => ({ ...d, name: nameDraft.trim() }));
      setRenaming(false);
      loadList();
    } catch (err) {
      toast({ type: 'error', title: err.response?.data?.message || 'Rename failed' });
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete dashboard "${dashboard.name}"?`)) return;
    try {
      await client.delete(`/user-dashboards/${dashboard.id}`);
      setSelectedId(null);
      setDashboard(null);
      await loadList(true);
    } catch {
      toast({ type: 'error', title: 'Delete failed' });
    }
  };

  if (featureDisabled) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <PageHeader
          icon={LayoutGrid}
          title="Custom Dashboards"
          description="Build your own views from the platform dataset catalog"
        />
        <Panel className="p-6 text-center">
          <p className="text-sm font-semibold text-ink">Custom Dashboards is not enabled</p>
          <p className="text-xs text-ink-muted mt-1">
            An administrator can turn it on in Global Settings → Platforms → Preview features.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <PageHeader
        icon={LayoutGrid}
        title="Custom Dashboards"
        description="Build your own views from the platform dataset catalog"
      >
        <button
          onClick={create}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-brand text-cohesity-black text-sm font-medium hover:opacity-90"
        >
          <Plus size={14} /> New dashboard
        </button>
      </PageHeader>

      <div className="flex gap-4 items-start">
        <Panel title="My dashboards" className="w-64 flex-shrink-0">
          {list == null ? (
            <LoadingPanel height={120} />
          ) : list.length === 0 ? (
            <p className="text-sm text-ink-faint">No dashboards yet. Create one to get started.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {list.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => setSelectedId(d.id)}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm ${
                      d.id === selectedId ? 'bg-cohesity-border/40 text-ink' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {d.name}
                    <span className="text-xs text-ink-faint ml-2 tnum">{d.widgetCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="flex-1 flex flex-col gap-4 min-w-0">
          {selectedId != null && dashboard == null && <LoadingPanel />}

          {dashboard && (
            <>
              <div className="flex items-center gap-2">
                {renaming ? (
                  <>
                    <input
                      className="bg-cohesity-black border border-cohesity-border rounded px-2 py-1 text-sm text-ink focus:outline-none focus:border-brand"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && rename()}
                      autoFocus
                    />
                    <button onClick={rename} className="text-sm text-brand hover:underline">Save</button>
                    <button onClick={() => setRenaming(false)} className="text-sm text-ink-faint hover:text-ink">Cancel</button>
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-medium text-ink">{dashboard.name}</h2>
                    <button
                      onClick={() => { setNameDraft(dashboard.name); setRenaming(true); }}
                      className="text-ink-faint hover:text-ink"
                      aria-label="Rename dashboard"
                    >
                      <Pencil size={14} />
                    </button>
                  </>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => setRefreshNonce((n) => n + 1)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-cohesity-border text-sm text-ink-muted hover:text-ink"
                >
                  <RefreshCw size={13} /> Refresh
                </button>
                {!building && (
                  <button
                    onClick={() => setBuilding(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-cohesity-border text-sm text-ink hover:border-brand"
                  >
                    <Plus size={13} /> Add widget
                  </button>
                )}
                <button
                  onClick={remove}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-cohesity-border text-sm text-ink-muted hover:text-red-400"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>

              {building && datasets && (
                <WidgetBuilder
                  datasets={datasets}
                  onClose={() => setBuilding(false)}
                  onAdd={(w) => {
                    saveWidgets([...(dashboard.widgets || []), w]);
                    setBuilding(false);
                  }}
                />
              )}

              {(dashboard.widgets || []).length === 0 && !building && (
                <Panel>
                  <p className="text-sm text-ink-faint">This dashboard is empty — add a widget to get started.</p>
                </Panel>
              )}

              {(dashboard.widgets || []).map((w, i) => (
                <Panel
                  key={`${i}-${w.datasetId}-${w.chartType}`}
                  title={w.title}
                  actions={
                    <button
                      onClick={() => saveWidgets(dashboard.widgets.filter((_, j) => j !== i))}
                      className="text-ink-faint hover:text-red-400"
                      aria-label="Remove widget"
                    >
                      <Trash2 size={14} />
                    </button>
                  }
                >
                  <div className={w.chartType === 'stat' ? 'h-28' : w.chartType === 'table' ? 'max-h-96' : 'h-72'}>
                    <WidgetView widget={w} nonce={refreshNonce} />
                  </div>
                </Panel>
              ))}
            </>
          )}

          {selectedId == null && list && list.length === 0 && (
            <Panel>
              <p className="text-sm text-ink-faint">
                Custom dashboards let you chart any dataset you have access to — capacity trends, VPG health,
                datastore usage — without waiting for a built-in page. Create your first dashboard to begin.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
