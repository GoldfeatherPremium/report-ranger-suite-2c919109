#!/usr/bin/env bash
# install.sh — first-time VPS setup for the Turnitin workers.
# Installs Node.js 20, Playwright/Chromium, builds both workers, and
# registers systemd services.
#
# Tested on Ubuntu 22.04 / 24.04. Run as root.
#
# Usage:
#   sudo bash install.sh              # install everything
#   sudo bash install.sh --student    # student worker only
#   sudo bash install.sh --instructor # instructor worker only (after student is set up)

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash install.sh $*"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"
INSTRUCTOR_DIR="$SCRIPT_DIR/worker-instructor"

DO_STUDENT=1
DO_INSTRUCTOR=1
for arg in "$@"; do
  case "$arg" in
    --student)    DO_INSTRUCTOR=0 ;;
    --instructor) DO_STUDENT=0 ;;
  esac
done

sep()  { echo ""; echo "══════════════════════════════════════════════════════════"; }
step() { echo "==> $*"; }

# ── system packages (skip if student-only subsequent run) ─────────────────────
if [[ "$DO_STUDENT" -eq 1 ]]; then
  sep
  step "Updating apt"
  apt-get update -y
  apt-get upgrade -y

  step "Installing Node.js 20"
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "  Node.js $(node -v) already installed"
  fi

  step "Installing Playwright/Chromium system deps"
  apt-get install -y \
    ca-certificates curl git wget gnupg \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2t64 2>/dev/null || apt-get install -y libasound2
fi

# ── helper: build a worker dir ───────────────────────────────────────────────
build_worker() {
  local dir="$1"
  local name="$2"

  step "[$name] npm install (all deps)"
  cd "$dir"
  npm install

  step "[$name] install Playwright Chromium"
  npx playwright install --with-deps chromium

  step "[$name] TypeScript build"
  npm run build

  step "[$name] prune dev deps"
  npm prune --omit=dev
}

install_unit() {
  local template="$1"
  local unit_name="$2"
  local worker_dir="$3"

  local dest="/etc/systemd/system/${unit_name}.service"
  cp "$template" "$dest"
  sed -i "s|__WORKER_DIR__|${worker_dir}|g" "$dest"
  systemctl daemon-reload
  systemctl enable "$unit_name"
  step "[$unit_name] systemd unit installed and enabled"
}

# ── student worker ────────────────────────────────────────────────────────────
if [[ "$DO_STUDENT" -eq 1 ]]; then
  sep
  step "Setting up student worker (Similarity pipeline)"

  build_worker "$WORKER_DIR" "student"

  if [[ ! -f "$WORKER_DIR/.env" ]]; then
    cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────┐"
    echo "  │  Fill in the student worker config before starting:     │"
    echo "  │  nano $WORKER_DIR/.env"
    echo "  └─────────────────────────────────────────────────────────┘"
    echo ""
  fi

  install_unit "$SCRIPT_DIR/turnitin-worker.service" \
               "turnitin-worker" \
               "$WORKER_DIR"
fi

# ── instructor worker ─────────────────────────────────────────────────────────
if [[ "$DO_INSTRUCTOR" -eq 1 ]]; then
  sep
  step "Setting up instructor worker (Similarity + AI pipeline)"

  # If this is an --instructor-only install, system deps may already be there;
  # if not, make sure Node.js exists at least.
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found — run without --instructor flag first"
    exit 1
  fi

  build_worker "$INSTRUCTOR_DIR" "instructor"

  if [[ ! -f "$INSTRUCTOR_DIR/.env" ]]; then
    cp "$INSTRUCTOR_DIR/.env.example" "$INSTRUCTOR_DIR/.env"
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────┐"
    echo "  │  Fill in the instructor worker config before starting:  │"
    echo "  │  nano $INSTRUCTOR_DIR/.env"
    echo "  └─────────────────────────────────────────────────────────┘"
    echo ""
    echo "  Once .env is filled in, start with:"
    echo "    systemctl start turnitin-instructor-worker"
    echo ""
  fi

  install_unit "$SCRIPT_DIR/turnitin-instructor-worker.service" \
               "turnitin-instructor-worker" \
               "$INSTRUCTOR_DIR"
fi

# ── post-install summary ──────────────────────────────────────────────────────
sep
echo ""
echo "Installation complete."
echo ""

if [[ "$DO_STUDENT" -eq 1 ]]; then
  echo "Student worker:"
  echo "  1. nano $WORKER_DIR/.env          ← fill in SUPABASE_URL + SERVICE_ROLE_KEY"
  echo "  2. systemctl start turnitin-worker"
  echo "  3. journalctl -u turnitin-worker -f --no-pager"
  echo ""
fi

if [[ "$DO_INSTRUCTOR" -eq 1 ]]; then
  echo "Instructor worker:"
  echo "  1. nano $INSTRUCTOR_DIR/.env      ← fill in keys + WORKER_ID=instructor-1"
  echo "  2. In admin UI: add instructor account, class, and assignment URL"
  echo "  3. systemctl start turnitin-instructor-worker"
  echo "  4. journalctl -u turnitin-instructor-worker -f --no-pager"
  echo ""
fi

echo "Future updates:"
echo "  sudo bash $SCRIPT_DIR/update.sh"
echo "  sudo bash $SCRIPT_DIR/update.sh --background   ← survives SSH disconnect"
echo ""
