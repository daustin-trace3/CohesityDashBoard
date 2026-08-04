# ICC Plugin SDK

Build tooling for installable, signed ICC (CohesityDashBoard) platform plugins
(`.iccplugin` files, contract C9.1).

## Create a plugin from the template

Copy `template/` to a new directory (e.g. `../my-plugin/`) and edit:

- `plugin.json` — `id` (`[a-z0-9-]+`, must not be a reserved id — see
  `backend/core/registry.js`), `name`, `version` (semver), `color`.
- `backend/src/index.js` — exports the plugin manifest: `id`, `name`,
  `apiVersion: 1`, `migrations` (versioned steps, see
  `backend/db/migrations/pure.js` for the pattern), `createRouter(coreApi)`,
  `createPoller(coreApi)` (or `null`), `statusTables`.
- `frontend/src/index.jsx` — optional. Registers the platform module via
  `window.__ICC_REGISTER_PLUGIN__({...})`. Uses `window.React` (no import —
  the build injects `const React = window.React;`). No Tailwind: the host's
  CSS purge doesn't scan plugin source, so style with inline `style={}`.

## Charts (window.Chart)

Plugins cannot `import 'chart.js'` — it isn't a dependency of `plugin-sdk`,
so esbuild has nothing to resolve it against, and even if it could resolve
it would bundle a second copy alongside the host's. Instead the host exposes
its single Chart.js instance the same way it exposes React:

```js
window.Chart
```

This is the raw `Chart` class from `chart.js`, already `.register()`'d by
the host with `CategoryScale, LinearScale, BarElement, LineElement,
PointElement, ArcElement, Title, Tooltip, Legend, Filler` — enough for line,
bar, and doughnut/pie charts. Plugins do not need to (and cannot) register
anything themselves. Use it imperatively against a canvas ref, e.g.:

```js
const canvasRef = React.useRef(null);
const chartRef = React.useRef(null);
React.useEffect(() => {
  if (!window.Chart || !canvasRef.current) return undefined;
  chartRef.current = new window.Chart(canvasRef.current, { type: 'line', data, options });
  return () => chartRef.current?.destroy();
}, [data, options]);
return React.createElement('canvas', { ref: canvasRef });
```

Always guard on `window.Chart` being defined and never throw if it's
missing — see `proxmox/frontend/src/charts.jsx` and
`rubrik/frontend/src/charts.jsx` for the pattern used across the built-in
chart kits.

## Router note (bare function, not Express)

Installed plugins are loaded with `require()` on their own bundled
`dist/backend/index.cjs` — they cannot `require('express')` from the host.
`createRouter` must therefore return a **bare** `(req, res, next)` function,
not an `express.Router()` instance. Match `req.method` / `req.path` by hand
(see `template/backend/src/index.js`). `coreApi` may grow a small `Router`
helper in a future contract revision to make multi-route plugins less
tedious; until then, dispatch manually.

## Build

```bash
cd plugin-sdk
npm install
node build.mjs               # builds ./template
node build.mjs --dir ../my-plugin
```

Produces `dist/backend/index.cjs` (esbuild, CJS, bundled, node18 target) and,
if `frontend/src/index.jsx` exists, `dist/frontend/bundle.js` (esbuild, IIFE,
classic JSX transform to `React.createElement`).

## Sign and package

```bash
node pack.mjs
node pack.mjs --dir ../my-plugin
```

Produces `<id>-<version>.iccplugin` (a plain zip) containing `manifest.json`,
`manifest.sig`, `backend/index.cjs`, and `frontend/bundle.js` if present.

### Signing key

`pack.mjs` signs `manifest.json`'s exact bytes with Ed25519. It resolves the
private key from:

1. `ICC_PLUGIN_SIGNING_KEY` env var (path to the PEM), if set.
2. Otherwise `../../LicenseTools/keys/plugin-signing-private.pem` relative to
   `plugin-sdk/` (i.e. the sibling `LicenseTools/keys/` directory next to
   `Dashboard/`).

**Never commit the private key.** It lives outside this repo
(`LicenseTools/keys/`) and is gitignored everywhere it might land. The
matching public key is embedded in the host at
`backend/config/pluginSigning.js` and is the only thing needed to *verify*
plugins — treat the private key as a deploy-time secret.

## Install

Package produced by `pack.mjs` is uploaded via the host's admin UI
(`/admin` → Plugins → upload) or `POST /api/plugins/install`
(`admin:plugins:manage`). A fresh plugin id hot-loads immediately; an
existing id stages an upgrade applied on next restart.
