import "./load-env.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, login, isLoggedIn, saveSession, homeUrlFor } from "./browser.js";
import {
  getInstructorAccount, claimNextInstructorJob, ownsLane, getAssignmentInfo,
  requeueJob, markJobFailed, heartbeat, logJob, log,
} from "./supabase.js";
import { processJob } from "./replay.js";
import type { BrowserContext } from "playwright";

function num(k: string, d: number): number { const v = Number(process.env[k]); return v > 0 ? v : d; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WORKER_ID    = process.env.WORKER_ID ?? `instructor-${process.pid}`;
const HEADLESS     = (process.env.HEADLESS ?? "true") === "true";
const CONCURRENCY  = num("CONCURRENCY", 3);
const CLAIM_IDLE_MS = num("CLAIM_IDLE_MS", 10_000);
const HEARTBEAT_MS  = num("HEARTBEAT_MS", 30_000);
const JOB_TIMEOUT_MS = num("JOB_TIMEOUT_MS", 3_600_000);

let activeJobs = 0;
let shuttingDown = false;

function sessionFile(): string {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `run-${WORKER_ID}.json`);
}

async function heartbeatLoop() {
  while (!shuttingDown) {
    try { await heartbeat(WORKER_ID, activeJobs); } catch (e) { console.error("heartbeat", e); }
    await sleep(HEARTBEAT_MS);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`job exceeded ${Math.round(ms / 60000)} min`)), ms));
}

async function workerLoop(ctx: BrowserContext) {
  while (!shuttingDown) {
    let claimedId: string | null = null;
    try {
      const job = await claimNextInstructorJob(WORKER_ID);
      if (!job) { await sleep(CLAIM_IDLE_MS); continue; }
      claimedId = job.id;
      activeJobs++;
      try {
        if (!job.instructor_assignment_id) { await requeueJob(job.id, "claimed without an assignment"); continue; }
        if (!(await ownsLane(job.id))) { await requeueJob(job.id, "lost the lane race — requeued"); continue; }
        const assignment = await getAssignmentInfo(job.instructor_assignment_id);
        const lane = job.instructor_lane ?? 0;
        await Promise.race([processJob(ctx, assignment, job, lane, WORKER_ID), timeout(JOB_TIMEOUT_MS)]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await logJob(WORKER_ID, job.id, "error", `job failed: ${msg}`);
        await markJobFailed(job.id, job.attempts, job.max_attempts, msg);
      } finally { activeJobs--; }
    } catch (e) {
      console.error("loop error", e);
      if (claimedId) { try { await requeueJob(claimedId, "loop error"); } catch { /* ignore */ } }
      await sleep(CLAIM_IDLE_MS);
    }
  }
}

async function main() {
  console.log(`turnitin-instructor-worker ${WORKER_ID} — RUN mode (headless=${HEADLESS}, concurrency=${CONCURRENCY})`);

  // One shared, logged-in browser session; every lane/job opens its own tab.
  const account = await getInstructorAccount(process.env.RUN_ACCOUNT_LABEL);
  const sessionPath = sessionFile();
  const { browser, context, page } = await launch(HEADLESS, existsSync(sessionPath) ? sessionPath : undefined);

  let loggedIn = false;
  if (existsSync(sessionPath)) {
    try {
      await page.goto(homeUrlFor(account.login_url), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      loggedIn = await isLoggedIn(page);
    } catch { /* fall through */ }
  }
  if (!loggedIn) {
    await login(page, account, (m) => console.log(`  · ${m}`));
    loggedIn = await isLoggedIn(page);
  }
  if (!loggedIn) { await log(WORKER_ID, "error", "could not log in — check credentials"); process.exit(1); }
  await saveSession(context, sessionPath).catch(() => {});
  await log(WORKER_ID, "info", `logged in as ${account.label} <${account.email}> — starting ${CONCURRENCY} lane workers`);

  void heartbeatLoop();
  process.on("SIGINT", () => { shuttingDown = true; setTimeout(() => process.exit(0), 5_000); });
  process.on("SIGTERM", () => { shuttingDown = true; setTimeout(() => process.exit(0), 5_000); });

  await Promise.all(Array.from({ length: CONCURRENCY }, () => workerLoop(context)));
  await browser.close().catch(() => {});
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
