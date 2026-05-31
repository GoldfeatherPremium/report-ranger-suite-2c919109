#!/usr/bin/env bash
# Auto-update the Turnitin worker from git.
# Run by the turnitin-worker-update.timer every few minutes. It only rebuilds
# and restarts the worker when the tracked branch actually has a new commit, so
# an unchanged repo is a cheap no-op with zero downtime.

set -euo pipefail

# Repo root = the directory that contains this vps/ folder.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"

cd "$REPO_DIR"

# Track whatever branch the VPS is currently checked out on (no hardcoded name).
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

cd "$WORKER_DIR"
npm install
npm run build
npm prune --omit=dev

systemctl restart turnitin-worker
echo "auto-update: redeployed worker to $REMOTE and restarted"
