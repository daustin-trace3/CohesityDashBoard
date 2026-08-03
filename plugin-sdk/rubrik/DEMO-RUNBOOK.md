# Rubrik Plugin — Customer Demo Runbook

Demo story: "the dashboard doesn't know Rubrik → we install a signed plugin live → a full
Rubrik platform appears with data, no reload, no restart."

## Files
- `rubrik-2.1.0.iccplugin` — the signed installable (also staged at `%USERPROFILE%\Desktop\`).
  v2.1 rebuilt Overview / Backup History / Protected Objects / Settings as SOURCE-LEVEL
  clones of the Cohesity pages (built from Dashboard.jsx/BackupHistoryPage.jsx/
  ServerStatusPage.jsx/SettingsPage.jsx, not summaries), added the Object 360 drill-in
  page (`/rubrik/object-360?name=` — object names link to it from Backup History and
  Protected Objects), a real `/insights` rule engine feeding an Intelligent Insights
  panel, capacity growth forecast table (days/date to 85%/90%), and Chrome-autofill
  defenses on the Settings credential fields.
  v2.0 was the first COHESITY-PARITY dashboard: 19 pages/routes across Monitor / Protect /
  Reporting / Security / Infrastructure / System, deliberately mirroring the Cohesity
  platform's pages so "only the accent color tells you where you are": Overview (KPI strip,
  storage donut, capacity-growth forecast, cluster health cards), Alerts (full triage w/
  bulk resolve/dismiss), Licensing (3 donut meters), Data Protection (risk scores, SLA
  compliance, failure analysis), Workloads (+180d trends), Replication (runs w/ progress
  bars + topology/archival), SLA Domains, Governance (tabbed audits), Backup History
  (searchable per-server bubble matrix + run-detail modal), Reporting (executive report,
  printable), Analytics (animated replication meshes w/ flowing packets), Sources (tile-
  filtered inventory), Threat Monitoring (RICHER than Cohesity — Radar + IOC hunts),
  Events, Clusters (accordion + node detail), Forecast, Settings (RSC/CDM connections).
  Styling via a plugin-injected stylesheet cloned from the host design system (CSP-legal);
  charts are self-contained SVG; all data seeds from the plugin's own migrations (30d
  protection runs, alerts, licensing meters, workload history — nothing depends on host data).
  Rebuild after source changes: `cd plugin-sdk && node build.mjs --dir ./rubrik && node pack.mjs --dir ./rubrik`
  (signing key: `../LicenseTools/keys/plugin-signing-private.pem`).

## The demo (on https://cc.austihome.com, login demo / IccDemo2026!)
1. **Absent**: show the platform switcher — no Rubrik. Optionally hit Plugins page
   (gear → Plugins): only built-ins listed.
2. **Install**: drag `rubrik-2.1.0.iccplugin` onto the Plugins page upload target.
   Toast: installed and live ("hot add"). Signature + per-file hashes verified server-side.
3. **Appears**: Rubrik shows up in the platform switcher immediately — no reload
   (a `platforms-changed` event refreshes the platform registry live).
4. **Data**: click Rubrik → Overview (3 clusters, 30 protected objects, 2 out of
   compliance, 24h jobs w/ 2 failures, capacity bar), then Clusters / Protected
   Objects / Jobs pages. Data comes from the plugin's own migration-seeded tables.
5. Optional second beat: Global Settings → Platforms → toggle a full built-in
   (e.g. Zerto) off and on — shows a complete, fully-styled platform materializing
   with rich data. Complements the plugin story ("plugins for new platforms,
   toggles for licensed ones").

## Reset between customer sessions
Uninstall is restart-gated (marks `.remove`, applied at next boot):
```
ssh DevServer
# in a login shell:
cd /tmp && curl -s -c cj.txt -X POST -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"IccDemo2026!"}' http://localhost:3002/api/auth/login -o /dev/null
TOK=$(curl -s -b cj.txt http://localhost:3002/api/auth/session | python3 -c "import json,sys; print(json.load(sys.stdin)['csrfToken'])")
curl -s -b cj.txt -H "x-csrf-token: $TOK" -X DELETE http://localhost:3002/api/plugins/rubrik
pm2 restart icc-demo && rm cj.txt
```
Or from the UI: Plugins page → trash icon on Rubrik → restart icc-demo.
Leave "also delete its data" UNCHECKED — the rubrik_* tables then survive, so the next
install shows data instantly (migration is versioned and skips re-seeding).

## Gotchas learned bringing this live (2026-08-02)
- Mutating API calls need the CSRF token from `GET /api/auth/session` in `x-csrf-token`.
- Host fix `0fb3e89`/`4c9fd3c` was REQUIRED: before it, any plugin platform blanked the
  whole app (Layout rendered `<undefined/>` for icon-less plugin nav items, React #130)
  and the header fell through to Cohesity labels. Don't demo from a build older than these.
- Unknown `/api/<id>/*` returns 200 with index.html (SPA fallback), not 404 — don't use
  curl status alone to prove absence; check `GET /api/plugins`.
- Plugin pages use inline styles (no Tailwind in bundles) — the Rubrik pages are styled
  to match the host closely; keep that discipline in edits.
