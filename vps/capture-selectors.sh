#!/usr/bin/env bash
# capture-selectors.sh — run the instructor worker against a REAL assignment
# with HEADLESS=false so you can watch it work and capture the AI Writing tab
# selector from the [diag] lines in the log.
#
# Prerequisites:
#   - worker-instructor/.env filled in (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
#   - At least one instructor account / class / assignment configured in the admin UI
#   - A document queued via /dashboard/ai
#   - A graphical desktop session (X11 or Wayland) since HEADLESS=false opens Chromium
#
# Usage:
#   bash capture-selectors.sh 2>&1 | tee /tmp/selector-capture.log
#
# After it runs, search the log for lines like:
#   [diag]   <button cls=... txt=AI Writing>
#   [warn] [ai-fallback] intent="..." used selector=...
# Those give you the real selector to put in SEL.aiWritingTab in turnitin.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTRUCTOR_DIR="$SCRIPT_DIR/worker-instructor"

if [[ ! -f "$INSTRUCTOR_DIR/.env" ]]; then
  echo "ERROR: $INSTRUCTOR_DIR/.env not found. Copy .env.example and fill it in first."
  exit 1
fi

echo "==> Starting instructor worker in HEADLESS=false mode"
echo "    Chromium will open — watch for the AI Writing tab in the viewer."
echo "    Press Ctrl+C to stop after the job completes."
echo ""

cd "$INSTRUCTOR_DIR"
HEADLESS=false CONCURRENCY=1 node dist/index.js
