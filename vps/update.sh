#!/usr/bin/env bash
# update.sh — pull latest code from git and redeploy both workers.
# Survives SSH disconnects: call with --background to run detached.
#
# Usage:
#   bash update.sh                  # run in foreground (attach to terminal)
#   bash update.sh --background     # run in background, tail /var/log/worker-update.log

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"
INSTRUCTOR_WORKER_DIR="$REPO_DIR/vps/worker-instructor"
BRANCH="${WORKER_BRANCH:-main}"
LOG="/var/log/worker-update.log"

# ── background mode: re-exec with nohup and exit ─────────────────────────────
if [[ "${1:-}" == "--background" ]]; then
  nohup bash "$0" > "$LOG" 2>&1 &
  BG_PID=$!
  echo "Running in background (PID $BG_PID)"
  echo "Watch progress:  tail -f $LOG"
  echo "Check status:    systemctl status turnitin-worker turnitin-instructor-worker --no-pager"
  exit 0
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1. pull ───────────────────────────────────────────────────────────────────
log "Fetching $BRANCH"
cd "$REPO_DIR"
git fetch origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  log "Already up to date ($LOCAL) — nothing to do"
  exit 0
fi

log "Updating $LOCAL -> $REMOTE"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# ── 2. student worker ─────────────────────────────────────────────────────────
log "Installing student worker npm deps"
cd "$WORKER_DIR"
npm install

log "Building student worker"
npm run build

log "Pruning student worker dev deps"
npm prune --omit=dev

log "Refreshing systemd unit (student)"
sed "s|__WORKER_DIR__|$WORKER_DIR|g" \
  "$REPO_DIR/vps/turnitin-worker.service" \
  > /etc/systemd/system/turnitin-worker.service
systemctl daemon-reload
systemctl enable turnitin-worker --quiet

log "Restarting turnitin-worker"
systemctl reset-failed turnitin-worker 2>/dev/null || true
systemctl restart turnitin-worker
sleep 2

STATUS="$(systemctl is-active turnitin-worker)"
if [[ "$STATUS" == "active" ]]; then
  log "Student worker is running (active)"
else
  log "WARNING: student worker status is '$STATUS' — check: journalctl -u turnitin-worker -n 40 --no-pager"
fi

# ── 3. instructor worker (only if .env exists) ────────────────────────────────
if [[ -f "$INSTRUCTOR_WORKER_DIR/.env" ]]; then
  log "Installing instructor worker npm deps"
  cd "$INSTRUCTOR_WORKER_DIR"
  npm install

  log "Building instructor worker"
  npm run build

  log "Pruning instructor worker dev deps"
  npm prune --omit=dev

  log "Refreshing systemd unit (instructor)"
  sed "s|__WORKER_DIR__|$INSTRUCTOR_WORKER_DIR|g" \
    "$REPO_DIR/vps/turnitin-instructor-worker.service" \
    > /etc/systemd/system/turnitin-instructor-worker.service
  systemctl daemon-reload
  systemctl enable turnitin-instructor-worker --quiet

  log "Restarting turnitin-instructor-worker"
  systemctl reset-failed turnitin-instructor-worker 2>/dev/null || true
  systemctl restart turnitin-instructor-worker
  sleep 2

  INSTR_STATUS="$(systemctl is-active turnitin-instructor-worker)"
  if [[ "$INSTR_STATUS" == "active" ]]; then
    log "Instructor worker is running (active)"
  else
    log "WARNING: instructor worker status is '$INSTR_STATUS' — check: journalctl -u turnitin-instructor-worker -n 40 --no-pager"
  fi
else
  log "(Skipping instructor worker — $INSTRUCTOR_WORKER_DIR/.env not found)"
  log "  To enable: cp $INSTRUCTOR_WORKER_DIR/.env.example $INSTRUCTOR_WORKER_DIR/.env && nano $INSTRUCTOR_WORKER_DIR/.env && bash $0"
fi

log "Done. Deployed $REMOTE"
