# ENG REVIEW — Cohesity → .iccplugin conversion (campaign decision D2, final wave)

Reviewed 2026-08-18 on `feat/plugin-touchpoints` (read-only). Verdict: **GO — conditional** (see §6).

## 0. Why Cohesity is structurally different

Cohesity is **not a registry platform**. No `backend/platforms/cohesity/` manifest; it is wired as:
- 18 routers statically required in `backend/app.js`, mounted twice — under `/api/cohesity/*` AND at 14 legacy unprefixed aliases (`/api/clusters`, `/api/metrics`, `/api/alerts`, …) via `middleware/deprecatedAlias.js` ("temporary compat for customer automation" — contractually load-bearing).
- Four independent schedulers started directly in `server.js` / `pollerProcess.js` (`initPoller`, `initLicensing`, `initViews`, `initGflags`) — never through the registry.
- **Unprefixed table names** (`clusters`, `alerts`, `metrics_history`, `protection_runs`, `license_*`, …) read directly by core migrations, SQL views, anonymizer, ops, search, server360, and even the vCenter demo generator.
- `'cohesity'` is in `RESERVED_IDS` (`backend/core/registry.js:12`) — as the code stands, a cohesity .iccplugin **cannot even be verified or registered**.

## 1. Extraction inventory

**Registration:** legacy direct mounts in `app.js:146–186` (18 permission-wrapped mounts + 14 alias mounts + special `/api/poller`). Migrations run inline in `db/database.js` (scope `cohesity` — pack migrations with the same scope adopt existing data).

**Routes** (~4,000 lines): clusters 480, metrics 113, alerts 227, hardware 87, helios 32, import 135, analytics 620, replication 271, insights 93, governance 211, dashboard 20, advisor 51, licensing 41, views 31, workloads 79, backupHistory 246, cohesityObject360 191, gflags 103, poller 597 (status = core-facing, triggers = cohesity).

**Services:** cohesityApi 481 (axios; Helios + direct + userpass), helios 45, poller 632, snapshot 145, licensing 487 (hourly cron), views 194, gflags 167, workloads 204, insights 378, aiInsights 265, aiAdvisor 511, llm.

**Migrations/demo:** migrations/cohesity.js 486 (11 versions), demo/generators/cohesity.js 725, demo/cohesityHardwareFixtures.js 91 (required directly by routes/hardware.js), seedDemo wiring.

**Backend total ≈ 8,000 lines; frontend ≈ 9,700 lines (18+ pages, most statically imported by App.jsx at unprefixed routes). ~2× the largest prior wave.**

**Legacy alias paths that must keep working:** /api/clusters, /api/metrics, /api/alerts, /api/hardware, /api/helios, /api/import, /api/analytics, /api/replication, /api/insights, /api/governance, /api/dashboard, /api/advisor, /api/licensing, /api/poller/* (triggers). Pinned by cohesityAliases/characterization/rbacEnforcement/authOptional/license-gate/demoMode tests.

## 2. Core couplings (why D2 said "last")

1. **Product licensing vs cohesity licensing** — name collision, different owners. Ed25519 product plane (`services/license.js`, `middleware/license.js`, LicenseGate.jsx) **stays core**; cohesity license meters (services/licensing.js + 4 `license_*` tables + LicensingPage) move.
2. **Gflags:** own scheduler, routes, tables, ops.js exception, GflagsPage 482.
3. **Hardware/estate:** routes/hardware.js does live node/chassis fetches and requires the demo fixtures module directly. External estate-review tooling talks to Helios directly — no dashboard-API consumer risk.
4. **Server 360:** `routes/server360.js:15` hardcodes cohesity-enabled; reads `cohesity_objects`/`cohesity_agents`/`clusters` inline. Frontend ServerStatusPage has a hardcoded Backup panel.
5. **Anonymizer** builds CLUSTER/JOB/VIEW/IP dictionaries from cohesity tables — stays core (tables-are-the-interface).
6. **Helios API key** is a core credential (settings.getHeliosApiKey).
7. **Cohesity MCP + Portal:** talk to Helios directly / no dashboard cohesity endpoints — no dependency. Only unnamed "customer automation" uses the aliases; treat as real.
8. **Dataset catalog:** cohesity datasets are core-registered (`{core:true}` bypasses the `<ns>_` prefix ownership rule); core migration v13 creates SQL views joining `clusters`. Manifest datasets over unprefixed tables would be REJECTED — keep core.
9. **Ops:** cohesitySummary + always-on card exception (ops.js:331).
10. **Search:** 4 static cohesity categories + `platformEnabled('cohesity')=true` hardcode (search.js:87).
11. **Alert notifier:** cohesity collector reads `alerts JOIN clusters`; **sourceKey format must be preserved verbatim or every open alert re-emails**.
12. **Poller status:** /api/poller/status hand-builds cohesity/licensing/views sections; frontend folds licensing into the cohesity rollup.
13. **Cross-platform demo:** vcenter demo generator INSERTs into `cohesity_objects`.
14. **useAiEnabled** (frontend) hits `/cohesity/insights/ai/config` — gates AI nav on EVERY platform. Biggest hidden landmine.
15. **RBAC:** core v4 seeds cohesity grants (adopted, idempotent). Permission drift risk R6 below.

## 3. Frontend couplings (highlights)

- `platforms/cohesity/index.jsx` is thin (88 lines, 8 routes); 10 more pages statically imported by App.jsx at unprefixed routes (/data-protection, /replication, /views, /workloads, /sources, /analytics, /governance, /reporting, /licensing, /ai-advisor, /settings).
- Layout.jsx: default enabledPlatformIds=['cohesity']; navGroups fallback; **unconditional 60s header polls of /cohesity/alerts + /cohesity/clusters driving the alert bell, cluster chip, and API-online heuristic**; NotificationBell default route; platformCohesityEnabled special default.
- App.jsx: activePlatform default 'cohesity'; host redirects into plugin routes.
- All cohesity page data calls are already `/cohesity/*`-prefixed except /poller/trigger* and /settings*.
- `border-cohesity-*` classes are theme tokens, NOT coupling — do not rename.

## 4. Risk register (ranked)

- **R1** Plugin id reserved — install/verify/register all reject; old hosts can never install the pack → marketplace `minHostVersion` required.
- **R2** Legacy alias endpoints break customer automation on naive removal.
- **R3** App-wide AI gate breaks (useAiEnabled → cohesity route).
- **R4** Layout shell degrades: header polls make a missing cohesity look like a dead API.
- **R5** Demo regressions ×3: 725-line generator, seedDemo ordering, vcenter writes into cohesity_objects, `clusters` doubles as the user-connection table (never wipe; upsert-by-name), hardware fixtures required directly.
- **R6** RBAC permission drift under the dispatcher: backup-history/object-360 share `cohesity:workloads:*` today; the generic mapping would mint new permission names. Wildcard grants fine; custom fine-grained grants silently lose access. Alias shim must apply the SAME permission as the prefixed mount (C8.6).
- **R7** Poller-status shape loss breaks Live/Stale chips + licensing freshness card.
- **R8** plugins.js synthetic cohesityRow vs real plugin row (same-id shadow class).
- **R9** Ops always-on card must become an opsSummary hook with exact headline labels.
- **R10** Alert-email dedupe reset if sourceKey changes → notification storm.
- **R11** Dataset catalog rejects unprefixed manifest datasets — keep core.
- **R12** Fresh-install ordering: core SQL views + queries against tables that don't exist until the pack installs — a state no instance has ever been in; must be tested.
- **R13** Sandbox scale: ~9.7k frontend lines into a ui.jsx clone; 481-line axios client (bundleable per AWS devDeps precedent or https rewrite). Budget real QA.

## 5. Recommended approach

**STAY CORE:** product licensing · auth/RBAC/CSRF · /ops shell · /api/poller/status endpoint · anonymizer · coreDatasets cohesity datasets + v13 views · settings credential store incl. helios_api_key · SearchContext/GlobalSearch shell · registry entitlement cohesity→true · AI audit, llmProvider.

**MOVE INTO PACK:** all 18 routers (+poller triggers), 12 services, migrations verbatim (scope cohesity), demo generator + hardware fixtures as demoSeed, hooks: opsSummary, collectAlerts (verbatim sourceKeys), searchCategories (4), server360/server360Suggest, statusTables:['clusters'], embedded logo. Datasets omitted (stay core).

**RELOCATE WITHIN CORE (WP0):** GET ai/config → core `/api/settings/ai-config` + repoint useAiEnabled; Layout header fetches platform-conditional; App.jsx default-platform derivation; AdminSettingsPage/plugins.js/search.js:87/server360.js:15/ops.js:331 hardcodes → registry-gated.

**Alias preservation — thin core alias shim (recommended):** table-driven forwarders in app.js keeping deprecated() + original permission per path, rewriting req.url and invoking `registry.dispatchTo('cohesity', …)`. Identical codes/shapes for free (same router); removable in the future major. Folding into the plugin is impossible (dispatcher owns only /api/:pluginId); duplicating routers forks logic.

**Work packages (plan 2 rounds):**
- **WP0** host prep release (cohesity still built-in, zero behavior change): RESERVED_IDS removal, alias-shim scaffolding + dispatchTo, ai-config core route + useAiEnabled repoint, hardcode removals, poller status/trigger split, test updates. Ship & verify parity FIRST.
- **WP-A** backend pack, data plane: manifest + migrations + cohesityApi/helios/poller/snapshot + clusters/metrics/alerts/hardware/analytics/replication/import/helios/dashboard/poller-trigger routes + demoSeed.
- **WP-B** backend pack, features plane: licensing/views/gflags/workloads/backupHistory/object360/governance/insights/advisor + hooks + advisor via coreApi.
- **WP-C** frontend pack 1 (monitor/infra): Dashboard, Alerts, Clusters, Hardware, Gflags, Settings + ui.jsx clone.
- **WP-D** frontend pack 2 (protect/reporting): DataProtection, Workloads, Replication, Views, Governance, BackupHistory, Object360, Analytics, Licensing, Sources, Reporting, AIAdvisor.
- **WP-E** core removal + 18-point worktree rehearsal + demo marketplace-ready state.
Seam check: diff WP-C/D apiFetch lists against WP-A/B route tables.

**Defer:** alias removal itself (future major); dataset-catalog manifest migration (needs a coreTables escape hatch); Reporting expansion.

## 6. Go / no-go

**GO — conditional:**
1. WP0 ships and soaks first as a normal host release; no pack work lands until parity verified.
2. RESERVED_IDS + alias shim + useAiEnabled repoint are non-negotiable blockers (R1–R4).
3. Mandatory rehearsal gates: fresh-DB boot WITHOUT the pack (R12); scratch-DB double-seed of the demo generator (R5); standard 18-point worktree rehearsal + post-install browser QA.
4. Marketplace listing pins `minHostVersion` to the WP0 release; demo reaches marketplace-ready state via uninstall-without-purge only.
5. Accept + document R6 permission drift (or seed the two extra grants in WP0).

Critical files: backend/app.js, backend/core/registry.js, backend/routes/poller.js, frontend/src/components/Layout.jsx, frontend/src/platforms/cohesity/index.jsx.
