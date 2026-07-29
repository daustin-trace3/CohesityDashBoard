# Security Audit — CohesityDashBoard (branch `icc-phase1`)

Date: 2026-07-22. Scope: `backend/` (Express + better-sqlite3) and `frontend/` (React + Vite).
Method: dependency CVE scan (`npm audit`) + parallel deep source review (auth/RBAC, injection/SSRF, secrets/crypto/plugins, web/XSS/CORS). All source findings verified by reading code; no files edited during the audit.

## Overall posture
Strong foundation. Verified sound: argon2id hashing, 256-bit CSPRNG session tokens, deny-by-default RBAC with full route coverage, double CSRF defense (SameSite=lax + token), httpOnly cookies (no token in localStorage), AES-256-GCM credential encryption (random IV, auth-tag verified), enforced Ed25519 license verification, and a signed-zip plugin pipeline that is robust against Zip Slip / TOCTOU. **No SQL injection, command injection, path traversal, XXE, or XSS sinks found.** The real work is: patch known-CVE dependencies, close SSRF on the newer platforms, and fix proxy/cookie/TLS operational hardening.

---

## TODO — ranked remediation list

### CRITICAL / HIGH

- [ ] **H1 — Patch dependency CVEs (backend + frontend).** `npm audit`: backend 7 (2 high), frontend 8 (4 high). Key: `axios ≤1.17.0` (prototype-pollution + SSRF/DoS; in use 1.16.0), `form-data` CRLF injection, `vite 5.x` (Windows `server.fs.deny` bypass / path traversal), `undici` (TLS bypass, header injection), `esbuild` dev-server. **Fix:** bump `axios` to latest 1.x, `form-data`, `vite`→6/7, `undici`; `node-cron`→4 is a breaking change, test separately. Run `npm audit fix` (backend & frontend), then re-audit. Frontend `vite`/`esbuild`/`babel` are dev-time (lower prod risk) but still fix.

- [ ] **H2 — SSRF: add host blocklist to vCenter / Dell / Zerto connection routes.** `routes/vcenter.js` (`POST/PUT /vcenters`, `POST /vcenters/test`), `routes/dell.js` (`POST /instances`, `/instances/test`), `routes/zerto.js` (`PUT/POST /account`). Cohesity/NetApp/Pure enforce `isBlockedHost`; these three don't → authenticated user can point `host`/`baseUrl` at `169.254.169.254` (cloud metadata), `127.0.0.1:port`, or internal hosts. Zerto is worst (full attacker-controlled scheme+host+port URL). **Fix:** extract `isBlockedHost` (from `routes/netapp.js:19`) into a shared module; apply as a `.custom()` validator on all six platforms' create/update/**test** routes. Restrict Zerto `baseUrl` to `https:` and reject explicit ports.

- [ ] **H3 — Session cookie `Secure` flag disabled + rate-limit key wrong behind proxy.** `app.js` never sets `trust proxy`; `routes/auth.js:42` sets cookie `secure: !!req.secure`, which is false behind a TLS-terminating proxy → `icc_session` sent in cleartext (session-takeover on-path) and both rate limiters key on the proxy IP (all clients share one bucket; login 5/min guard degrades). **Fix:** `app.set('trust proxy', 1)` (correct hop count) before middleware; force `secure: true` in production; serve HTTPS-only. *(Flagged independently by two agents.)*

### MEDIUM

- [ ] **M1 — SSRF blocklist is a string denylist, bypassable.** `routes/clusters.js:19`, `netapp.js:19`, `pure.js:24` match the typed hostname, not resolved IP → DNS-rebinding (`evil.com`→127.0.0.1), IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and non-AWS metadata IPs bypass it. **Fix:** `dns.lookup(host, {all:true})`, check every resolved address (incl. IPv6/mapped) against loopback/link-local/ULA/metadata; pin connection to vetted IP to close rebinding TOCTOU. RFC1918 stays allowed (intentional).

- [ ] **M2 — TLS verification off by default on all platform connections.** `services/netappApi.js:70` hardcodes `rejectUnauthorized:false` (ignores `ssl_verify` column); Cohesity/Dell/vCenter/Pure/NetApp default `ssl_verify=0` → management creds MITM-able. **Fix:** make netapp AIQUM honor `array.ssl_verify`; default `ssl_verify` to `1` (opt-out for self-signed), or surface insecure state in the UI.

- [ ] **M3 — Privilege escalation via `POST /users/grants`.** `routes/users.js:244` (gated only `admin:users:manage`) lets a holder grant `*:*:*` or any permission they lack to themselves → full god-mode. **Fix:** restrict issuable grants to permissions the caller already holds, or require a higher role to grant `admin:*`/`*:*:*`.

- [ ] **M4 — No absolute session lifetime.** `services/authService.js:84` slides `expires_at` to now+7d on use → weekly-used token never expires. **Fix:** enforce a hard cap (e.g. 30d) off `created_at` regardless of sliding window.

- [ ] **M5 — Password change doesn't invalidate sessions.** `routes/users.js:99` updates `password_hash` but leaves `auth_sessions` rows valid → reset after compromise doesn't evict the attacker. **Fix:** `DELETE FROM auth_sessions WHERE user_id=?` on password change (optionally keep caller's own).

- [ ] **M6 — Login user-enumeration oracle.** `routes/auth.js:113` skips argon2 for unknown/inactive users → timing distinguishes valid usernames. **Fix:** always verify against a dummy hash before returning the generic error.

- [ ] **M7 — Brute-force control is per-IP only, no account lockout.** `routes/auth.js:23` (5/min per IP). **Fix:** add per-username failed-attempt tracking with backoff/lockout (depends on H3 for a trustworthy IP key).

### LOW / DEFENSE-IN-DEPTH

- [ ] **L1 — Move private signing keys off the dev/build box.** `LicenseTools/keys/private.pem` + `plugin-signing-private.pem` (gitignored, not committed — verified). Plugin-signing key = RCE if leaked (signed plugin runs arbitrary Node). **Fix:** move both to a secrets manager/HSM; repo needs only the public keys. Rotate if the box was ever shared.
- [ ] **L2 — Add `/^[a-z0-9-]+$/` id guard to plugin `:id` routes.** `routes/plugins.js` DELETE `/:id` and `bundle.js` use raw `req.params.id` in `path.join` (installer validates, these don't) → encoded `../` traversal by an admin. **Fix:** validate id at top of each handler (mirror installer `ID_PATTERN`).
- [ ] **L3 — CSV import leaks `err.message` to client.** `routes/import.js:107` returns SQLite error detail. **Fix:** drop `detail`, route via central `errorHandler`.
- [ ] **L4 — Validate `returnTo` login redirect param.** `frontend/src/pages/LoginPage.jsx` passes it to `navigate()` unchecked (react-router mostly blocks off-site). **Fix:** accept only values matching `/^\/(?!\/)/`.
- [ ] **L5 — Service-account keys never expire / can't rotate.** `routes/users.js:302`. **Fix:** add optional expiry + rotate endpoint.
- [ ] **L6 — Constant-time compares + claim-token logging.** Use `crypto.timingSafeEqual` in `middleware/csrf.js:9` and `routes/auth.js:74`; stop `logger.warn`-ing the setup claim token (`authService.js:118`).
- [ ] **L7 — Remove hardcoded LAN IP `172.17.16.113` from CORS allowlist** (`app.js:75`); drive from env. Re-enable `upgradeInsecureRequests` / COOP in helmet once HTTPS-only.

### INFO (no action required)
- Pre-auth `/api/license/activate|extension` on an unlicensed install is intentional bootstrap; safe because payloads must pass Ed25519 verify and the key is regex-constrained before the `.env` write.
- Offline license validity depends on server wall-clock (host access required to abuse) — inherent to offline licensing.

---

## Verified secure (checked, no issue)
SQL injection · command injection · path traversal · XXE · XSS (no `dangerouslySetInnerHTML`/`innerHTML`/`eval`) · encryption (AES-256-GCM, random IV, auth-tag verified) · secret exposure in API/logs · license signature enforcement · plugin Zip Slip / signature / TOCTOU · session fixation · IDOR on user routes · no committed secrets (`.env`, `*.db`, `*.pem` all untracked).
