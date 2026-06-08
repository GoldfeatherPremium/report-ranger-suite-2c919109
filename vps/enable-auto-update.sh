#!/usr/bin/env bash
# Turn ON automatic git auto-updates for the Turnitin student worker.
# After this, the VPS pulls + rebuilds + restarts the worker on its own
# whenever the tracked branch gets a new commit (checked every ~5 min).
#
#   Enable:  sudo bash vps/enable-auto-update.sh
#   Disable: sudo systemctl disable --now turnitin-worker-update.timer

set -euo pipefail

[[ "$EUID" -eq 0 ]] || { echo "Run as root: sudo bash $0"; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Installing auto-update systemd units"
sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/vps/turnitin-worker-update.service" \
  > /etc/systemd/system/turnitin-worker-update.service
cp "$REPO_DIR/vps/turnitin-worker-update.timer" \
  /etc/systemd/system/turnitin-worker-update.timer

systemctl daemon-reload
systemctl enable --now turnitin-worker-update.timer

echo ""
echo "Auto-update is ON. The worker will self-update from git within ~5 min of each push."
echo "  Watch updates:  journalctl -u turnitin-worker-update -f"
echo "  Next run time:  systemctl list-timers turnitin-worker-update --no-pager"
echo "  Turn it off:    systemctl disable --now turnitin-worker-update.timer"

# Also ensure the main service is enabled (not just the timer)
for svc in turnitin-worker; do
  if systemctl is-enabled "$svc" --quiet 2>/dev/null; then
    echo "  $svc: already enabled"
  else
    systemctl enable "$svc" --quiet 2>/dev/null || echo "  $svc: not enabled (may need .env first)"
  fi
done