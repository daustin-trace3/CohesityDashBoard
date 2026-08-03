// Loads a plugin's frontend bundle at runtime. The bundle is an IIFE that
// calls window.__ICC_REGISTER_PLUGIN__(platformModule) once evaluated.
const LOAD_TIMEOUT_MS = 15000;

export function load(id, version) {
  return new Promise((resolve, reject) => {
    const prevHandler = window.__ICC_REGISTER_PLUGIN__;
    let settled = false;

    const script = document.createElement('script');
    // ?v= busts browser/CDN caches on plugin upgrades (Cloudflare caches .js
    // by extension even under /api).
    script.src = `/api/plugins/${id}/bundle.js${version ? `?v=${encodeURIComponent(version)}` : ''}`;
    script.async = true;

    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      window.__ICC_REGISTER_PLUGIN__ = prevHandler;
      script.remove();
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Plugin "${id}" load timed out`));
    }, LOAD_TIMEOUT_MS);

    window.__ICC_REGISTER_PLUGIN__ = (module) => {
      if (settled) return;
      settled = true;
      if (!module || module.id !== id || !Array.isArray(module.routes)) {
        cleanup();
        reject(new Error(`Plugin "${id}" registered an invalid module`));
        return;
      }
      cleanup();
      resolve(module);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Plugin "${id}" bundle failed to load`));
    };

    document.head.appendChild(script);
  });
}
