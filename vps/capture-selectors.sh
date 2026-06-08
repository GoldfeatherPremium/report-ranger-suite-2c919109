#!/usr/bin/env bash
# capture-selectors.sh — run the student worker against a REAL job with
# HEADLESS=false so you can watch it work and capture selectors from the
# [diag] lines in the log.
#
# Prerequisites:
#   - worker/.env filled in (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
#   - At least one document queued for the student (similarity) pipeline
#   - A graphical desktop session (X11 or Wayland) since HEADLESS=false opens Chromium
#
# Usage:
#   bash capture-selectors.sh 2>&1 | tee /tmp/selector-capture.log
#
# After it runs, search the log for lines like:
#   [diag]   <button cls=... txt=...>
# Those give you the real selector to put in SEL.* in turnitin.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"

if [[ ! -f "$WORKER_DIR/.env" ]]; then
  echo "ERROR: $WORKER_DIR/.env not found. Copy .env.example and fill it in first."
  exit 1
fi

echo "==> Starting student worker in HEADLESS=false mode"
echo "    Chromium will open — watch the viewer."
echo "    Press Ctrl+C to stop after the job completes."
echo ""

cd "$WORKER_DIR"
HEADLESS=false CONCURRENCY=1 node dist/index.js
