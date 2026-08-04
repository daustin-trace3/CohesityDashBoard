#!/usr/bin/env node
// Builds a plugin's backend + frontend source into dist/ ready for pack.mjs.
// Usage: node build.mjs [--dir <plugin-dir>]   (defaults to ./template)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { dir: './template' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      out.dir = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main() {
  const { dir } = parseArgs(process.argv.slice(2));
  const pluginDir = path.resolve(__dirname, dir);

  const backendEntry = path.join(pluginDir, 'backend', 'src', 'index.js');
  const frontendEntry = path.join(pluginDir, 'frontend', 'src', 'index.jsx');
  const distDir = path.join(pluginDir, 'dist');

  if (!fs.existsSync(backendEntry)) {
    throw new Error(`backend entry not found: ${backendEntry}`);
  }

  await build({
    entryPoints: [backendEntry],
    outfile: path.join(distDir, 'backend', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'info',
  });
  console.log(`[build] backend -> ${path.join(distDir, 'backend', 'index.cjs')}`);

  if (fs.existsSync(frontendEntry)) {
    await build({
      entryPoints: [frontendEntry],
      outfile: path.join(distDir, 'frontend', 'bundle.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2020',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      // Rewrite bare React/Chart references to the host globals at build time.
      // A `const React = ...` banner would sit OUTSIDE the IIFE, so a second
      // installed plugin threw "Identifier 'React' has already been declared"
      // and never registered.
      define: {
        React: 'window.React',
        ReactDOM: 'window.ReactDOM',
        ReactRouterDOM: 'window.ReactRouterDOM',
        Chart: 'window.Chart',
      },
      logLevel: 'info',
    });
    console.log(`[build] frontend -> ${path.join(distDir, 'frontend', 'bundle.js')}`);
  } else {
    console.log('[build] no frontend/src/index.jsx found, skipping frontend bundle');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
