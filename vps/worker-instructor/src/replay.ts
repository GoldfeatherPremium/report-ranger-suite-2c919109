import { writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright";
import {
  clickByText, clickInRow, clickButtonByName, setFileInput, clickNthByText,
  readLaneScores, clickAnyText, clickIfText, homeUrlFor, waitForCountByText,
  waitForText, screenshot,
} from "./browser.js";
import {
  type Job, type AssignmentInfo, downloadSource, uploadReport, markJobSubmitted,
  markJobDone, setAiReportStatus, touchJob, logJob, uploadDiag,
} from "./supabase.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIAG = (process.env.RUN_DIAG ?? "1") !== "0"; // per-step screenshots + verbose logs

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
  const tmpFile = join(tmpdir(), `${job.id}-${job.original_name.replace(/[^\w.\-]+/g, "_")}`);

  let diagN = 0;
  const diag = async (p: Page, label: string) => {
    if (!DIAG) return;
    try {
      const url = await uploadDiag(job.id, `${String(++diagN).padStart(2, "0")}-${label}`, await screenshot(p));
      await log("info", `[diag ${label}] url=${p.url()} shot=${url ?? "n/a"}`);
    } catch (e) { await log("warn", `[diag ${label}] ${e instanceof Error ? e.message : e}`); }
  };

  try {
    await writeFile(tmpFile, await downloadSource(job.source_path));
    await log("info", `start job ${job.id} (${job.original_name}) → "${assignment.class_label}" / "${assignment.assignment_label}" lane ${lane}`);

    // 1. Home → class → assignment
    await page.goto(homeUrlFor(assignment.account.login_url), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await diag(page, "home");
    if ((await clickByText(page, assignment.class_label)).status !== "ok") throw new Error(`class "${assignment.class_label}" not found on home`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await touchJob(job.id);
    await diag(page, "class");
    if ((await clickInRow(page, assignment.assignment_label, "View")).status !== "ok") throw new Error(`assignment "${assignment.assignment_label}" View not found`);

    // 2. Wait for the submission rows to render, then open the lane's 3-dots.
    const rows = await waitForCountByText(page, "Display actions menu", lane + 1, 45_000);
    await log("info", `submission rows visible: ${rows}`);
    await diag(page, "submissions-list");
    if (rows < 0) throw new Error(`submission list never showed ${lane + 1} rows (lane ${lane}) after View`);
    if (!(await clickNthByText(page, "Display actions menu", lane))) throw new Error(`lane ${lane} actions menu not found`);
    await sleep(1500);
    await diag(page, "menu-open");
    if (!(await waitForText(page, "Resubmit", 4_000)) && !(await waitForText(page, "Open report", 2_000))) {
      throw new Error("the 3-dots menu did not open (no Resubmit/Open report visible) — lane click had no effect");
    }

    // Resubmit (or Submit on an empty slot), then the optional Confirm.
    const rs = await clickAnyText(page, ["Resubmit", "Submit"]);
    await log("info", `clicked resubmit/submit: ${rs}`);
    if (!rs) throw new Error("Resubmit/Submit not found in the menu");
    await sleep(2000);
    const confirmed = await clickIfText(page, "Confirm");
    await log("info", `confirm dialog: ${confirmed ? "clicked" : "absent"}`);
    await sleep(2500);
    await diag(page, "upload-dialog");
    if (!(await waitForText(page, "Submit file", 6_000)) && !(await waitForText(page, "Drag and drop", 2_000))) {
      throw new Error("the upload dialog never appeared after Resubmit/Submit");
    }

    // 3. Attach → Upload and Preview → Submit
    if (!(await setFileInput(page, tmpFile)).ok) throw new Error("file input not found in the upload dialog");
    await sleep(3000);
    await diag(page, "after-attach");
    const up = await clickButtonByName(page, "Upload and Preview");
    await log("info", `'Upload and Preview' → ${up.status}`);
    if (up.status !== "ok") throw new Error("'Upload and Preview' button not clickable/enabled");
    await sleep(2000);
    await diag(page, "preview");
    const sub = await clickButtonByName(page, "Submit");
    await log("info", `'Submit' → ${sub.status}`);
    if (sub.status !== "ok") throw new Error("'Submit' button not clickable/enabled");
    await sleep(3000);
    await diag(page, "after-submit");

    // Verify the submission registered. Turnitin shows a blue "Your file is
    // processing." toast immediately, then (seconds later) a green "File
    // submitted successfully." toast — EITHER one confirms the submission.
    const processing = await waitForText(page, "file is processing", 25_000);
    const submitted = processing ? true : await waitForText(page, "submitted successfully", 15_000);
    await log("info", `submission confirmation: ${processing ? "processing toast" : submitted ? "submitted toast" : "NONE"}`);
    if (!submitted) {
      throw new Error("no submission confirmation toast (processing/submitted) appeared — submission did not register");
    }
    const submittedAt = Date.now();
    await markJobSubmitted(job.id, `instructor:${assignment.assignment_id}:lane${lane}`);
    await log("info", "submitted (confirmed) — cooldown 60s, then poll for scores");

    // 4. Cooldown + poll until both scores or 20 min from submit
    await sleep(COOLDOWN_MS);
    let sim: string | null = null;
    let ai: string | null = null;
    while (Date.now() - submittedAt < AI_TOTAL_TIMEOUT_MS) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await sleep(4000);
      const s = await readLaneScores(page, lane);
      if (s.sim) sim = s.sim;
      if (s.ai) ai = s.ai;
      await touchJob(job.id);
      await log("info", `poll lane ${lane}: similarity=${sim ?? "--"} ai=${ai ?? "--"}`);
      if (sim && ai) break;
      await sleep(POLL_INTERVAL_MS);
    }
    await diag(page, "scores");
    if (!sim) throw new Error("Similarity score did not arrive within 20 min");

    // 5. Open the report (opens in a new tab)
    await waitForCountByText(page, "Similarity:", lane + 1, 15_000);
    if (!(await clickNthByText(page, "Similarity:", lane))) throw new Error("could not open the similarity report");
    await sleep(2500);
    const report = newestPage(ctx) ?? page;
    await report.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await sleep(6000);
    await diag(report, "report-viewer");

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
      await log("warn", "AI score did not arrive within 20 min — delivering Similarity only");
    }

    await report.close().catch(() => {});
    await markJobDone(job.id, `instructor:${assignment.assignment_id}:lane${lane}`, sim ? Number(sim) : null);
    await log("info", "job completed");
  } finally {
    await unlink(tmpFile).catch(() => {});
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
