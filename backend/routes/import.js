const express = require('express');
const router = express.Router();
const db = require('../db/database');
const logger = require('../utils/logger');

// POST /api/import/history
// Content-Type: text/csv  (raw CSV text body, max 10mb)
router.post('/history', express.text({ type: 'text/csv', limit: '10mb' }), (req, res) => {
  if (!req.is('text/csv')) {
    return res.status(415).json({ error: 'Content-Type must be text/csv' });
  }

  const raw = req.body || '';
  const lines = raw.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');

  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV must contain a header row and at least one data row' });
  }

  const headerLine = lines[0];
  // Normalize: lowercase, strip spaces and special chars (handles "Dedupe Ratio", "DedupRatio", "Physical Used TB", etc.)
  const normalize = s => s.trim().toLowerCase().replace(/[\s_\-()]/g, '');
  const headers = headerLine.split(',').map(normalize);
  const fi = (fn) => headers.findIndex(fn);

  const idx = {
    timestamp:      fi(h => h === 'timestamp'),
    cluster:        fi(h => h === 'cluster'),
    physicalusedtb: fi(h => h.startsWith('physicalused') || h === 'physicalusedtb'),
    clusterusagetb: fi(h => h.startsWith('clusterusage') || h === 'clusterusagetb'),
    totalcapacitytb:fi(h => h.startsWith('totalcapacity') || h === 'totalcapacitytb'),
    deduperatio:    fi(h => h.startsWith('dedup')),
    nodecount:      fi(h => h.startsWith('nodecount') || h === 'nodecount'),
  };

  const missing = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required columns: ${missing.join(', ')}` });
  }

  const overwrite = req.query.overwrite === 'true';

  const stmtCluster = db.prepare('SELECT id FROM clusters WHERE LOWER(name) = LOWER(?)');
  const stmtDupCheck = db.prepare('SELECT COUNT(*) as c FROM metrics_history WHERE cluster_id = ? AND captured_at = ?');
  const stmtDelete = db.prepare('DELETE FROM metrics_history WHERE cluster_id = ? AND captured_at = ?');
  const stmtInsert = db.prepare(`
    INSERT INTO metrics_history
      (cluster_id, captured_at, used_bytes, total_capacity_bytes, logical_bytes, data_reduction_ratio, node_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let overwritten = 0;
  let skipped = 0;
  const unmatched = new Set();

  try {
    db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const fields = lines[i].split(',');

        const rawTs = fields[idx.timestamp]?.trim();
        const clusterName = fields[idx.cluster]?.trim();
        const physicalUsedTb = parseFloat(fields[idx.physicalusedtb]);
        const clusterUsageTb = parseFloat(fields[idx.clusterusagetb]);
        const totalCapacityTb = parseFloat(fields[idx.totalcapacitytb]);
        const dedupeRatio = parseFloat(fields[idx.deduperatio]);
        const nodeCount = parseInt(fields[idx.nodecount], 10);

        if (!rawTs || !clusterName) { skipped++; continue; }

        const d = new Date(rawTs);
        if (isNaN(d.getTime())) { skipped++; continue; }

        const pad = n => String(n).padStart(2, '0');
        const capturedAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

        const clusterRow = stmtCluster.get(clusterName);
        if (!clusterRow) {
          unmatched.add(clusterName);
          skipped++;
          continue;
        }

        const dup = stmtDupCheck.get(clusterRow.id, capturedAt);
        if (dup.c > 0) {
          if (!overwrite) { skipped++; continue; }
          stmtDelete.run(clusterRow.id, capturedAt);
          overwritten++;
        }

        stmtInsert.run(
          clusterRow.id,
          capturedAt,
          isNaN(clusterUsageTb) ? null : Math.round(clusterUsageTb * 1e12),
          isNaN(totalCapacityTb) ? null : Math.round(totalCapacityTb * 1e12),
          isNaN(physicalUsedTb) ? null : Math.round(physicalUsedTb * 1e12),
          isNaN(dedupeRatio) ? null : dedupeRatio,
          isNaN(nodeCount) ? null : nodeCount
        );
        imported++;
      }
    })();

    logger.info(`CSV import: imported=${imported} overwritten=${overwritten} skipped=${skipped} unmatched=${[...unmatched].join(',')}`);
    return res.json({ imported, overwritten, skipped, unmatched: [...unmatched] });
  } catch (err) {
    logger.error('CSV import error:', err);
    return res.status(500).json({ error: 'Import failed', detail: err.message });
  }
});

// GET /api/import/debug/:clusterName — returns last 10 imported rows as human-readable values
router.get('/debug/:clusterName', (req, res) => {
  const clusterRow = db.prepare('SELECT id, name FROM clusters WHERE LOWER(name) = LOWER(?)').get(req.params.clusterName);
  if (!clusterRow) return res.status(404).json({ error: 'Cluster not found' });

  const rows = db.prepare(`
    SELECT captured_at,
           ROUND(used_bytes / 1e12, 4) AS used_tb,
           ROUND(total_capacity_bytes / 1e12, 4) AS total_tb,
           ROUND(logical_bytes / 1e12, 4) AS logical_tb,
           ROUND(CAST(used_bytes AS REAL) / NULLIF(total_capacity_bytes, 0) * 100, 2) AS pct_used,
           data_reduction_ratio,
           node_count
    FROM metrics_history
    WHERE cluster_id = ?
    ORDER BY captured_at DESC
    LIMIT 10
  `).all(clusterRow.id);

  res.json({ cluster: clusterRow.name, rows });
});

module.exports = router;
