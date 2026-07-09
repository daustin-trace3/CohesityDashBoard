/**
 * Registry + dispatcher behavior (contract C4). Each `it` block imports a
 * fresh copy of the registry module (vi.resetModules) so plugin ids and
 * in-memory state never leak between test cases.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

async function freshRegistry() {
  vi.resetModules();
  return import('../core/registry.js');
}

function buildApp(registry) {
  const app = express();
  app.use(express.json());
  app.use('/api/:pluginId', registry.dispatch);
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

function okManifest(id, overrides = {}) {
  return {
    id,
    name: `Plugin ${id}`,
    apiVersion: 1,
    createRouter() {
      const router = express.Router();
      router.get('/ping', (req, res) => res.json({ ok: true, id }));
      return router;
    },
    ...overrides,
  };
}

describe('registerPlugin validation', () => {
  it('registers a valid manifest and dispatches through it', async () => {
    const registry = await freshRegistry();
    registry.init();
    registry.registerPlugin(okManifest('widgets'));
    expect(registry.getPlugin('widgets').status).toBe('active');

    const app = buildApp(registry);
    const res = await request(app).get('/api/widgets/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'widgets' });
  });

  it('rejects a reserved plugin id', async () => {
    const registry = await freshRegistry();
    registry.init();
    expect(() => registry.registerPlugin(okManifest('settings'))).toThrow(/reserved/);
  });

  it('rejects a duplicate plugin id', async () => {
    const registry = await freshRegistry();
    registry.init();
    registry.registerPlugin(okManifest('widgets'));
    expect(() => registry.registerPlugin(okManifest('widgets'))).toThrow(/already registered/);
  });

  it('rejects a manifest with the wrong apiVersion', async () => {
    const registry = await freshRegistry();
    registry.init();
    expect(() =>
      registry.registerPlugin(okManifest('widgets', { apiVersion: 999 }))
    ).toThrow(/apiVersion/);
  });
});

describe('dispatch behavior', () => {
  it('a plugin whose createRouter throws is marked error and dispatch returns 503', async () => {
    const registry = await freshRegistry();
    registry.init();
    registry.registerPlugin(
      okManifest('widgets', {
        createRouter() {
          throw new Error('boom');
        },
      })
    );
    expect(registry.getPlugin('widgets').status).toBe('error');
    expect(registry.getPlugin('widgets').error).toMatch(/boom/);

    const app = buildApp(registry);
    const res = await request(app).get('/api/widgets/ping');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'platform_error' });
  });

  it('a disabled plugin returns 404 platform_disabled', async () => {
    const registry = await freshRegistry();
    registry.init();
    registry.registerPlugin(okManifest('widgets'));
    registry.setEnabled('widgets', false);

    const app = buildApp(registry);
    const res = await request(app).get('/api/widgets/ping');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'platform_disabled' });
  });

  it('an unknown plugin id falls through to the next handler', async () => {
    const registry = await freshRegistry();
    registry.init();

    const app = buildApp(registry);
    const res = await request(app).get('/api/nonexistent/ping');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
