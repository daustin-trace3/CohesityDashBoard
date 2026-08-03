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
  const loadedIds = useRef(new Set(builtinPlatforms.map(p => p.id)));

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
        setPlatforms(prev => (prev.some(p => p.id === module.id) ? prev : [...prev, module]));
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
