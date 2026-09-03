#!/usr/bin/env bash
#
# Apply an update package to an existing Cohesity Dashboard install WITHOUT
# touching secrets. This NEVER writes .env or frontend/.env.local, so the
# DASHBOARD_API_KEY (and every other secret) is left exactly as-is.
#
# Run as root (dzdo, not sudo):
#   dzdo bash deploy/update.sh /tmp/cohesity-update-<timestamp>.tar.gz
#
# What it does:
#   1. Backs up backend/data (SQLite DB), keeping only the 5 most recent backups
#   2. Overlays the new source (and frontend/dist, if the package contains one)
#      -- node_modules, .env, .env.local and backend/data are preserved
#   3. chowns to the run user
#   4. Restarts the services (DB schema self-migrates on backend start)
#   5. Health check
#
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

APP_DIR="${APP_DIR:-/opt/cohesity-dashboard}"
RUN_USER="${RUN_USER:-cohesity}"
PKG="${1:-}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Must run as root. Try: dzdo bash deploy/update.sh <package.tar.gz>"
[ -d "${APP_DIR}" ]  || die "APP_DIR ${APP_DIR} does not exist — run a full install first."
[ -n "${PKG}" ]      || die "Usage: dzdo bash deploy/update.sh /path/to/cohesity-update-*.tar.gz"
[ -f "${PKG}" ]      || die "Package not found: ${PKG}"

# 1. Back up the DB
STAMP="$(date +%F-%H%M%S)"
MAX_BACKUPS="${MAX_BACKUPS:-5}"
if [ -d "${APP_DIR}/backend/data" ]; then
  log "Backing up backend/data -> backend/data.bak-${STAMP}"
  cp -a "${APP_DIR}/backend/data" "${APP_DIR}/backend/data.bak-${STAMP}"

  # Keep only the newest ${MAX_BACKUPS} backups (newest first by mtime).
  mapfile -t _backups < <(ls -1dt "${APP_DIR}"/backend/data.bak-* 2>/dev/null || true)
  if [ "${#_backups[@]}" -gt "${MAX_BACKUPS}" ]; then
    log "Pruning old DB backups (keeping ${MAX_BACKUPS} most recent)"
    for _old in "${_backups[@]:${MAX_BACKUPS}}"; do
      warn "Removing old backup: ${_old}"
      rm -rf "${_old}"
    done
  fi
fi

# 2. Overlay new source. The package uses repo-relative paths (backend/..,
#    frontend/..), so we extract straight into APP_DIR with no --strip-components.
#    It intentionally excludes .env, .env.local, node_modules and backend/data,
#    so those on-disk files are never overwritten.
log "Overlaying update from ${PKG}"
tar -xzf "${PKG}" -C "${APP_DIR}"

# Report whether a rebuilt frontend came with the package.
if tar -tzf "${PKG}" | grep -q '^frontend/dist/'; then
  log "Package includes a rebuilt frontend/dist (UI updated)."
else
  log "No frontend/dist in package (backend-only update; UI unchanged)."
fi

# 3. Ownership
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

# 4. Restart (backend applies idempotent DB migrations on start)
log "Restarting services"
systemctl restart cohesity-dashboard.service cohesity-poller.service

# 5. Health check
PORT="$(grep -E '^PORT=' "${APP_DIR}/.env" 2>/dev/null | head -n1 | cut -d= -f2-)"
PORT="${PORT:-3001}"
log "Waiting for health check on http://localhost:${PORT}/health"
for _ in $(seq 1 15); do
  if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    log "Update applied. Health check passed."
    exit 0
  fi
  sleep 1
done
warn "Health check did not pass yet. Inspect logs:"
warn "  dzdo journalctl -u cohesity-dashboard -n 100 --no-pager"
exit 1