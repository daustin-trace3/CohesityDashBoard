// Demo Platform frontend module (ICC contract C9.4). Bundled as an IIFE with
// no ESM imports at runtime — React comes from `window.React` (injected by
// the build banner, see plugin-sdk/build.mjs). No Tailwind: the host's CSS
// purge only scans host source files, so plugin markup uses inline styles.

function DemoItemsPage() {
  const [items, setItems] = React.useState([]);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch('/api/demo/items', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`request failed: ${res.status}`);
        return res.json();
      })
      .then(setItems)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Demo Items</h1>
      {error && <p style={{ color: '#DC2626' }}>{error}</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {items.map((item) => (
          <li
            key={item.id}
            style={{
              padding: '10px 14px',
              marginBottom: 8,
              border: '1px solid #E5E7EB',
              borderRadius: 8,
              background: '#FAFAFA',
            }}
          >
            <strong>{item.name}</strong>
            <span style={{ color: '#6B7280', marginLeft: 8, fontSize: 12 }}>{item.created_at}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

window.__ICC_REGISTER_PLUGIN__({
  id: 'demo',
  label: 'Demo',
  color: '#8B5CF6',
  switcherRoute: '/demo',
  basePath: '/demo',
  isActive: (p) => p.startsWith('/demo'),
  navGroups: [
    {
      label: 'Monitor',
      items: [{ label: 'Items', route: '/demo', isActive: (p) => p === '/demo' }],
    },
  ],
  routes: [{ path: 'demo', Component: DemoItemsPage }],
});
