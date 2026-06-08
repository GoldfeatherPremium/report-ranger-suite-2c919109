#!/usr/bin/env bash
# install.sh — first-time VPS setup for the Turnitin student worker.
# Installs Node.js 20, Playwright/Chromium, builds the worker, and
# registers the systemd service.
#
# Tested on Ubuntu 22.04 / 24.04. Run as root.
#
# Usage:
#   sudo bash install.sh              # install the student worker

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root: sudo bash install.sh $*"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$SCRIPT_DIR/worker"

sep()  { echo ""; echo "══════════════════════════════════════════════════════════"; }
step() { echo "==> $*"; }

# ── system packages ───────────────────────────────────────────────────────────
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

# ── post-install summary ──────────────────────────────────────────────────────
sep
echo ""
echo "Installation complete."
echo ""

echo "Student worker:"
echo "  1. nano $WORKER_DIR/.env          ← fill in SUPABASE_URL + SERVICE_ROLE_KEY"
echo "  2. systemctl start turnitin-worker"
echo "  3. journalctl -u turnitin-worker -f --no-pager"
echo ""

echo "Future updates:"
echo "  sudo bash $SCRIPT_DIR/update.sh"
echo "  sudo bash $SCRIPT_DIR/update.sh --background   ← survives SSH disconnect"
echo ""
