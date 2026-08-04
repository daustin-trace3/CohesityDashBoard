import React from 'react';
import ReactDOM from 'react-dom/client';
import * as ReactRouterDOM from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement,
  Title, Tooltip as ChartTooltip, Legend, Filler,
} from 'chart.js';
import App from './App';
import './index.css';

// Expose globals for runtime-loaded plugin bundles (IIFE, no ESM imports)
// before anything renders — see ICC Phase 2 contract C9.4.
window.React = React;
window.ReactDOM = ReactDOM;
window.ReactRouterDOM = ReactRouterDOM;

// Registers the same controllers/elements/scales/plugins the host's own
// pages use (line, bar, doughnut/pie) so plugin bundles get one shared
// Chart.js instance instead of hand-rolling SVG charts or bundling their
// own copy of chart.js (which the plugin sandbox can't import anyway).
ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, ChartTooltip, Legend, Filler);
window.Chart = ChartJS;

// After a deploy, an open tab can lazy-load a page chunk that no longer
// exists (old hashed filename). Vite surfaces that as vite:preloadError —
// reload once to pick up the new build instead of showing a broken page.
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem('chunk-reload-at') || 0);
  if (Date.now() - last > 30000) {
    sessionStorage.setItem('chunk-reload-at', String(Date.now()));
    event.preventDefault();
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
