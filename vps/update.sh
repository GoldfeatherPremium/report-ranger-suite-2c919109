#!/usr/bin/env bash
# update.sh — pull latest code from git and redeploy the Turnitin worker.
# Survives SSH disconnects: call with --background to run detached.
#
# Usage:
#   bash update.sh                  # run in foreground (attach to terminal)
#   bash update.sh --background     # run in background, tail /var/log/worker-update.log

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"
BRANCH="claude/turnitin-document-download-SxZs2"
LOG="/var/log/worker-update.log"

# ── background mode: re-exec with nohup and exit ─────────────────────────────
if [[ "${1:-}" == "--background" ]]; then
  nohup bash "$0" > "$LOG" 2>&1 &
  BG_PID=$!
  echo "Running in background (PID $BG_PID)"
  echo "Watch progress:  tail -f $LOG"
  echo "Check status:    systemctl status turnitin-worker --no-pager"
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

# ── 2. install deps ───────────────────────────────────────────────────────────
log "Installing npm dependencies"
cd "$WORKER_DIR"
npm install

# ── 3. build ──────────────────────────────────────────────────────────────────
log "Building worker"
npm run build

# ── 4. prune dev deps ─────────────────────────────────────────────────────────
log "Pruning dev dependencies"
npm prune --omit=dev

# ── 5. refresh systemd unit ───────────────────────────────────────────────────
log "Refreshing systemd unit"
sed "s|__WORKER_DIR__|$WORKER_DIR|g" \
  "$REPO_DIR/vps/turnitin-worker.service" \
  > /etc/systemd/system/turnitin-worker.service
systemctl daemon-reload
systemctl enable turnitin-worker --quiet

# ── 6. restart ────────────────────────────────────────────────────────────────
log "Restarting turnitin-worker"
systemctl reset-failed turnitin-worker 2>/dev/null || true
systemctl restart turnitin-worker
sleep 2

STATUS="$(systemctl is-active turnitin-worker)"
if [[ "$STATUS" == "active" ]]; then
  log "Worker is running (active)"
else
  log "WARNING: worker status is '$STATUS' — check logs:"
  log "  journalctl -u turnitin-worker -n 40 --no-pager"
fi

log "Done. Deployed $REMOTE"
