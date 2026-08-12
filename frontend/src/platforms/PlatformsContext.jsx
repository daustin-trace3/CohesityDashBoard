import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import client from '../api/client';
import { platforms as builtinPlatforms } from './registry';
import { useAuth } from '../auth/AuthContext';
import * as pluginLoader from './pluginLoader';

const PlatformsContext = createContext(null);

export function PlatformsProvider({ children }) {
  // Seeded from the static built-in array so built-ins render with zero flash.
  const [platforms, setPlatforms] = useState(builtinPlatforms);
  const { user } = useAuth();
  // Tracks installed-plugin loads only. A manifest entry may share an id with
  // a compiled-in built-in (host newer than the deployment's backend, plugin
  // installed there) — the manifest is authoritative, so the plugin loads and
  // REPLACES the built-in module below. Server-side the two can never both be
  // registered, so no double-load is possible.
  const loadedIds = useRef(new Set());

  const reload = useCallback(async () => {
    if (!user) return;
    let manifest;
    try {
      const { data } = await client.get('/plugins/frontend-manifest');
      manifest = data;
    } catch (err) {
      // Endpoint may not exist yet (backend not deployed) — don't spam the console.
      console.warn('Could not load plugin frontend manifest', err);
      return;
    }
    for (const entry of manifest || []) {
      if (!entry?.id || loadedIds.current.has(entry.id)) continue;
      loadedIds.current.add(entry.id);
      try {
        const module = await pluginLoader.load(entry.id, entry.version);
        // Assign (never spread — spreading would freeze live getters like the
        // unifi plugin's navGroups) so Layout can tell plugins from built-ins.
        module.isPlugin = true;
        setPlatforms(prev => {
          const i = prev.findIndex(p => p.id === module.id);
          if (i >= 0) { const next = prev.slice(); next[i] = module; return next; }
          return [...prev, module];
        });
      } catch (err) {
        loadedIds.current.delete(entry.id);
        console.warn(`Could not load plugin "${entry.id}"`, err);
      }
    }
  }, [user]);

  useEffect(() => {
    if (user) reload();
  }, [user, reload]);

  useEffect(() => {
    window.addEventListener('platforms-changed', reload);
    return () => window.removeEventListener('platforms-changed', reload);
  }, [reload]);

  return (
    <PlatformsContext.Provider value={{ platforms, reload }}>
      {children}
    </PlatformsContext.Provider>
  );
}

export function usePlatforms() {
  const ctx = useContext(PlatformsContext);
  if (!ctx) throw new Error('usePlatforms must be used within a PlatformsProvider');
  return ctx;
}
