#!/usr/bin/env bash
# update.sh — pull latest code and redeploy the worker.
#
# Usage:
#   sudo bash update.sh                          # normal update
#   sudo bash update.sh --force                  # rebuild even if already up to date
#   sudo bash update.sh --background             # detach; tail /var/log/worker-update.log
#
# Env vars:
#   WORKER_BRANCH=main   git branch to deploy (default: main)

set -euo pipefail

# ── root check ────────────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash update.sh $*"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"
BRANCH="${WORKER_BRANCH:-main}"
LOG="/var/log/worker-update.log"

FORCE=0
BG=0

for arg in "$@"; do
  case "$arg" in
    --force)          FORCE=1 ;;
    --background)     BG=1 ;;
  esac
done

# ── background mode ───────────────────────────────────────────────────────────
if [[ "$BG" -eq 1 ]]; then
  EXTRA=""
  [[ "$FORCE" -eq 1 ]] && EXTRA+=" --force"
  # shellcheck disable=SC2086
  nohup bash "$0" $EXTRA > "$LOG" 2>&1 &
  BG_PID=$!
  echo "Running in background (PID $BG_PID)"
  echo "Watch: tail -f $LOG"
  echo "Status: systemctl status turnitin-worker --no-pager"
  exit 0
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

separator() { echo "────────────────────────────────────────────────────────────"; }

# ── 1. git pull ───────────────────────────────────────────────────────────────
separator
log "Branch: $BRANCH"
cd "$REPO_DIR"
git fetch origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL" == "$REMOTE" && "$FORCE" -eq 0 ]]; then
  log "Already up to date ($LOCAL)"
  log "Pass --force to rebuild anyway"
  # Still show current service statuses before exiting
  echo ""
  show_status() {
    local svc="$1"
    if systemctl is-enabled "$svc" --quiet 2>/dev/null; then
      local state; state="$(systemctl is-active "$svc" 2>/dev/null || true)"
      log "  $svc: $state"
    fi
  }
  log "Current service statuses:"
  show_status turnitin-worker
  exit 0
fi

if [[ "$LOCAL" != "$REMOTE" ]]; then
  log "New commits:"
  git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/    /'
  log "Deploying $LOCAL -> $REMOTE"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  log "Force rebuild at $LOCAL"
fi

# ── helpers ───────────────────────────────────────────────────────────────────
build_worker() {
  local dir="$1"
  local name="$2"

  log "[$name] npm install"
  cd "$dir"
  npm install --prefer-offline 2>&1 | tail -3

  log "[$name] build"
  npm run build

  log "[$name] prune dev deps"
  npm prune --omit=dev 2>&1 | tail -2
}

install_unit() {
  local template="$1"    # path to *.service template in repo
  local unit_name="$2"   # e.g. turnitin-worker
  local worker_dir="$3"

  local dest="/etc/systemd/system/${unit_name}.service"
  sed "s|__WORKER_DIR__|${worker_dir}|g" "$template" > "$dest"
  systemctl daemon-reload
  systemctl enable "$unit_name" --quiet
  log "[$unit_name] systemd unit refreshed"
}

restart_and_check() {
  local unit_name="$1"

  systemctl reset-failed "$unit_name" 2>/dev/null || true
  systemctl restart "$unit_name"
  sleep 3

  local state; state="$(systemctl is-active "$unit_name" 2>/dev/null || true)"
  if [[ "$state" == "active" ]]; then
    log "[$unit_name] running (active) ✓"
  else
    log "[$unit_name] WARNING: status='$state'"
    log "[$unit_name] Debug: journalctl -u $unit_name -n 50 --no-pager"
  fi
}

# ── 2. student worker ─────────────────────────────────────────────────────────
separator
log "Rebuilding student worker"
build_worker "$WORKER_DIR" "student"
install_unit "$REPO_DIR/vps/turnitin-worker.service" \
             "turnitin-worker" \
             "$WORKER_DIR"
restart_and_check "turnitin-worker"

# ── 3. final summary ──────────────────────────────────────────────────────────
separator
log "Deployed: $(git rev-parse --short HEAD)"
echo ""
log "Service statuses:"
for svc in turnitin-worker; do
  if systemctl is-enabled "$svc" --quiet 2>/dev/null; then
    state="$(systemctl is-active "$svc" 2>/dev/null || true)"
    active_jobs="$(journalctl -u "$svc" -n 5 --no-pager -o cat 2>/dev/null | grep -oP 'activeJobs=\K\d+' | tail -1 || true)"
    log "  $svc  →  $state${active_jobs:+  (active jobs: $active_jobs)}"
  fi
done
echo ""
log "Live logs:"
log "  Student:    journalctl -u turnitin-worker -f --no-pager"
