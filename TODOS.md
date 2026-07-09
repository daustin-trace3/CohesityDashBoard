# TODOS

## OIDC/SSO login support
- **What:** Add OIDC (optionally LDAP/AD) login alongside local users.
- **Why:** Enterprise ICC buyers will require SSO; `auth_provider` column on `users` is reserved for this so it bolts on without schema rework.
- **Pros:** Unlocks enterprise deals; designed-for slot means low rework.
- **Cons:** Real integration/testing effort against varied IdPs; zero value until a customer asks.
- **Context (added 2026-07-09, plan-eng-review):** Phase 1.5 of the ICC plugin-architecture plan ships local auth (argon2, SQLite sessions, CSRF, first-run claim-token wizard). Start point: openid-client, map claims → user row, IdP group claim → ICC groups so RBAC grants apply unchanged.
- **Depends on:** Phase 1.5 (auth/RBAC) shipped.

## True hot-upgrade / hot-remove of plugins
- **What:** Replace "upgrade/uninstall takes effect on restart" with live module replacement (ESM cache-busted imports, poller stop+drain, live staged-dir swap).
- **Why:** Removes the last restart from the plugin lifecycle.
- **Pros:** Fully live plugin management.
- **Cons:** Node module-cache surgery is fragile; VS Code-style restart semantics are already customer-acceptable.
- **Context (added 2026-07-09, plan-eng-review):** v1 deliberately ships hot-ADD on install + restart on upgrade/remove. The dispatcher registry already supports live swap; the hard parts are CJS/ESM cache invalidation and draining in-flight poller work. Windows upgrades use staged-directory swap-on-boot — extend that to swap-live.
- **Depends on:** Phase 2 shipped and stable.

## Core migration follow-through
- **What:** After Phase 1 lands, delete the legacy guarded ALTER-TABLE block in backend/db/database.js once all installs have crossed the versioned-migration boundary.
- **Context:** Core unifies onto versioned migrations in Phase 1 (decision 7A); the legacy block stays temporarily for pre-upgrade DBs.
