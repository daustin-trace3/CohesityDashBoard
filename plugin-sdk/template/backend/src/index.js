// Demo Platform plugin manifest (ICC contract C1). This is the template
// every new plugin starts from — copy plugin-sdk/template/ and edit.
module.exports = {
  id: 'demo',
  name: 'Demo Platform',
  apiVersion: 1,
  migrations: [
    {
      version: 1,
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS demo_items (
            id         INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        const now = new Date().toISOString();
        const seed = db.prepare(
          'INSERT OR IGNORE INTO demo_items (id, name, created_at) VALUES (?, ?, ?)'
        );
        seed.run(1, 'First item', now);
        seed.run(2, 'Second item', now);
        seed.run(3, 'Third item', now);
      },
    },
  ],
  // createRouter must return a BARE (req, res, next) function — installed
  // plugins are loaded via require() on their own dist/backend/index.cjs and
  // cannot require the host's copy of express, so express Router instances
  // are off the table. coreApi could grow a lightweight Router helper later
  // (see README) but for now match req.method + req.path by hand.
  createRouter(coreApi) {
    return function demoRouter(req, res, next) {
      if (req.method === 'GET' && req.path === '/items') {
        const items = coreApi.db.prepare('SELECT * FROM demo_items ORDER BY id').all();
        res.json(items);
        return;
      }
      next();
    };
  },
  createPoller: null,
  statusTables: ['demo_items'],
};
