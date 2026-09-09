#!/usr/bin/env bash
#
# Infrastructure Command Center - Ubuntu installer / upgrader.
#
# Works from a package built by scripts/package-ubuntu.ps1. Fresh install and
# upgrade are the same command; the script detects an existing install by the
# presence of <app-dir>/.env and then preserves .env, frontend/.env.local,
# backend/data (SQLite), backend/plugins (installed packs), node_modules and
# logs while overlaying the new code.
#
# Usage (as root):
#   tar -xzf icc-dashboard-<ver>.tar.gz -C /tmp/icc
#   sudo bash /tmp/icc/deploy/install.sh [options]
# or, in one step:
#   sudo bash install.sh /path/to/icc-dashboard-<ver>.tar.gz [options]
#
# Options (env var in brackets):
#   --app-dir DIR          install root            [APP_DIR=/opt/cohesity-dashboard]
#   --user NAME            service account         [RUN_USER=cohesity]
#   --port N               listen port             [PORT=3001]
#   --service-prefix P     unit names P-dashboard, P-poller [SVC_PREFIX=cohesity]
#   --license-key KEY      LICENSE_KEY for .env (fresh install only)
#   --trust-proxy N        set TRUST_PROXY=N in .env (behind nginx/Cloudflare)
#   --node-version MAJOR   Node major to fetch     [NODE_MAJOR=24]
#   --no-start             install but do not enable/start the units
#
# Node runtime: the app runs on a private Node under <app-dir>/node. The
# installer uses, in order: an already installed <app-dir>/node of the same
# major; a bundled node-runtime/node-*.tar.xz in the package; a download from
# nodejs.org. Nothing is installed system-wide and apt is not touched.
#
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

APP_DIR="${APP_DIR:-/opt/cohesity-dashboard}"
RUN_USER="${RUN_USER:-cohesity}"
PORT="${PORT:-3001}"
SVC_PREFIX="${SVC_PREFIX:-cohesity}"
NODE_MAJOR="${NODE_MAJOR:-24}"
LICENSE_KEY="${LICENSE_KEY:-}"
TRUST_PROXY="${TRUST_PROXY:-}"
START=1
MAX_BACKUPS="${MAX_BACKUPS:-5}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

PKG_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir)        APP_DIR="$2"; shift 2 ;;
    --user)           RUN_USER="$2"; shift 2 ;;
    --port)           PORT="$2"; shift 2 ;;
    --service-prefix) SVC_PREFIX="$2"; shift 2 ;;
    --license-key)    LICENSE_KEY="$2"; shift 2 ;;
    --trust-proxy)    TRUST_PROXY="$2"; shift 2 ;;
    --node-version)   NODE_MAJOR="$2"; shift 2 ;;
    --no-start)       START=0; shift ;;
    -h|--help)        sed -n '2,32p' "$0"; exit 0 ;;
    -*)               die "Unknown option: $1" ;;
    *)                PKG_FILE="$1"; shift ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0 ..."
for t in tar curl xz; do command -v "$t" >/dev/null 2>&1 || die "Missing tool: $t (apt install ${t}-utils or ${t})"; done
if [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) warn "Built for Ubuntu; detected ${PRETTY_NAME:-unknown}. Continuing." ;;
  esac
fi

# Locate the package tree. Either we were handed a tarball, or we are running
# from deploy/ inside an already extracted tree.
STAGE=""
if [ -n "${PKG_FILE}" ]; then
  [ -f "${PKG_FILE}" ] || die "Package not found: ${PKG_FILE}"
  STAGE="$(mktemp -d /tmp/icc-install.XXXXXX)"
  log "Extracting ${PKG_FILE} to ${STAGE}"
  tar -xzf "${PKG_FILE}" -C "${STAGE}"
  PKG_ROOT="${STAGE}"
else
  PKG_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
[ -f "${PKG_ROOT}/backend/server.js" ]        || die "No backend/server.js under ${PKG_ROOT}; not an ICC package."
[ -f "${PKG_ROOT}/frontend/dist/index.html" ] || die "No frontend/dist in the package; rebuild with scripts/package-ubuntu.ps1."
cleanup() { [ -n "${STAGE}" ] && rm -rf "${STAGE}"; }
trap cleanup EXIT

PKG_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${PKG_ROOT}/package.json" | head -n1)"
UPGRADE=0
[ -f "${APP_DIR}/.env" ] && UPGRADE=1
SVC_APP="${SVC_PREFIX}-dashboard"
SVC_POLL="${SVC_PREFIX}-poller"

log "ICC ${PKG_VERSION:-?} -> ${APP_DIR} (user ${RUN_USER}, port ${PORT}, units ${SVC_APP}/${SVC_POLL}) mode=$([ ${UPGRADE} -eq 1 ] && echo upgrade || echo fresh)"

# ---------------------------------------------------------------------------
# 1. Service account and directories
# ---------------------------------------------------------------------------
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  log "Creating system user ${RUN_USER}"
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin --user-group "${RUN_USER}"
fi
mkdir -p "${APP_DIR}"

# ---------------------------------------------------------------------------
# 2. Stop services and back up the database on upgrade
# ---------------------------------------------------------------------------
if [ ${UPGRADE} -eq 1 ]; then
  if systemctl list-unit-files "${SVC_POLL}.service" >/dev/null 2>&1; then
    log "Stopping ${SVC_APP} ${SVC_POLL}"
    systemctl stop "${SVC_APP}" "${SVC_POLL}" 2>/dev/null || true
  fi
  if [ -d "${APP_DIR}/backend/data" ]; then
    STAMP="$(date +%F-%H%M%S)"
    log "Backing up backend/data -> backend/data.bak-${STAMP}"
    cp -a "${APP_DIR}/backend/data" "${APP_DIR}/backend/data.bak-${STAMP}"
    mapfile -t _backups < <(ls -1dt "${APP_DIR}"/backend/data.bak-* 2>/dev/null || true)
    if [ "${#_backups[@]}" -gt "${MAX_BACKUPS}" ]; then
      for _old in "${_backups[@]:${MAX_BACKUPS}}"; do
        warn "Pruning old DB backup ${_old}"
        rm -rf "${_old}"
      done
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Copy the application tree (overlay; local-only files are never touched)
# ---------------------------------------------------------------------------
log "Copying application files"
tar -C "${PKG_ROOT}" -cf - \
  --exclude='./.env' --exclude='./frontend/.env.local' \
  --exclude='./backend/data' --exclude='./backend/plugins' \
  --exclude='./node_modules' --exclude='./backend/node_modules' --exclude='./frontend/node_modules' \
  --exclude='./node-runtime' --exclude='./logs' \
  . | tar -C "${APP_DIR}" -xf -
mkdir -p "${APP_DIR}/backend/data" "${APP_DIR}/backend/plugins" "${APP_DIR}/logs"

# ---------------------------------------------------------------------------
# 4. Private Node runtime under <app-dir>/node
# ---------------------------------------------------------------------------
NODE_DIR="${APP_DIR}/node"
NODE_BIN="${NODE_DIR}/bin/node"
have_node=0
if [ -x "${NODE_BIN}" ]; then
  cur="$("${NODE_BIN}" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${cur}" = "${NODE_MAJOR}" ]; then
    have_node=1
    log "Keeping existing Node $("${NODE_BIN}" -v) at ${NODE_DIR}"
  fi
fi
if [ ${have_node} -eq 0 ]; then
  arch="$(uname -m)"
  case "${arch}" in
    x86_64)  narch=x64 ;;
    aarch64) narch=arm64 ;;
    *) die "Unsupported architecture ${arch}" ;;
  esac
  tarball=""
  bundled="$(ls "${PKG_ROOT}"/node-runtime/node-v${NODE_MAJOR}.*-linux-${narch}.tar.xz 2>/dev/null | head -n1 || true)"
  if [ -n "${bundled}" ]; then
    tarball="${bundled}"
    log "Using bundled Node runtime $(basename "${tarball}")"
  else
    log "Resolving latest Node ${NODE_MAJOR}.x from nodejs.org"
    fname="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" \
              | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${narch}\.tar\.xz$" | head -n1 || true)"
    [ -n "${fname}" ] || die "Could not resolve a Node ${NODE_MAJOR}.x linux-${narch} build. Bundle one with package-ubuntu.ps1 -BundleNode for offline installs."
    tarball="$(mktemp /tmp/node-XXXXXX.tar.xz)"
    log "Downloading ${fname}"
    curl -fsSL -o "${tarball}" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${fname}"
  fi
  rm -rf "${NODE_DIR}"
  mkdir -p "${NODE_DIR}"
  tar -xJf "${tarball}" -C "${NODE_DIR}" --strip-components=1
  [ -n "${bundled}" ] || rm -f "${tarball}"
  log "Installed Node $("${NODE_BIN}" -v) at ${NODE_DIR}"
fi
export PATH="${NODE_DIR}/bin:${PATH}"

# ---------------------------------------------------------------------------
# 5. Backend dependencies (native modules compile or use prebuilds here)
# ---------------------------------------------------------------------------
if [ -d "${PKG_ROOT}/backend/node_modules" ]; then
  log "Using vendored backend/node_modules from the package"
  rm -rf "${APP_DIR}/backend/node_modules"
  cp -a "${PKG_ROOT}/backend/node_modules" "${APP_DIR}/backend/node_modules"
else
  log "Installing backend dependencies (needs registry access)"
  if ! ( cd "${APP_DIR}/backend" && npm ci --omit=dev --no-audit --no-fund 2>"${APP_DIR}/logs/npm-ci.err" ); then
    if grep -q 'package-lock.json .* in sync' "${APP_DIR}/logs/npm-ci.err"; then
      warn "package-lock.json is out of sync with package.json; falling back to npm install"
      ( cd "${APP_DIR}/backend" && npm install --omit=dev --no-audit --no-fund ) || die "npm install failed. See ${APP_DIR}/logs/npm-ci.err and /root/.npm/_logs."
    else
      cat "${APP_DIR}/logs/npm-ci.err" >&2
      warn "If the failure is a native build (better-sqlite3/argon2), install build tools"
      warn "and rerun: apt install -y python3 make g++"
      die "Dependency install failed."
    fi
  fi
fi
( cd "${APP_DIR}/backend" && node -e "require('better-sqlite3'); require('argon2')" ) \
  || die "Native modules do not load under $(node -v). See the warning above."

# ---------------------------------------------------------------------------
# 6. .env on fresh install (never rewritten on upgrade)
# ---------------------------------------------------------------------------
if [ ${UPGRADE} -eq 0 ]; then
  log "Writing ${APP_DIR}/.env with generated keys"
  enc="$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  api="$(openssl rand -hex 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  {
    echo "# Generated by deploy/install.sh on $(date -Is). See .env.example for every option."
    echo "PORT=${PORT}"
    echo "ENCRYPTION_KEY=${enc}"
    echo "DASHBOARD_API_KEY=${api}"
    echo "LICENSE_KEY=${LICENSE_KEY}"
    if [ -n "${TRUST_PROXY}" ]; then echo "TRUST_PROXY=${TRUST_PROXY}"; else echo "# TRUST_PROXY=1"; fi
    echo "# HELIOS_API_KEY="
    echo "# GITHUB_MODELS_TOKEN="
  } > "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
else
  log "Keeping existing .env"
fi

chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

# ---------------------------------------------------------------------------
# 7. systemd units
# ---------------------------------------------------------------------------
log "Writing systemd units ${SVC_APP}.service and ${SVC_POLL}.service"
render_unit() {
  sed -e "s|__APP_DIR__|${APP_DIR}|g" -e "s|__RUN_USER__|${RUN_USER}|g" -e "s|__NODE_BIN__|${NODE_BIN}|g" "$1"
}
render_unit "${PKG_ROOT}/deploy/cohesity-dashboard.service" > "/etc/systemd/system/${SVC_APP}.service"
render_unit "${PKG_ROOT}/deploy/cohesity-poller.service" \
  | sed -e "s|cohesity-dashboard.service|${SVC_APP}.service|g" > "/etc/systemd/system/${SVC_POLL}.service"
systemctl daemon-reload

if [ ${START} -eq 0 ]; then
  log "Installed. Units not started (--no-start). Start with: systemctl enable --now ${SVC_APP} ${SVC_POLL}"
  exit 0
fi

# The API runs the schema migrations at boot. Start it alone, wait until it is
# healthy, then start the poller, so the two processes never race on a fresh
# or freshly upgraded SQLite file ("database is locked" during migrations).
log "Starting ${SVC_APP}"
systemctl enable "${SVC_APP}" "${SVC_POLL}" >/dev/null 2>&1
systemctl restart "${SVC_APP}"

# ---------------------------------------------------------------------------
# 8. Health check, then the poller, then first-run info
# ---------------------------------------------------------------------------
EFFECTIVE_PORT="$(grep -E '^PORT=' "${APP_DIR}/.env" | head -n1 | cut -d= -f2-)"
EFFECTIVE_PORT="${EFFECTIVE_PORT:-3001}"
ok=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${EFFECTIVE_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ ${ok} -ne 1 ]; then
  warn "Health check on :${EFFECTIVE_PORT} did not pass. Inspect: journalctl -u ${SVC_APP} -n 100 --no-pager"
  exit 1
fi
log "Starting ${SVC_POLL}"
systemctl restart "${SVC_POLL}"

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "ICC ${PKG_VERSION:-?} is running."
echo "  URL:      http://${ip:-<host>}:${EFFECTIVE_PORT}/"
echo "  App dir:  ${APP_DIR}"
echo "  Config:   ${APP_DIR}/.env"
echo "  Logs:     journalctl -u ${SVC_APP} -f   |   journalctl -u ${SVC_POLL} -f"
if [ ${UPGRADE} -eq 0 ]; then
  sleep 2
  token="$(journalctl -u "${SVC_APP}" --no-pager -o cat 2>/dev/null | grep -o 'claim token: [0-9a-f]*' | tail -n1 | awk '{print $3}')"
  if [ -n "${token}" ]; then
    echo "  First-run claim token (enter at /login to create the admin): ${token}"
  else
    echo "  Claim token: journalctl -u ${SVC_APP} | grep 'claim token'"
  fi
fi
if ! grep -qE '^LICENSE_KEY=.+' "${APP_DIR}/.env"; then
  echo
  warn "LICENSE_KEY is empty in ${APP_DIR}/.env. The dashboard stays locked until one is set; restart both units afterwards."
fi
exit 0
