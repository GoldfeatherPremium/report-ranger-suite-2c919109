import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright";
import {
  clickByText, clickInRow, clickButtonByName, setFileInput, clickNthByText,
  readLaneScores, clickAnyText, clickIfText, homeUrlFor,
} from "./browser.js";
import {
  type Job, type AssignmentInfo, downloadSource, uploadReport, markJobSubmitted,
  markJobDone, setAiReportStatus, touchJob, logJob,
} from "./supabase.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COOLDOWN_MS = 60_000;             // sleep after submit before polling
const AI_TOTAL_TIMEOUT_MS = 20 * 60_000; // 20 min from submit for AI to arrive
const POLL_INTERVAL_MS = 30_000;
const NAV_WAIT_MS = 9_000;
const DOWNLOAD_TIMEOUT_MS = 150_000;

// Runs the learned flow for one job, in a new tab of the shared logged-in
// context. Produces the Similarity (+ AI if it arrives) report PDFs.
export async function processJob(
  ctx: BrowserContext, assignment: AssignmentInfo, job: Job, lane: number, workerId: string,
): Promise<void> {
  const log = (level: "info" | "warn" | "error", m: string) => logJob(workerId, job.id, level, m);
  const page = await ctx.newPage();
  // Use a per-job subdirectory so the file's basename = original name (what Turnitin sees).
  // Path separators are the only chars stripped to prevent traversal; everything else is kept.
  const safeName = job.original_name.replace(/[/\\]/g, "_");
  const tmpDir = join(tmpdir(), job.id);
  const tmpFile = join(tmpDir, safeName);

  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(tmpFile, await downloadSource(job.source_path));
    await log("info", `start job ${job.id} (${job.original_name}) → "${assignment.class_label}" / "${assignment.assignment_label}" lane ${lane}`);

    // 1. Home → class → assignment
    await page.goto(homeUrlFor(assignment.account.login_url), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    if ((await clickByText(page, assignment.class_label)).status !== "ok") throw new Error(`class "${assignment.class_label}" not found`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await touchJob(job.id);
    if ((await clickInRow(page, assignment.assignment_label, "View")).status !== "ok") throw new Error(`assignment "${assignment.assignment_label}" View not found`);
    await sleep(NAV_WAIT_MS);

    // 2. Open lane 3-dots → Resubmit/Submit → (Confirm)
    if (!(await clickNthByText(page, "Display actions menu", lane))) throw new Error(`lane ${lane} actions menu not found`);
    await sleep(1200);
    if (!(await clickAnyText(page, ["Resubmit", "Submit"]))) throw new Error("Resubmit/Submit not found");
    await sleep(1500);
    await clickIfText(page, "Confirm"); // optional — present only on the Resubmit path
    await sleep(2500);

    // 3. Attach → Upload and Preview → Submit
    if (!(await setFileInput(page, tmpFile)).ok) throw new Error("file input not found");
    await sleep(2500);
    if ((await clickButtonByName(page, "Upload and Preview")).status !== "ok") throw new Error("'Upload and Preview' not clickable");
    if ((await clickButtonByName(page, "Submit")).status !== "ok") throw new Error("'Submit' not clickable");
    const submittedAt = Date.now();
    await markJobSubmitted(job.id, `instructor:${assignment.assignment_id}:lane${lane}`);
    await log("info", "submitted — cooldown 60s, then poll for scores");

    // 4. Cooldown, then navigate back to the submission list and poll.
    // After submission Turnitin may redirect to a confirmation page — page.reload()
    // there would keep refreshing the confirmation rather than the submission list.
    // Navigate home→class→assignment once, then use browser F5 (page.reload()) each poll.
    await sleep(COOLDOWN_MS);
    await page.goto(homeUrlFor(assignment.account.login_url), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await touchJob(job.id);
    if ((await clickByText(page, assignment.class_label)).status !== "ok") throw new Error(`class "${assignment.class_label}" not found (post-submit nav)`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    if ((await clickInRow(page, assignment.assignment_label, "View")).status !== "ok") throw new Error(`assignment "${assignment.assignment_label}" View not found (post-submit nav)`);
    await sleep(NAV_WAIT_MS);
    let sim: string | null = null;
    let ai: string | null = null;
    let aiTerminal = false;
    while (Date.now() - submittedAt < AI_TOTAL_TIMEOUT_MS) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await sleep(4000);
      const s = await readLaneScores(page, lane);
      if (s.sim) sim = s.sim;
      if (s.ai) ai = s.ai;
      if (s.aiTerminal) aiTerminal = true;
      await touchJob(job.id);
      await log("info", `poll lane ${lane}: similarity=${sim ?? "--"} ai=${ai ?? (aiTerminal ? "n/a" : "--")}`);
      if (sim && (ai || aiTerminal)) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!sim) throw new Error("Similarity score did not arrive within 20 min");

    // 5. Open the report (opens in a new tab)
    if (!(await clickNthByText(page, "Similarity:", lane))) throw new Error("could not open the similarity report");
    await sleep(2500);
    const report = newestPage(ctx) ?? page;
    await report.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await sleep(6000);

    // 6. Download the Similarity report
    const simPdf = await captureDownload(report, async () => {
      if ((await clickButtonByName(report, "Download")).status !== "ok") throw new Error("'Download' not clickable");
      await sleep(800);
      if ((await clickByText(report, "Similarity Report")).status !== "ok") throw new Error("'Similarity Report' option not found");
    });
    await uploadReport(job.user_id, job.id, simPdf, "similarity");
    await log("info", `similarity report uploaded (${(simPdf.length / 1024).toFixed(0)} KB)`);

    // 7. Download the AI report if it arrived
    if (ai) {
      try {
        const aiPdf = await captureDownload(report, async () => {
          if ((await clickButtonByName(report, "Download")).status !== "ok") throw new Error("'Download' not clickable (AI)");
          await sleep(800);
          if ((await clickByText(report, "AI Writing Report")).status !== "ok") throw new Error("'AI Writing Report' option not found");
        });
        await uploadReport(job.user_id, job.id, aiPdf, "ai");
        await setAiReportStatus(job.id, "ready");
        await log("info", `AI report uploaded (${(aiPdf.length / 1024).toFixed(0)} KB)`);
      } catch (e) {
        await setAiReportStatus(job.id, "failed");
        await log("warn", `AI report download failed — delivering Similarity only: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      await setAiReportStatus(job.id, "failed");
      const reason = aiTerminal
        ? "AI not available for this document (non-processing icon detected)"
        : "AI score did not arrive within 20 min";
      await log("warn", `${reason} — delivering Similarity only`);
    }

    await report.close().catch(() => {});
    await markJobDone(job.id, `instructor:${assignment.assignment_id}:lane${lane}`, sim ? Number(sim) : null);
    await log("info", "job completed");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await page.close().catch(() => {});
  }
}

function newestPage(ctx: BrowserContext): Page | undefined {
  const open = ctx.pages().filter((p) => !p.isClosed());
  return open[open.length - 1];
}

async function captureDownload(page: Page, trigger: () => Promise<void>): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
    trigger(),
  ]);
  const p = await download.path();
  if (!p) throw new Error("download produced no file");
  return readFile(p);
}
