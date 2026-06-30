import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy target for /api during dev. Defaults to the local backend; override
// with VITE_PROXY_TARGET (e.g. http://136.63.53.121:3001) for remote access.
const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: PROXY_TARGET,
        changeOrigin: true
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/__tests__/setup.js',
  },
});
