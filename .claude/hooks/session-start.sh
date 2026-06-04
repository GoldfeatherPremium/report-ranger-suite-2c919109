#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs dependencies for all three Node projects in this repo so builds,
# type-checks and linters work inside a freshly-cloned web session:
#   - root                   : Bun + Vite + TanStack React frontend (Lovable app)
#   - vps/worker             : npm + TypeScript Turnitin student worker
#   - vps/worker-instructor  : npm + TypeScript Turnitin instructor worker
#
# Idempotent and non-interactive. Each install is best-effort: a registry
# hiccup on one project logs a warning but never aborts session startup
# (the platform pre-provisions most root deps anyway).
set -uo pipefail

# Only run in Claude Code on the web (remote) sessions; a no-op locally.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$ROOT"

warn() { echo "[session-start][warn] $*" >&2; }

echo "[session-start] installing root frontend dependencies (bun install)…"
bun install || warn "root 'bun install' did not fully complete (some packages may be blocked by the registry) — continuing"

for dir in vps/worker vps/worker-instructor; do
  if [ -f "$ROOT/$dir/package.json" ]; then
    echo "[session-start] installing $dir dependencies (npm install)…"
    ( cd "$ROOT/$dir" && npm install --no-audit --no-fund ) \
      || warn "'npm install' in $dir did not fully complete — continuing"
  fi
done

echo "[session-start] dependency setup finished."
