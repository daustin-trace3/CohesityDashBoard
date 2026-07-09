# ICC Demo Instance

A self-contained demo build of the dashboard: same app, same code, seeded with
generic (no real customer) data across every page, running on its own pm2
process and port so it doesn't touch the live/dev database.

## Seed the demo database

From the `Dashboard/` repo root:

```bash
node backend/demo/seedDemo.js
```

This builds `backend/data/demo.db` (created automatically) with:
- 24 Cohesity clusters, 30 days of metrics, alerts, 14 days of protection +
  replication runs, policies, source registrations, and licensing data
- 6 NetApp ONTAP arrays with metrics, volumes, snapmirror relationships, etc.
- 20 Pure Storage arrays (the Settings → Direct list; live Pure page data
  comes from the in-memory demo fixtures, not the database)
- One admin user: `demo` / `IccDemo2026!`

Options:
```bash
node backend/demo/seedDemo.js --db ./path/to/other.db   # seed a different file
node backend/demo/seedDemo.js --force                   # delete existing db (+ -wal/-shm) first
```

**Re-run the seeder before every demo** — it wipes and re-inserts all seeded
tables so timestamps (metrics history, "last updated", alert ages, etc.) stay
relative to "now" instead of drifting stale.

## Start / stop the demo instance

```bash
pm2 start pm2.demo.config.js   # starts as "dashboard-demo" on port 3002
pm2 stop dashboard-demo
pm2 delete dashboard-demo
```

Do **not** run `pm2 save` after starting the demo unless you actually want it
to auto-start on every boot — leaving it unsaved keeps it a manual, on-demand
process alongside the regular dashboard instance.

## Login

- URL: `http://localhost:3002`
- Username: `demo`
- Password: `IccDemo2026!`

Because a user is already seeded, the app skips the first-run admin-claim
screen entirely.

## Licensing

The demo instance reads `LICENSE_KEY` from the shared `Dashboard/.env` file
(same as the regular dashboard) — no separate license is issued for the demo.
