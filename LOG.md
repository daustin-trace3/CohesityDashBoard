Error: [migrations] logicmonitor v17: UNIQUE constraint failed: schema_migrations.scope, schema_migrations.version
2026-11-09 18:52:34 -08:00:     at runMigrations (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\core\migrations.js:50:23)
2026-11-09 18:52:34 -08:00:     at Object.<anonymous> (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\db\database.js:63:1)
2026-11-09 18:52:34 -08:00:     ... 7 lines matching cause stack trace ...
2026-11-09 18:52:34 -08:00:     at Object.<anonymous> (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\routes\clusters.js:3:12) {
2026-11-09 18:52:34 -08:00:   cause: SqliteError: UNIQUE constraint failed: schema_migrations.scope, schema_migrations.version
2026-11-09 18:52:34 -08:00:       at runMigrations (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\core\migrations.js:48:21)
2026-11-09 18:52:34 -08:00:       at Object.<anonymous> (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\db\database.js:63:1)
2026-11-09 18:52:34 -08:00:       at Module._compile (node:internal/modules/cjs/loader:1929:14)
2026-11-09 18:52:34 -08:00:       at Object..js (node:internal/modules/cjs/loader:2060:10)
2026-11-09 18:52:34 -08:00:       at Module.load (node:internal/modules/cjs/loader:1651:32)
2026-11-09 18:52:34 -08:00:       at Module._load (node:internal/modules/cjs/loader:1443:12)
2026-11-09 18:52:34 -08:00:       at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
2026-11-09 18:52:34 -08:00:       at Module.require (node:internal/modules/cjs/loader:1674:12)
2026-11-09 18:52:34 -08:00:       at require (node:internal/modules/helpers:157:16)
2026-11-09 18:52:34 -08:00:       at Object.<anonymous> (C:\Users\condoua2a\Documents\CohesityDashboard\CohesityDashboard\backend\routes\clusters.js:3:12) {
2026-11-09 18:52:34 -08:00:     code: 'SQLITE_CONSTRAINT_PRIMARYKEY'
2026-11-09 18:52:34 -08:00:   }
2026-11-09 18:52:34 -08:00: }