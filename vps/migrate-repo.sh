#!/usr/bin/env bash
# migrate-repo.sh — point this VPS at a NEW git repo, leaving the old one in place.
#
# What it does:
#   1. Clones the new repo into a fresh directory (default: /opt/dochub-new).
#   2. Copies your existing worker/.env secrets across (they are gitignored,
#      so a fresh clone never includes them).
#   3. Rebuilds the worker (npm install + Playwright Chromium + tsc build).
#   4. Re-points the systemd units — the worker AND the auto-update timer —
#      at the new clone, so all future self-updates pull from the new repo.
#   5. Restarts the services.
#
# The OLD checkout is stopped but left on disk untouched, so nothing is lost
# and you can delete it later once you've confirmed the new one works.
#
# Run as root on the VPS:
#   sudo bash migrate-repo.sh <NEW_REPO_URL> [BRANCH] [NEW_DIR]
#
# Examples:
#   sudo bash migrate-repo.sh https://github.com/GoldfeatherPremium/goldfeatherpro.git
#   sudo bash migrate-repo.sh https://github.com/GoldfeatherPremium/goldfeatherpro.git main /opt/dochub-new
#
# You can also pass values via env: NEW_REPO_URL, BRANCH, NEW_DIR, OLD_DIR.

set -euo pipefail

# ── args / config ─────────────────────────────────────────────────────────────
NEW_REPO_URL="${1:-${NEW_REPO_URL:-}}"
BRANCH="${2:-${BRANCH:-main}}"
NEW_DIR="${3:-${NEW_DIR:-/opt/dochub-new}}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash $0 $*"
  exit 1
fi

if [[ -z "$NEW_REPO_URL" ]]; then
  echo "ERROR: no repo URL given."
  echo "Usage: sudo bash $0 <NEW_REPO_URL> [BRANCH] [NEW_DIR]"
  exit 1
fi

step() { echo ""; echo "==> $*"; }
warn() { echo "    [warn] $*" >&2; }

# ── locate the OLD install (so we can copy its .env across) ────────────────────
# The worker systemd unit's WorkingDirectory is <repo>/vps/worker, so the repo
# root is two levels up. Fall back to the OLD_DIR env var if detection fails.
OLD_REPO_DIR="${OLD_DIR:-}"
if [[ -z "$OLD_REPO_DIR" ]]; then
  OLD_WORKER_DIR="$(systemctl show -p WorkingDirectory --value turnitin-worker 2>/dev/null || true)"
  if [[ -n "$OLD_WORKER_DIR" && -d "$OLD_WORKER_DIR" ]]; then
    OLD_REPO_DIR="$(cd "$OLD_WORKER_DIR/../.." && pwd)"
  fi
fi

if [[ -n "$OLD_REPO_DIR" ]]; then
  echo "Old install detected at: $OLD_REPO_DIR"
else
  warn "could not detect the old install — .env files will NOT be copied automatically."
  warn "set OLD_DIR=/path/to/old/repo if you want secrets carried over."
fi

if [[ "$(readlink -f "$NEW_DIR" 2>/dev/null || echo "$NEW_DIR")" == "$(readlink -f "${OLD_REPO_DIR:-/nonexistent}" 2>/dev/null || echo x)" ]]; then
  echo "ERROR: NEW_DIR ($NEW_DIR) is the same as the old install. Choose a different NEW_DIR."
  exit 1
fi

echo ""
echo "  New repo : $NEW_REPO_URL"
echo "  Branch   : $BRANCH"
echo "  New dir  : $NEW_DIR"
echo ""

# ── stop services so nothing claims a job mid-swap ────────────────────────────
step "Stopping auto-update timer and workers"
systemctl stop turnitin-worker-update.timer 2>/dev/null || true
systemctl stop turnitin-worker 2>/dev/null || true

# ── clone (or refresh) the new repo ───────────────────────────────────────────
if [[ -d "$NEW_DIR/.git" ]]; then
  step "New dir already a git repo — fetching and resetting to origin/$BRANCH"
  git -C "$NEW_DIR" remote set-url origin "$NEW_REPO_URL"
  git -C "$NEW_DIR" fetch origin "$BRANCH"
  git -C "$NEW_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  git -C "$NEW_DIR" reset --hard "origin/$BRANCH"
else
  step "Cloning $NEW_REPO_URL ($BRANCH) into $NEW_DIR"
  rm -rf "$NEW_DIR"
  git clone --branch "$BRANCH" "$NEW_REPO_URL" "$NEW_DIR"
fi

NEW_WORKER_DIR="$NEW_DIR/vps/worker"

# ── carry over secrets (.env is gitignored, so the clone has none) ────────────
step "Copying .env secrets from the old install"
copy_env() {
  local src="$1" dst="$2" name="$3"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "    [$name] .env copied"
  else
    warn "[$name] no .env at $src — you'll need to create $dst before starting it"
  fi
}
if [[ -n "$OLD_REPO_DIR" ]]; then
  copy_env "$OLD_REPO_DIR/vps/worker/.env"            "$NEW_WORKER_DIR/.env"     "student"
fi

# ── build the workers in the new clone ────────────────────────────────────────
build_worker() {
  local dir="$1" name="$2"
  step "[$name] building in $dir"
  cd "$dir"
  npm install
  npx playwright install --with-deps chromium
  npm run build
  npm prune --omit=dev
}

build_worker "$NEW_WORKER_DIR" "student"

# ── re-point systemd units at the new clone (templates come from the new repo) ─
install_unit() {
  local template="$1" unit_name="$2" worker_dir="$3"
  sed "s|__WORKER_DIR__|${worker_dir}|g" "$template" \
    > "/etc/systemd/system/${unit_name}.service"
  echo "    [$unit_name] unit -> $worker_dir"
}

step "Installing systemd units pointing at $NEW_DIR"
install_unit "$NEW_DIR/vps/turnitin-worker.service" "turnitin-worker" "$NEW_WORKER_DIR"

# Re-point the auto-update timer/service at the new repo too (if it was set up).
if [[ -f /etc/systemd/system/turnitin-worker-update.timer ]] \
   || systemctl is-enabled turnitin-worker-update.timer --quiet 2>/dev/null; then
  step "Re-pointing auto-update timer at $NEW_DIR"
  sed "s|__REPO_DIR__|$NEW_DIR|g" "$NEW_DIR/vps/turnitin-worker-update.service" \
    > /etc/systemd/system/turnitin-worker-update.service
  cp "$NEW_DIR/vps/turnitin-worker-update.timer" \
    /etc/systemd/system/turnitin-worker-update.timer
fi

# ── start everything ──────────────────────────────────────────────────────────
step "Reloading systemd and starting services"
systemctl daemon-reload
systemctl enable turnitin-worker --quiet 2>/dev/null || true
systemctl start  turnitin-worker
if [[ -f /etc/systemd/system/turnitin-worker-update.timer ]]; then
  systemctl enable --now turnitin-worker-update.timer 2>/dev/null || true
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════"
echo "Migration complete. The VPS now runs from: $NEW_DIR"
echo "Future auto-updates pull from: $NEW_REPO_URL ($BRANCH)"
echo ""
echo "Verify:"
echo "  systemctl status turnitin-worker --no-pager"
echo "  journalctl -u turnitin-worker -f --no-pager"
echo ""
if [[ -n "$OLD_REPO_DIR" ]]; then
  echo "The OLD install is still on disk (stopped, untouched):"
  echo "  $OLD_REPO_DIR"
  echo "Once you've confirmed the new one works, you can remove it:"
  echo "  rm -rf $OLD_REPO_DIR"
fi
echo "══════════════════════════════════════════════════════════"
