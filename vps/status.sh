#!/usr/bin/env bash
# Worker status & flow-settings inspector for the student worker.
# Run from anywhere on the VPS: bash /root/report-ranger-suite/vps/status.sh
#
# Usage:
#   bash status.sh              # show the student worker

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$REPO_DIR/vps/worker"

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

hr()  { echo -e "${CYN}────────────────────────────────────────────────────────────────${NC}"; }
hdr() { hr; echo -e "${BOLD}  $1${NC}"; hr; }

ms_to_human() {
  local ms=$1
  if   (( ms >= 60000 )); then echo "$((ms/60000)) min $((ms%60000/1000)) s"
  elif (( ms >= 1000  )); then echo "$((ms/1000)) s"
  else echo "${ms} ms"
  fi
}

# ── helper: print settings from a .env file ──────────────────────────────────
print_worker_settings() {
  local env_file="$1"
  local label="$2"

  if [[ ! -f "$env_file" ]]; then
    echo -e "  ${RED}ERROR: .env not found at $env_file${NC}"
    return 1
  fi

  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' "$env_file" | grep -v '^\s*$' | xargs)

  local worker_id="${WORKER_ID:-unknown}"
  local headless="${HEADLESS:-true}"
  local sub_timeout="${SUBMISSION_TIMEOUT_MS:-900000}"
  local upload_timeout="${UPLOAD_TIMEOUT_MS:-600000}"
  local poll_interval="${POLL_INTERVAL_MS:-30000}"
  local claim_idle="${CLAIM_IDLE_MS:-10000}"
  local heartbeat="${HEARTBEAT_MS:-30000}"
  local concurrency="${CONCURRENCY:-3}"

  num_or_default() { local v; v=$(echo "$1" | tr -d '[:space:]'); [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]] && echo "$v" || echo "$2"; }
  sub_timeout=$(num_or_default "$sub_timeout" 900000)
  upload_timeout=$(num_or_default "$upload_timeout" 600000)
  poll_interval=$(num_or_default "$poll_interval" 30000)
  claim_idle=$(num_or_default "$claim_idle" 10000)
  heartbeat=$(num_or_default "$heartbeat" 30000)

  echo -e "  Worker ID              : ${BOLD}$worker_id${NC}"
  echo -e "  Headless browser       : ${BOLD}$headless${NC}"
  echo -e "  Concurrency            : ${BOLD}$concurrency${NC}"
  echo ""
  echo -e "  Submission timeout     : ${BOLD}$(ms_to_human $sub_timeout)${NC}"
  echo -e "  Upload timeout         : ${BOLD}$(ms_to_human $upload_timeout)${NC}"
  echo -e "  Poll interval          : ${BOLD}$(ms_to_human $poll_interval)${NC}"
  echo -e "  Claim idle sleep       : ${BOLD}$(ms_to_human $claim_idle)${NC}"
  echo -e "  Heartbeat interval     : ${BOLD}$(ms_to_human $heartbeat)${NC}"

  for KEY in SUBMISSION_TIMEOUT_MS UPLOAD_TIMEOUT_MS POLL_INTERVAL_MS; do
    RAW=$(grep -E "^${KEY}[[:space:]]*=" "$env_file" | cut -d= -f2 | tr -d '[:space:]' || true)
    if [[ -z "$RAW" || "$RAW" == "0" ]]; then
      echo -e "  ${RED}WARNING: $KEY is blank/zero in .env — using fallback${NC}"
    fi
  done
}

# ── helper: systemd status ───────────────────────────────────────────────────
print_service_status() {
  local svc="$1"
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    echo -e "  Status  : ${GRN}RUNNING${NC}"
    systemctl status "$svc" --no-pager -l 2>/dev/null | grep -E "Active:|PID:|Memory:" | sed 's/^/  /'
  else
    echo -e "  Status  : ${RED}NOT RUNNING${NC}"
    echo -e "  Start   : systemctl start $svc"
  fi
}

# ── 1. Student worker ────────────────────────────────────────────────────────
echo ""
hdr "STUDENT WORKER (Similarity-only pipeline)"
print_worker_settings "$WORKER_DIR/.env" "student"
echo ""
hdr "STUDENT SERVICE STATUS"
print_service_status "turnitin-worker"

# ── 2. Code version ──────────────────────────────────────────────────────────
echo ""
hdr "CODE VERSION"
cd "$REPO_DIR"
echo -e "  Branch  : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo -e "  Commit  : $(git rev-parse --short HEAD 2>/dev/null || echo '?')"

echo -e "  Student built   : $(stat -c '%y' "$WORKER_DIR/dist/index.js" 2>/dev/null | cut -d. -f1 || echo 'not built')"

REMOTE_SHA=$(git rev-parse "origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null || echo '')
LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
if [[ -n "$REMOTE_SHA" && "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo -e "  ${YEL}Behind remote — run: sudo bash $REPO_DIR/vps/update.sh${NC}"
else
  echo -e "  Up to date with remote"
fi

# ── 3. Supabase checks ───────────────────────────────────────────────────────
ENV_FILE="$WORKER_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo -e "${YEL}Skipping DB checks — .env not found${NC}"
  exit 0
fi

# shellcheck disable=SC2046
export $(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo -e "${YEL}Skipping DB checks — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set${NC}"
  exit 0
fi

API="$SUPABASE_URL/rest/v1"
AUTH=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

db_get() { curl -sf "${AUTH[@]}" -H "Accept: application/json" "$API/$1" 2>/dev/null || echo "[]"; }

# ── Student slots ─────────────────────────────────────────────────────────────
echo ""
hdr "STUDENT SLOTS"
SLOTS=$(db_get "turnitin_slots?select=id,label,submit_url,cooldown_hours,is_active&order=created_at")
COUNT=$(echo "$SLOTS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "?")
echo -e "  Total slots: ${BOLD}$COUNT${NC}"
echo "$SLOTS" | python3 -c "
import sys, json
slots = json.load(sys.stdin)
for s in slots:
    active = '✓ active' if s.get('is_active') else '✗ disabled'
    url = (s.get('submit_url') or '—')[:60]
    print(f'  [{active}] {s[\"label\"]}  cooldown={s[\"cooldown_hours\"]}h  url={url}')
" 2>/dev/null || echo "  (could not parse slots)"

echo ""
hdr "STUDENT SLOT USAGE (currently in use)"
USAGE=$(db_get "turnitin_slot_usage?select=slot_id,job_id,submitted_at,freed_at&freed_at=is.null&order=submitted_at.desc")
echo "$USAGE" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
if not rows:
    print('  All slots are free')
else:
    for r in rows:
        print(f\"  slot={r['slot_id'][:8]}...  job={r['job_id'][:8]}...  since={r['submitted_at'][:19]}\")
" 2>/dev/null || echo "  (could not parse usage)"

# ── Jobs ──────────────────────────────────────────────────────────────────────
echo ""
hdr "RECENT JOBS"
JOBS=$(db_get "jobs?select=id,status,original_name,pipeline,attempts,max_attempts,error,created_at,turnitin_submission_id,ai_report_status&order=created_at.desc&limit=20")
echo "$JOBS" | python3 -c "
import sys, json
jobs = json.load(sys.stdin)
if not jobs:
    print('  No jobs found')
    sys.exit()
from collections import Counter
counts = Counter((j['pipeline'], j['status']) for j in jobs)
print('  Status summary (last 20):')
for (pl, st), n in sorted(counts.items()):
    print(f'    [{pl}] {st}: {n}')
print()
print('  Recent jobs:')
for j in jobs[:15]:
    name = (j.get('original_name') or '?')[:30]
    pl   = j.get('pipeline','?')
    err  = ('  ERR: ' + j['error'][:50]) if j.get('error') else ''
    sub  = '  [submitted]' if j.get('turnitin_submission_id') else ''
    print(f\"  [{pl:10}] {j['status']:12}  {j['attempts']}/{j['max_attempts']} att  {name}{sub}{err}\")
" 2>/dev/null || echo "  (could not parse jobs)"

# ── Worker health ────────────────────────────────────────────────────────────
echo ""
hdr "WORKER HEALTH (DB heartbeat)"
HEALTH=$(db_get "worker_health?select=worker_id,last_seen,active_jobs,status")
echo "$HEALTH" | python3 -c "
import sys, json
from datetime import datetime, timezone
rows = json.load(sys.stdin)
if not rows:
    print('  No heartbeat recorded — workers may not have started yet')
    sys.exit()
for r in rows:
    try:
        last = datetime.fromisoformat(r['last_seen'].replace('Z','+00:00'))
        age  = int((datetime.now(timezone.utc) - last).total_seconds())
        age_str = f'{age}s ago' if age < 120 else f'{age//60}m ago'
        stale = '  ⚠ STALE' if age > 120 else ''
    except Exception:
        age_str = r['last_seen'][:19]; stale = ''
    print(f\"  worker={r['worker_id']}  status={r['status']}  active_jobs={r['active_jobs']}  last_seen={age_str}{stale}\")
" 2>/dev/null || echo "  (could not parse health)"

# ── Last 10 worker log lines ─────────────────────────────────────────────────
echo ""
hdr "LAST 10 WORKER LOG LINES (from DB)"
LOGS=$(db_get "worker_logs?select=created_at,worker_id,level,message&order=created_at.desc&limit=10")
echo "$LOGS" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
for r in reversed(rows):
    ts  = r['created_at'][11:19]
    wid = r.get('worker_id','?')[:20]
    lvl = r['level'].upper()[:5]
    msg = (r.get('message') or '')[:100]
    print(f'  [{ts}] [{wid}] [{lvl}] {msg}')
" 2>/dev/null || echo "  (could not fetch logs)"

hr
echo ""
echo -e "  Full live logs  : ${BOLD}journalctl -u turnitin-worker -f${NC}"
echo -e "  Restart worker  : ${BOLD}systemctl restart turnitin-worker${NC}"
echo -e "  Update code     : ${BOLD}sudo bash $REPO_DIR/vps/update.sh${NC}"
echo ""