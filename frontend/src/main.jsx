import React from 'react';
import ReactDOM from 'react-dom/client';
import * as ReactRouterDOM from 'react-router-dom';
import App from './App';
import './index.css';

// Expose globals for runtime-loaded plugin bundles (IIFE, no ESM imports)
// before anything renders — see ICC Phase 2 contract C9.4.
window.React = React;
window.ReactDOM = ReactDOM;
window.ReactRouterDOM = ReactRouterDOM;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
