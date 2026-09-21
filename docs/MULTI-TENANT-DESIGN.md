# Multi-tenant ICC: decisions and build order

Status: decisions taken by Doug on 2026-09-21. Build happens on branch
feat/multi-tenant (off feat/plugin-touchpoints). icc-phase1 and the ICC box stay
single-tenant and do not receive this work.

The driver is an MSP running one install for many customers. One URL, one login,
a tenant switcher. Customer data never crosses tenants. User accounts are the
only thing shared.

## Decisions

1. Separation. One SQLite file per tenant, plus one global database. No tenant
   columns and no per-tenant table prefixes. Queries cannot join across tenants
   because the data is not in the same database.
2. Tenant selection. The tenant is in the URL (/t/<tenant>/...) and is sent on
   every API call. The server checks it against the caller's memberships on
   every request. Two browser tabs can show two tenants.
3. Global data: users, sessions, tenant list, memberships, global audit log,
   installed plugin packs. Everything else is per tenant: platform connections
   and credentials, polled data, alerts, Service Status, App Services watch
   list, custom dashboards, groups, role grants, API keys, AI audit log,
   anonymizer token maps, SMTP settings, AI provider settings, licence. SMTP
   and AI settings do not inherit from anywhere.
4. Encryption. One key per tenant, derived from the install's master key and
   the tenant id. A tenant database copied into another tenant cannot be
   decrypted.
5. Scale. Unknown, MSP sized. Design for tens of tenants per install and do not
   assume a small fixed number anywhere.
6. Branching. Long-lived branch off feat/plugin-touchpoints. No runtime switch
   between a single-tenant and a multi-tenant code path: a single-tenant install
   is an install with one tenant named "default" whose database is the existing
   file.
7. Roles are per tenant. A user can be an admin in one tenant and a viewer in
   another. There is also a global admin role for MSP staff. A global admin can
   create and manage tenants and has admin rights inside every tenant without
   being added to each one. Every entry of a global admin into a tenant is
   written to the global audit log.
8. Everyone else must be added to a tenant to see it. A newly added user is a
   viewer. A tenant admin, or a member of the tenant admin group, grants
   anything more.
9. No cross-tenant view in version 1. An MSP overview page may come later and
   would show status counts only, never tenant data.
10. Active Directory is global in version 1: one directory, an AD group maps to
    a tenant plus a role. NOTE, expected soon: customers will want their own
    staff to sign in with their own directory. That needs a directory per
    tenant and a way to pick the directory at sign-in (by tenant URL). Keep the
    directory code free of assumptions that block this.
11. Auth switched off (open-access mode) and more than one tenant cannot
    coexist. The server refuses to create a second tenant while auth is off.
12. Plugin packs are installed once per install, by a global admin. Each tenant
    has a list of platforms it is entitled to. At tenant setup the platforms the
    customer wants are selected and enabled; more can be added later through the
    normal pack download and install flow, then entitled and enabled for that
    tenant. A tenant admin can only enable entitled platforms. On the demo every
    tenant is entitled to everything. Pack migrations run in each tenant's
    database. A pack upgrade applies to every tenant at the same restart.
13. Polling. Doug's rule: if there is any chance one tenant can hold up another,
    use separate workers. A single poller process cannot give that guarantee:
    the SQLite driver is synchronous and Node runs one thread, so one tenant's
    large write or heavy reconcile blocks every other tenant in that process.
    Decision: one poller worker process per tenant, started and supervised by a
    small parent. A crashed worker restarts alone. A suspended tenant has no
    worker. Cost: memory per tenant. Measured in the spike on 2026-09-21: about
    80 MB for an idle worker (57 MB Node, 8 MB open database, 14 MB poller
    code), so roughly 4 GB idle for 50 tenants. A worker polling a large estate
    will use more; that is not measured yet.
    Known limit: the web process is still shared. A slow report for one tenant
    delays other tenants' requests by that query's duration. If that becomes
    visible, the same worker split applies to the web tier later.
14. Licence: one per tenant, stored in the tenant database.
15. Tenant lifecycle.
    - Create: a global admin names the tenant and picks its platforms. The
      system creates the database, runs every migration, creates the default
      groups (tenant admins, viewers) and their grants, writes default settings,
      enables the chosen platforms and assigns the first tenant admin. No
      connections, no data. Demo tenants can also be seeded with demo data.
    - Licence expiry: a bar on every page for every user of the tenant, yellow
      from 90 days before expiry, red from 30 days.
    - Suspended (licence expired or suspended by a global admin): polling stops,
      sign-in to the tenant lands on a licence page where a licence can be
      entered. Global admins can still enter.
    - Export: on request. Proposed method: a global admin produces an encrypted
      archive containing the tenant database with saved credentials removed,
      plus CSV copies of the main inventories. The download link expires and the
      export is written to both audit logs.
    - Retention inside a live tenant (confirmed by Doug 2026-09-21): how long
      polled history is kept is configurable per tenant. History past the
      window (metrics history, resolved alerts and issues, timelines, audit
      rows past their own window) is deleted on a schedule and the run is
      written to the tenant audit log. Current inventory is never aged out.
      Today the host has several hard-coded retention windows (for example
      Dell hardware logs at 90 days); phase 4 collects them behind one per
      tenant setting with per-category overrides.
    - Retention after a tenant is closed (confirmed): when a tenant is closed
      its database is moved out of the live pool into an archive on the same
      system (a zip of the database plus the export CSVs, encrypted with the
      tenant key), not reachable from the UI, so closed tenants stop costing
      database size and open handles. The archive is kept for a configurable
      period and then deleted, with the deletion written to the global audit
      log. A closed tenant can be restored from its archive while it exists.
16. Two audit logs: one per tenant (what happened inside it) and one global
    (sign-ins, tenant switches, global admin entry into tenants, tenant
    administration, exports, deletions).
17. Release gates: the two-tenant leak test passes on every GET route; code that
    touches the database with no tenant fails instead of falling back to a
    default; Doug does a browser pass on the demo.
18. Demo and portal: fold icc-tenant-a and icc-tenant-b into the demo install as
    tenants, then retire their ports and the Portal repo. Approved by Doug in
    advance. Do it last, after migration is proven.

## How it works

- backend/core/tenantContext.js holds the current tenant in AsyncLocalStorage.
  Web requests enter it from the URL after the membership check. Each poller
  worker enters it once at start.
- backend/db/database.js exports a proxy with the same surface as today's
  handle. It resolves the current tenant's handle from the context. With no
  tenant in context it throws. The roughly 200 files that use the handle do not
  change.
- backend/core/tenantRegistry.js owns the global database, the tenant list, the
  pool of open tenant handles and the derived keys.
- The real work is in-memory state: module-level caches, statements prepared at
  load time and schedulers that assume one estate. Measured on 2026-09-21: 43
  caches, 8 load-time statements, 15 scheduler sites, 103 backend files and 104
  pack files using the handle, 215 tables. Each cache is keyed by tenant or
  moved into the tenant context. With a worker per tenant, poller-side caches
  are isolated by process; web-side caches still need the audit.

## Spike result (2026-09-21)

Done on this branch: core/tenantContext.js, core/tenantRegistry.js (global
database with the tenant list, handle pool, slug check), db/openTenantDb.js (the
old database module as a function), db/database.js (the proxy) and
db/perTenant.js (statements kept per tenant database). services/pollerStatus.js
and services/dnsResolve.js were the only two modules that prepared statements at
load; both now use perTenant, and their two self-creating tables are created
when a tenant database is opened.

Findings:
- 102 transactions are created at module load (db.transaction(...) at top
  level). Each would have bound to the first tenant's database. The proxy
  resolves the tenant when a transaction runs, so none of those sites change.
- The existing backend suite passes unchanged as the default tenant (619 of
  620; the one failure is the long-standing demo seed count).
- tests/tenantIsolation.test.js proves: separate files, rows, settings and
  poller status stay in their tenant, load-time transactions follow the calling
  tenant, a failed transaction rolls back only its tenant, the tenant follows
  the work across awaits and timers, and work that names no tenant throws once a
  second tenant exists.
- The fail-closed rule is "strict from the second tenant on". With one tenant,
  work that names no tenant can only mean that tenant, which is what keeps every
  existing test and the single-tenant install working untouched. TENANT_STRICT=1
  forces the strict rule. Phase 1 should run the web-side tests under it.
- Not covered yet: in-memory caches (the settings module passed the isolation
  test, the other 42 caches are unaudited), schedulers, the plugin registry,
  encryption keys, anything in the frontend, and a cap on open handles.

## Build order

0. Spike: tenant context, registry, database proxy that fails closed, the
   existing backend suite passing as the default tenant, and a first two-tenant
   leak test. Nothing deployed.
1. State audit on the web side, tenant in the URL and the API client, leak test
   over every GET route.
2. Accounts: global database for users and sessions, memberships, global admin,
   switcher, login flow, migration of existing users, both audit logs.
3. Poller worker per tenant and its supervisor.
4. Per-tenant keys, licence, expiry bar, suspended state, entitlements and
   tenant setup.
5. Plugin packs: migrations per tenant, pack state audit.
6. Export, retention, then demo migration and retirement of the extra instances.
