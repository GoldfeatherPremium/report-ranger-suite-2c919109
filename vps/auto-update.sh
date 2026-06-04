#!/usr/bin/env bash
# Auto-update both Turnitin workers from git.
# Run by the turnitin-worker-update.timer every few minutes. It only rebuilds
# and restarts workers when the tracked branch actually has a new commit, so
# an unchanged repo is a cheap no-op with zero downtime.
#
# NOTE: This script now handles BOTH the student worker and the instructor worker.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"
INSTRUCTOR_DIR="$REPO_DIR/vps/worker-instructor"

cd "$REPO_DIR"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git fetch origin "$BRANCH" --quiet

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "auto-update: already up to date ($LOCAL) on $BRANCH"
  exit 0
fi

echo "auto-update: new commit on $BRANCH ($LOCAL -> $REMOTE); redeploying"

# .env is gitignored, so reset --hard never touches your secrets.
git reset --hard "origin/$BRANCH"

# ── Student worker ─────────────────────────────────────────────────────────────
echo "auto-update: rebuilding student worker..."
cd "$WORKER_DIR"
npm install --prefer-offline
npm run build
npm prune --omit=dev

sed "s|__WORKER_DIR__|$WORKER_DIR|g" "$REPO_DIR/vps/turnitin-worker.service" \
  > /etc/systemd/system/turnitin-worker.service

systemctl daemon-reload
systemctl restart turnitin-worker
echo "auto-update: student worker restarted"

# ── Instructor worker ──────────────────────────────────────────────────────────
if [[ -f "$INSTRUCTOR_DIR/.env" ]]; then
  echo "auto-update: rebuilding instructor worker..."
  cd "$INSTRUCTOR_DIR"
  npm install --prefer-offline
  npm run build
  npm prune --omit=dev

  sed "s|__WORKER_DIR__|$INSTRUCTOR_DIR|g" "$REPO_DIR/vps/turnitin-instructor-worker.service" \
    > /etc/systemd/system/turnitin-instructor-worker.service

  systemctl daemon-reload
  systemctl restart turnitin-instructor-worker
  echo "auto-update: instructor worker restarted"
else
  echo "auto-update: instructor worker skipped (no .env found at $INSTRUCTOR_DIR/.env)"
fi

echo "auto-update: redeployed both workers to $REMOTE"