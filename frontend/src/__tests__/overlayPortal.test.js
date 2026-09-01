import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Full-screen overlays (className containing "fixed inset-") MUST be rendered through
// createPortal(..., document.body). The page root's animate-fade-in leaves a transform on
// the container, and a transformed ancestor becomes the containing block for position:fixed —
// the overlay then centers against the page instead of the viewport (bit the Brocade port
// map modal, fixed in 02c3c70). New platform pages must portal; the list below grandfathers
// pre-existing offenders — remove entries as they get fixed, never add to it.

const GRANDFATHERED = new Set([
  'components/AdvisorReportModal.jsx',
  'components/AlertReviewModal.jsx',
  'components/ClusterAIModal.jsx',
  'components/HardwareModal.jsx',
  'pages/AdminPluginsPage.jsx',
  'pages/AdminUsersPage.jsx',
  'pages/AlertsPage.jsx',
  'pages/ClusterManagement.jsx',
  'pages/Dashboard.jsx',
  'pages/netapp/NetAppCifsPage.jsx',
  'pages/netapp/NetAppNfsPage.jsx',
  'pages/zerto/ZertoVpgsPage.jsx',
]);

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_RE = /fixed inset-/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('full-screen overlays are portaled to document.body', () => {
  const files = walk(SRC).map((f) => ({
    rel: path.relative(SRC, f).split(path.sep).join('/'),
    content: fs.readFileSync(f, 'utf8'),
  }));

  it('every file with a fixed inset- overlay uses createPortal (or is grandfathered)', () => {
    const offenders = files
      .filter((f) => OVERLAY_RE.test(f.content))
      .filter((f) => !f.content.includes('createPortal'))
      .filter((f) => !GRANDFATHERED.has(f.rel))
      .map((f) => f.rel);
    expect(offenders, `Overlay without createPortal(..., document.body) in: ${offenders.join(', ')}. ` +
      'Wrap the fixed inset- overlay in createPortal (see BrocadePortMapPage.jsx) — ' +
      'fixed positioning breaks inside the transformed page container.').toEqual([]);
  });

  it('grandfathered list has no stale entries', () => {
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const stale = [...GRANDFATHERED].filter((rel) => {
      const f = byRel.get(rel);
      return !f || !OVERLAY_RE.test(f.content) || f.content.includes('createPortal');
    });
    expect(stale, `Remove fixed/deleted entries from GRANDFATHERED: ${stale.join(', ')}`).toEqual([]);
  });
});
