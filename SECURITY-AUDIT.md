# Security audit, ICC dashboard

Date: 2026-09-18 and 2026-09-19. Branch audited: feat/plugin-touchpoints at dff1f44. Fixes are on
sec/hardening-2026-09, with a port for production on sec/hardening-icc-phase1.

On this branch (the icc-phase1 port) NetBackup is a built-in router and was fixed here directly; plugin
pack changes, UniFi and the demo guard do not apply because this branch does not carry them.

This file replaces the audit dated 2026-07-22. Most of that audit's list was still open when this one
started; the status of each old item is in the last section. This file is excluded from the customer
package.

## How it was done

Six read-only reviews ran in parallel, each over one area: authentication and RBAC, data exposure across
platforms, stored credentials and secrets, injection and outbound requests, the AI data path and the
frontend, and the plugin supply chain with deployment. Every finding below was confirmed by reading the code
path. Fixes were then written with tests that fail on the old code. Two findings were confirmed by two
reviewers independently (the credential forwarding and the plugin id traversal).

What was not done: no test against a live production ICC, no test against a live AD forest, no review of the
Portal repo, and no penetration test of the hosts themselves. Items that depend on those are marked
unverified.

## Results at a glance

| Area | Before | After |
|---|---|---|
| npm audit, backend | 14 advisories, 6 high | 0 |
| npm audit, frontend | 16 advisories, 7 high | 0 |
| Backend tests | 567 pass, 1 fail | 1146 pass |
| Frontend tests | 62 pass | 79 pass |
| Scanner probes (/.env, /.git/config) | 200 with the app shell | 404 |
| Open findings, high | 9 | 0 in code, 3 need a decision |

## Findings that were fixed

### High

H1. Saved platform credentials could be sent to a host the caller chose. "Test connection" took the id of a
saved source and a different host in the body, decrypted the saved password and signed in to that host. A
PUT that changed only the host kept the saved password, and the next poll delivered it. Anyone holding manage
on one platform could collect that platform's service account password. This applied to vCenter, Dell, Aria,
Aria Operations, Zerto, Brocade (including FOS overrides), NetApp, Pure, Cohesity, Proxmox, NetBackup, Rubrik
and Nutanix, in the built-in routers and the plugin packs, and in a milder form to SMTP and the AD bind
account. Fixed: a saved secret is only ever used against the saved address; changing the address needs the
secret typed again. See backend/utils/connectionGuard.js and the credForward tests.

H2. The cross-platform pages ignored per-platform permissions. Service Status, App Services, the ops summary,
poller status and DNS lookups were reachable to any authenticated caller, including a service-account key
with no grants. That exposed alert text, host names, IPs, WWNs, source names, AWS spend and stored AI
evidence for every platform. Fixed: each handler filters by the caller's own grants, and AI narratives
written from evidence the caller cannot view are withheld.

H3. An uninstall request could queue a recursive delete of the backend folder. DELETE /api/plugins/%2e%2e
wrote a marker named "...remove"; at next boot the id became ".." and the plugins parent directory (code,
node_modules, the database and its backups) was removed. It needed admin:plugins:manage, or nothing at all
on a fresh install in open-access mode. Fixed in the route and again in the boot swap.

H4. The error handler wrote credentials to the log. A failed platform call reaches the handler as an axios
error whose config holds the Authorization header, API key headers, Basic auth and the login body. Any
view-level user could trigger it while a platform was failing. Fixed in the logger itself, so every call
site and every plugin pack is covered.

H5. A fresh install was open to the network. With no accounts and no explicit setting, every caller that
could reach the port was a full administrator, on a server listening on all interfaces. Fixed: that implicit
open access is limited to callers on the machine itself; everyone else completes first-run setup with the
claim token. An explicit "sign-in off" still applies to all and is logged hourly as an error.

H6. admin:users:manage was a path to full admin through five routes: granting any permission, adding oneself
to the Admin group, resetting an admin's password, minting a *:*:* service key, and switching sign-in off.
Fixed: nobody can hand out or act on more access than they hold; switching sign-in off needs *:*:*.

### Medium

- Sessions: the database stored session ids in clear, so reading the database file was a session takeover.
  Now it stores a hash. Added a hard 30 day lifetime, and a password reset ends every session of that account.
- Active Directory: a user could sign in as another account's sAMAccountName through an alternate UPN
  suffix. The scheduled AD group sync never ran in the default two-process deployment, so a user removed
  from an AD group kept access until a manual sync. Both fixed.
- Login: the lockout was keyed on the raw string, so case and DOMAIN prefix variants each got a fresh set of
  tries, and 10,000 made-up names cleared every lockout. Unknown users answered faster than real ones.
  icc-phase1 had no per-account lockout at all. All fixed.
- install-from-url accepted any http or https URL, followed redirects anywhere and returned transport error
  text, which made it a blind request primitive and a port scanner. Now https only, host allowlist, every
  redirect hop checked, one generic error.
- Plugin purge used an unescaped LIKE pattern: purging "aria" also dropped every ariaops table, and "pure"
  every pure1 table. Fixed.
- Older signed plugin versions could be installed over newer ones. Now refused unless explicitly allowed.
- Core names such as "admin" were not reserved plugin ids; a pack with id "admin" would have seeded
  admin:*:* to the Operator group. Fixed.
- Host blocklists were three copies of a regex list that these all passed: x@127.0.0.1, localhost.,
  [::1], 2130706433, 0x7f.0.0.1, [::ffff:169.254.169.254]. Replaced by one guard that checks resolved
  addresses. RFC1918 stays allowed on purpose: ICC monitors internal infrastructure.
- Test-connection results echoed transport text such as "connect ECONNREFUSED 10.1.2.3:22", which made the
  test routes an internal port scanner. Now a small fixed set of messages.
- Anyone could trigger manual AI analysis without limit, spending LLM budget and overwriting stored
  analyses. Now needs manage on the platform, honours the AI switch, a per-event cooldown and the cap.
- The model could override ICC's verdict with nothing but a stated reason, and the prompt carries untrusted
  platform text. Now no override of ICC's own reachability events or of high-confidence evidence.
- Anonymizer gaps before data leaves for the LLM: Dell service tags, Brocade zonesets, BlueCat
  configurations, App Services ids and names, EBS volume ids, AWS ARNs and account ids, 8-octet WWNs
  (which also restored corrupted), URL userinfo, and the operator context on the Service Status path.
- A read-only all-platform key ("*:*:view", the grant the API guide recommends for AI agents) could read
  users, settings and the AI audit store with its de-anonymisation map. The admin namespace is no longer
  reachable through a namespace wildcard other than *:*:*.
- Plugins were handed the raw AES key through coreApi. They now get encrypt and decrypt only.
- Ubuntu install: the database and its backups were world-readable, .env was created before its mode was
  set, the downloaded Node tarball was never verified, and the customer package shipped the old audit, the
  demo login, tests and internal notes. All fixed.

### Low

GET requests that act (probes with stored credentials, the billable AWS cost probe, refresh=1) now need
manage. CSRF and claim-token compares are constant time. GCM tags must be full length. An innerHTML sink in
the AWS cost tooltip and unvalidated Pure1 knowledge-base links are fixed. The login returnTo parameter
accepts only same-origin paths. CSP names its sources instead of "https:", a Permissions-Policy header is
sent, CORS no longer hardcodes a LAN address. Licence entitlement is re-checked per request. A placeholder
DASHBOARD_API_KEY is ignored at boot. The demo seeder refuses to wipe a database that is not a demo database.

### Demo mode

The public demo signs visitors in with a documented admin account. Until now that account could make the
demo host open connections to any address (connection tests, probes, AD and SMTP settings, reverse DNS),
which is a way into the network the demo host sits on. Demo mode now refuses all of those, and the shared
demo sign-in cannot have its password changed, be deactivated or deleted, and sign-in cannot be switched off.

## Open items that need a decision

D1. Signing keys. The licence key and the plugin signing key are unencrypted PEM files under
LicenseTools\keys on the development machine. A plugin pack is unsandboxed code in the API and poller
processes with the database handle and decrypt, so whoever holds the plugin signing key can run code on every
ICC install that accepts their pack. There is one trusted key, no key id, no revocation and no expiry.
Recommended: put both keys behind a passphrase or a hardware token, add a second trusted key and a revoked
list to the host, and rotate if this machine was ever shared.

D2. A production probe dump is still in git. backend/scripts/dell-audit-probe.json (1.26 MB, a live OME
compliance dump with device names, template names and usernames, no passwords found) is tracked at the tip
of icc-phase1 locally and on the remote as last fetched. The project notes say it was purged. Removing it
needs a history rewrite and a force push, which needs approval.

D3. NetApp AIQUM certificate checking cannot be turned on: netapp_aiqum_instances has no ssl_verify column,
so the client, which now honours the flag, has nothing to read. Needs a migration and a UI toggle.

D4. Service-account keys have no expiry and no rotate route.

D5. The demo account is a full administrator by choice. Demo mode now limits what that can reach, but a
Viewer or Operator demo account would be a smaller target.

D6. The marketplace server change (CSP on, Permissions-Policy, 404 for dotfiles) is committed locally in the
Marketplace repo and not deployed, because deploying it needs a restart of that service. About 25 zero-byte
junk files are committed in that repo; removing them needs approval. scripts/publish.mjs does not verify a
pack signature before publishing.

D7. Validation errors echo the submitted value back to the sender (express-validator errors.array()), which
includes a password the sender just typed. Low, and it touches every router.

D8. On icc-phase1 the poller systemd unit has no User= line, so as written it runs as root.

## Unverified

- Whether the AD sign-in issue was exploitable depends on the forest: it needs a DC that accepts a bind
  with a UPN from another suffix and a colliding sAMAccountName. The fix does not depend on the answer.
- File modes and TRUST_PROXY on the RHEL production host were not inspected.
- The Cohesity plugin pack could not be loaded by the test harness in the worktree (missing dependency), so
  its change mirrors the host change by reading and passed a syntax check only.
- Whether copies of the signing keys exist on other hosts.

## Operational notes for the upgrade

- Everyone signs in again once: stored session ids are now hashes.
- A key holding "*:*:view" loses read access to users, settings, plugins and the AI audit store. Give it an
  explicit admin:<section>:view grant if that was intended.
- Editing a source and changing its address now needs the password or token typed again. Testing a saved
  source with a blank password tests the saved address.
- Viewers can no longer re-run an AI analysis or trigger probes and forced refreshes; Operators can.
- New optional settings in .env.example: BIND_ADDRESS, HTTPS_ONLY, COOKIE_SECURE, CORS_ORIGINS,
  PLUGIN_INSTALL_ALLOWED_HOSTS. A developer who used the Vite dev server from 172.17.16.113 needs
  CORS_ORIGINS for it.
- Local passwords need 8 characters. Existing passwords keep working.
- Plugin packs changed: aria 1.0.4, ariaops 1.0.2, aws 1.0.3, bluecat 1.0.1, brocade 1.0.2, cohesity 1.0.2,
  dell 1.0.8, netapp 1.0.2, netbackup 1.0.3, nutanix 1.0.3, proxmox 1.2.4, pure 1.0.4, rubrik 2.4.6,
  unifi 1.0.5, vcenter 1.1.14, zerto 1.0.2. None is published to the marketplace yet. Until they are,
  any instance running the older published packs still has the credential forwarding issue in those packs.

## Status of the 2026-07-22 items

| Item | Status now |
|---|---|
| H1 dependency CVEs | Fixed, both audits at zero |
| H2 SSRF guard missing on vCenter, Dell, Zerto | Fixed, shared guard on every platform |
| H3 cookie Secure flag and rate-limit key behind a proxy | TRUST_PROXY existed; COOKIE_SECURE added |
| M1 string denylist bypassable | Fixed, guard checks resolved addresses |
| M2 TLS verification off by default | Partly: AIQUM honours the flag, omitted flag no longer resets to off. Default for new sources is still off (self-signed estates); see D3 |
| M3 privilege escalation via grants | Fixed, and four more routes to the same result |
| M4 no absolute session lifetime | Fixed, 30 days |
| M5 password change keeps sessions | Fixed |
| M6 login user enumeration by timing | Fixed |
| M7 no account lockout | Was added on the feature branch; normalised here and added to icc-phase1 |
| L1 signing keys on the dev box | Open, see D1 |
| L2 plugin :id path guard | Fixed; it was worse than rated, see H3 |
| L3 CSV import leaks error text | Fixed |
| L4 returnTo redirect | Fixed |
| L5 service keys never expire | Open, see D4 |
| L6 constant-time compares | Fixed. The claim token is still logged: that is how the operator receives it |
| L7 hardcoded LAN IP in CORS, CSP relaxations | Fixed |
