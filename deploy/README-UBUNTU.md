# ICC on Ubuntu

Tested 2026-09-09 on Ubuntu 24.04 (fresh install and upgrade). Should work
on 22.04 as well; argon2's prebuilt binary needs glibc 2.34 or newer, which
both releases have. Do not use this path for RHEL 8, see the RPM plan.

## Build the package (Windows dev box)

    .\scripts\package-ubuntu.ps1

Output: `..\icc-dashboard-<version>-<timestamp>.tar.gz` (about 9 MB). It holds
the working tree, a fresh `frontend/dist`, and `deploy/`. It never holds
`.env`, the SQLite data, installed plugin packs, logs or `node_modules`.

Options:

- `-SkipBuild` reuses the existing `frontend/dist`.
- `-BundleNode` adds a Node 24 linux-x64 tarball so the host never reaches
  nodejs.org. Adds about 30 MB.
- `-WithDeps <path>` vendors a `backend/node_modules` tree that was built on
  an Ubuntu host (`cd backend; npm ci --omit=dev`) so the host never runs npm.
  Not yet exercised end to end.

With both options the package installs on a host with no internet access.

## Install or upgrade (Ubuntu host)

    scp icc-dashboard-*.tar.gz user@host:/tmp/
    sudo bash -c 'rm -rf /tmp/icc && mkdir -p /tmp/icc && tar -xzf /tmp/icc-dashboard-*.tar.gz -C /tmp/icc && bash /tmp/icc/deploy/install.sh'

Useful flags on the first run:

    --license-key CDBL-...    writes LICENSE_KEY into .env
    --trust-proxy 1           behind nginx or Cloudflare
    --port 3001               listen port

The same command upgrades an existing install. The installer detects
`/opt/cohesity-dashboard/.env`, stops the units, backs up `backend/data`
(keeps five), overlays the code, reinstalls dependencies, and restarts.
`.env`, `frontend/.env.local`, `backend/data`, `backend/plugins` and `logs`
are never overwritten.

## What the installer sets up

- App under `/opt/cohesity-dashboard`, owned by system user `cohesity`.
- A private Node 24 runtime under `/opt/cohesity-dashboard/node`. Nothing is
  installed system-wide and apt is not touched.
- `cohesity-dashboard.service` (API and UI) and `cohesity-poller.service`
  (collectors). The API starts first and runs the migrations; the poller
  starts once `/health` answers.
- A generated `.env` with fresh `ENCRYPTION_KEY` and `DASHBOARD_API_KEY`.
  Keep this file; losing `ENCRYPTION_KEY` makes stored credentials
  unreadable.

On a fresh install the script prints the first-run claim token. Enter it at
`/login` to create the admin account. Without `LICENSE_KEY` the UI stays
locked; add it to `.env` and restart both units.

## Day two

    systemctl status cohesity-dashboard cohesity-poller
    journalctl -u cohesity-poller -n 50 --no-pager
    curl -s localhost:3001/health

Override the defaults with `--app-dir`, `--user`, `--service-prefix` to run
a second copy beside the first, for example a test instance on another port.
