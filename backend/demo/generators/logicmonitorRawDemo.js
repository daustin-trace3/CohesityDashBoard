// Demo rows for the raw DataSource store (round 11, WP-R). Derived from the catalog metric
// rows the generator already wrote (lm_ds_metrics), so every seeded instance has one
// lm_ds_values row per catalog metric (datapoint = the datapoint the catalog read) plus two
// datapoints the catalog does not label: a numeric counter and a text status. That keeps
// coverage below 100 percent so the coverage tile and the work queue have something to show.
// Reseed-safe: the source's rows (and orphans of removed sources) are deleted first.

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function seedRawValues(db, { sourceId }) {
  const out = { values: 0, datapoints: 0 };
  if (!hasTable(db, 'lm_ds_values') || !hasTable(db, 'lm_ds_datapoints') || !hasTable(db, 'lm_ds_metrics')) return out;
  for (const t of ['lm_ds_values', 'lm_ds_datapoints']) {
    db.prepare(`DELETE FROM ${t} WHERE source_id = ? OR source_id NOT IN (SELECT id FROM lm_sources)`).run(sourceId);
  }
  db.prepare("UPDATE lm_device_datasources SET raw_last_at = NULL, raw_last_error = NULL WHERE source_id = ?").run(sourceId);

  // Catalog metrics -> one raw row each.
  out.values += db.prepare(`
    INSERT INTO lm_ds_values (source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, datapoint, value, value_text, sampled_at_epoch, updated_at)
    SELECT m.source_id, m.lm_device_id, m.hds_id, m.datasource_name, m.instance_key, COALESCE(i.instance_name, m.instance_key),
      m.datapoint, m.value, NULL, m.sampled_at_epoch, datetime('now', '-4 minutes')
    FROM lm_ds_metrics m
    LEFT JOIN lm_ds_instances i ON i.source_id = m.source_id AND i.lm_device_id = m.lm_device_id AND i.hds_id = m.hds_id AND i.instance_key = m.instance_key
    WHERE m.source_id = ?
  `).run(sourceId).changes;

  // Two uncatalogued datapoints per instance, deterministic from the key.
  const ext = db.prepare(`
    INSERT OR REPLACE INTO lm_ds_values (source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, datapoint, value, value_text, sampled_at_epoch, updated_at)
    SELECT source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, ?, ?, ?, MAX(sampled_at_epoch), datetime('now', '-4 minutes')
    FROM lm_ds_values WHERE source_id = ? GROUP BY source_id, lm_device_id, hds_id, instance_key
  `);
  // Counter: a stable number derived from the instance key length and hds id.
  db.prepare(`
    INSERT OR REPLACE INTO lm_ds_values (source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, datapoint, value, value_text, sampled_at_epoch, updated_at)
    SELECT source_id, lm_device_id, hds_id, datasource_name, instance_key, instance_name, 'RawCounter',
      (LENGTH(instance_key) * 37 + hds_id % 1000) * 1.0, NULL, MAX(sampled_at_epoch), datetime('now', '-4 minutes')
    FROM lm_ds_values WHERE source_id = ? GROUP BY source_id, lm_device_id, hds_id, instance_key
  `).run(sourceId);
  ext.run('RawStatusText', null, 'ok', sourceId);
  out.values = db.prepare('SELECT COUNT(*) n FROM lm_ds_values WHERE source_id = ?').get(sourceId).n;

  // Datapoint catalog: aggregate from the stored values; a datapoint is a catalog pick when a
  // lm_ds_metrics row for the same DataSource reads it.
  out.datapoints = db.prepare(`
    INSERT INTO lm_ds_datapoints (source_id, datasource_name, datapoint, devices, instances, numeric, first_seen, last_seen, catalog_metric)
    SELECT v.source_id, v.datasource_name, v.datapoint, COUNT(DISTINCT v.lm_device_id),
      COUNT(DISTINCT v.lm_device_id || ':' || v.hds_id || ':' || v.instance_key),
      MAX(CASE WHEN v.value IS NOT NULL THEN 1 ELSE 0 END), datetime('now', '-7 days'), datetime('now', '-4 minutes'),
      (SELECT MIN(m.metric) FROM lm_ds_metrics m WHERE m.source_id = v.source_id AND m.datasource_name = v.datasource_name AND m.datapoint = v.datapoint)
    FROM lm_ds_values v WHERE v.source_id = ? GROUP BY v.source_id, v.datasource_name, v.datapoint
  `).run(sourceId).changes;

  db.prepare(`
    UPDATE lm_device_datasources SET raw_last_at = datetime('now', '-4 minutes')
    WHERE source_id = ? AND EXISTS (SELECT 1 FROM lm_ds_values v WHERE v.source_id = lm_device_datasources.source_id AND v.hds_id = lm_device_datasources.hds_id)
  `).run(sourceId);

  // Round 12: two raw datapoint rules over the uncatalogued RawCounter. The first matches the
  // busiest instance (so the demo Issues page shows a raw-threshold row), the second matches nothing.
  try {
    const top = db.prepare(`
      SELECT datasource_name, MAX(value) mx FROM lm_ds_values WHERE source_id = ? AND datapoint = 'RawCounter'
      GROUP BY datasource_name ORDER BY mx DESC, datasource_name LIMIT 2
    `).all(sourceId);
    if (top.length) {
      const rules = [{
        id: 'demo-raw-1', datasource: top[0].datasource_name, datapoint: 'RawCounter', op: '>=', value: top[0].mx,
        severity: 'warning', label: 'Raw counter high', instanceMatch: '', deviceMatch: '', enabled: true,
      }];
      if (top[1]) {
        rules.push({
          id: 'demo-raw-2', datasource: top[1].datasource_name, datapoint: 'RawCounter', op: '>', value: 1000000,
          severity: 'info', label: 'Raw counter far above normal', instanceMatch: '', deviceMatch: '', enabled: true,
        });
      }
      db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('lm_raw_rules', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(rules));
      out.rules = rules.length;
    }
  } catch (err) { console.warn(`[seedDemo] logicmonitor raw rules skipped: ${err.message}`); }
  return out;
}

module.exports = { seedRawValues };
