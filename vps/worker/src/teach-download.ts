/**
 * teach-download.ts — interactive download-flow teaching session
 *
 * Runs the full Turnitin submission flow automatically (steps 1–7: login →
 * detect resubmit/upload → attach file → set title → Upload and Review →
 * Submit → Submission Complete → wait for similarity score), then hands
 * control to a screenshot-guided interactive loop so you can teach the
 * worker the download flow.
 *
 * Usage (submit a new document then teach download):
 *   SLOT_ID=<id> JOB_ID=<job-uuid>       npx tsx src/teach-download.ts
 *   SLOT_ID=<id> FILE_PATH=/path/to/doc  npx tsx src/teach-download.ts
 *
 * Usage (slot already has a paper — teach download only):
 *   SLOT_ID=<id>  npx tsx src/teach-download.ts
 *
 * Actions in the interactive loop:
 *   text=<substring>     click the first visible element whose text contains this
 *   selector=<css>       click the first element matching this CSS selector
 *   coords=<x>,<y>       real mouse click at viewport coordinates (x,y)
 *   hover=<x>,<y>        move mouse to (x,y) without clicking
 *   wait=<ms>            pause for N milliseconds
 *   tab                  switch focus to the newest open browser tab
 *   screenshot           take a screenshot without performing an action
 *   done                 end the session and save
 */

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright";
import { getSlotInfo, uploadDiag, downloadSource, supabase } from "./supabase.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Types ─────────────────────────────────────────────────────────────────────

type RecordedStep = {
  n: number;
  action: string;
  urlBefore: string;
  urlAfter: string;
  screenshotUrl: string | null;
  note: string;
};

// ── Selectors ─────────────────────────────────────────────────────────────────

const SEL = {
  emailInput:   'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput:'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton:  'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  uploadSubmissionButton: [
    'button:has-text("Upload Submission")',
    'a:has-text("Upload Submission")',
    'input[value="Upload Submission"]',
  ].join(", "),

  fileInput: 'input[type="file"]',

  submissionTitleInput: [
    'input[name="title"]',
    'input#submission_title',
    'input[placeholder="Untitled" i]',
    'input[aria-label*="title" i]',
    'input[name*="title" i]',
  ].join(", "),

  uploadAndReviewButton: [
    'button:has-text("Upload and Review")',
    'input[value="Upload and Review"]',
    'a:has-text("Upload and Review")',
  ].join(", "),

  submitToTurnitinButton: [
    'button:has-text("Submit to Turnitin")',
    'input[value="Submit to Turnitin"]',
    'a:has-text("Submit to Turnitin")',
  ].join(", "),

  slowPreviewText:   'text=click confirm to complete your upload',
  confirmSlowPreview:[
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
  ].join(", "),

  closeModalButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '[data-dismiss="modal"]',
    '.modal button.close',
    'button:has-text("×")',
  ].join(", "),

  resubmitButton: [
    'input[value="Resubmit"]',
    'input[value*="resubmit" i]',
    'a[href*="resubmit"]',
    'button:has-text("Resubmit")',
    '[class*="resubmit"]',
  ].join(", "),

  confirmResubmission: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
    'a:has-text("Confirm")',
  ].join(", "),

  resubmitDenied: [
    '[class*="resubmit"][disabled]',
    '[class*="resubmit"][aria-disabled="true"]',
    'input[disabled][value*="Resubmit" i]',
    '[class*="resubmit"].disabled',
  ].join(", "),

  similarityCell: [
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a[href*="viewer"]',
    'a[href*="ev.turnitin"]',
    'a:has-text("%")',
    'div[class*="similarity" i]',
  ].join(", "),
};

const RESUBMIT_DENIED_TEXTS: RegExp[] = [
  /cannot resubmit/i,
  /resubmission is not allowed/i,
  /not allowed to resubmit/i,
  /when you can submit next/i,
  /submission becomes available/i,
  /submission limit/i,
];

// ── Screenshot helper ─────────────────────────────────────────────────────────

let shotSeq = 0;
let diagJobId = "teach-download";

async function snap(page: Page, label: string): Promise<string | null> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    const buf = await page.screenshot({ fullPage: false, animations: "disabled", timeout: 15_000 });
    const key = `${String(++shotSeq).padStart(3, "0")}-${label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40)}`;
    const url = await uploadDiag(diagJobId, key, buf);
    return url;
  } catch (e) {
    console.warn(`[warn] screenshot/upload failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ── Frame helpers (used by both submission flow and interactive loop) ──────────

async function locateInAnyFrame(page: Page, selector: string): Promise<boolean> {
  for (const f of page.frames()) {
    if ((await f.locator(selector).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      try {
        const box = await loc.boundingBox().catch(() => null);
        if (box) {
          const cx = Math.round(box.x + box.width / 2);
          const cy = Math.round(box.y + box.height / 2);
          await page.mouse.move(cx, cy);
          await page.waitForTimeout(200);
          await page.mouse.click(cx, cy);
        } else {
          await loc.click({ timeout: 3_000 });
        }
        return true;
      } catch { /* try next frame */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function setFileInAnyFrame(page: Page, selector: string, filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      try {
        await loc.setInputFiles(filePath, { timeout: 3_000 });
        return true;
      } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForTextInAnyFrame(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if ((await f.locator(`text=${text}`).count().catch(() => 0)) > 0) return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function extractSubmissionIdFromPage(page: Page): Promise<string | null> {
  try {
    for (const f of page.frames()) {
      const href = await f.locator('a[href*="oid="]').first().getAttribute("href", { timeout: 2_000 }).catch(() => null);
      if (href) { const m = href.match(/oid=(\d+)/); if (m) return m[1]; }
    }
  } catch { /* best-effort */ }
  return null;
}

async function isResubmitDenied(page: Page): Promise<boolean> {
  if (await locateInAnyFrame(page, SEL.resubmitDenied)) return true;
  const body = await page.evaluate(() => document.body.innerText).catch(() => "");
  return RESUBMIT_DENIED_TEXTS.some((p) => p.test(body));
}

// ── Submission steps 1–7 ──────────────────────────────────────────────────────
// Mirrors the production flow in turnitin.ts submitToTurnitin(), without AI helpers.

async function runSubmission(
  page: Page,
  filePath: string,
  originalName: string,
  log: (m: string) => void,
): Promise<{ submissionId: string | null; similarityPercent: number | null }> {
  const UPLOAD_TIMEOUT_MS = 600_000;   // 10 min
  const SCORE_TIMEOUT_MS  = 900_000;   // 15 min
  const POLL_MS           = 30_000;

  // ── Step 1: detect resubmit or upload button ───────────────────────────────
  log("step1: checking page — looking for existing document or upload button");
  {
    const deadline = Date.now() + 60_000;
    let done = false;
    while (Date.now() < deadline && !done) {
      const hasResubmit = await locateInAnyFrame(page, SEL.resubmitButton);
      const hasUpload   = await locateInAnyFrame(page, SEL.uploadSubmissionButton);
      if (hasResubmit) {
        log("step1: existing document detected — checking if resubmit is allowed");
        if (await isResubmitDenied(page)) {
          throw new Error("Resubmit is not allowed on this slot — try a different slot or wait for the cooldown.");
        }
        log("step1: resubmit allowed — clicking");
        await tryClickInAnyFrame(page, SEL.resubmitButton, 10_000);
        log("step1b: confirming resubmission dialog");
        await tryClickInAnyFrame(page, SEL.confirmResubmission, 15_000);
        await page.waitForTimeout(1_500);
        if (await isResubmitDenied(page)) {
          throw new Error("Resubmit denied after clicking Confirm — try a different slot.");
        }
        done = true;
      } else if (hasUpload) {
        log("step1: no existing document — fresh upload flow");
        await tryClickInAnyFrame(page, SEL.uploadSubmissionButton, 10_000);
        done = true;
      } else {
        await page.waitForTimeout(500);
      }
    }
    if (!done) throw new Error("Could not find Resubmit or 'Upload Submission' button on the dashboard after 60s.");
  }

  // ── Step 2: attach the file ────────────────────────────────────────────────
  log("step2: attaching file to Submit File dialog");
  if (!(await setFileInAnyFrame(page, SEL.fileInput, filePath, 30_000))) {
    throw new Error("Could not find the file input in Submit File dialog.");
  }
  log(`step2: attached "${originalName}"`);

  // ── Step 3: set submission title if empty / "Untitled" ────────────────────
  const titleBase = originalName.replace(/\.[^.]+$/, "");
  for (const frame of page.frames()) {
    const loc = frame.locator(SEL.submissionTitleInput).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    try {
      const current = (await loc.inputValue({ timeout: 2_000 }).catch(() => "")) ?? "";
      if (!current.trim() || current.trim().toLowerCase() === "untitled") {
        await loc.fill(titleBase, { timeout: 3_000 });
        log(`step3: set title to "${titleBase}"`);
      } else {
        log(`step3: title already set: "${current}"`);
      }
    } catch { /* best effort — don't fail over the title */ }
    break;
  }

  // ── Step 4: click "Upload and Review" ─────────────────────────────────────
  log("step4: clicking 'Upload and Review'");
  if (!(await tryClickInAnyFrame(page, SEL.uploadAndReviewButton, 30_000))) {
    throw new Error("Could not find 'Upload and Review' button.");
  }

  // ── Step 5: submit via review screen or slow-preview confirm ──────────────
  // Normal path   → "Submit to Turnitin" button on preview screen
  // Slow preview  → hourglass + "You must click confirm to complete your upload."
  log(`step5: waiting for 'Submit to Turnitin' or 'Confirm' (slow-preview) — up to ${UPLOAD_TIMEOUT_MS / 1000}s`);
  {
    const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
    let done = false;
    while (Date.now() < deadline && !done) {
      const hasSubmit      = await locateInAnyFrame(page, SEL.submitToTurnitinButton);
      const hasSlowPreview = await locateInAnyFrame(page, SEL.slowPreviewText);
      if (hasSubmit) {
        log("step5: preview screen — clicking 'Submit to Turnitin'");
        await tryClickInAnyFrame(page, SEL.submitToTurnitinButton, 10_000);
        done = true;
      } else if (hasSlowPreview) {
        log("step5: slow-preview screen — clicking 'Confirm' with real mouse event (isTrusted)");
        for (const frame of page.frames()) {
          const loc = frame.locator(SEL.confirmSlowPreview).first();
          if ((await loc.count().catch(() => 0)) === 0) continue;
          const box = await loc.boundingBox().catch(() => null);
          if (box) {
            const cx = Math.round(box.x + box.width / 2);
            const cy = Math.round(box.y + box.height / 2);
            await page.mouse.move(cx, cy);
            await page.waitForTimeout(200);
            await page.mouse.click(cx, cy);
          } else {
            await loc.click({ timeout: 3_000 }).catch(() => {});
          }
          break;
        }
        await page.waitForTimeout(2_000);
        const slowPreviewGone = !(await locateInAnyFrame(page, SEL.slowPreviewText));
        const alreadyComplete  = await waitForTextInAnyFrame(page, "Submission Complete", 3_000);
        if (slowPreviewGone || alreadyComplete) done = true;
        else log("step5: Confirm click did not register — retrying");
      } else {
        await page.waitForTimeout(500);
      }
    }
    if (!done) throw new Error("Could not find 'Submit to Turnitin' or 'Confirm' button after upload.");
  }

  // ── Step 6: wait for "Submission Complete!", close dialog ─────────────────
  log("step6: waiting for 'Submission Complete!'");
  if (!(await waitForTextInAnyFrame(page, "Submission Complete", 120_000))) {
    throw new Error("'Submission Complete!' never appeared (2 min timeout).");
  }
  await tryClickInAnyFrame(page, SEL.closeModalButton, 10_000);
  const submissionId = await extractSubmissionIdFromPage(page) ?? "TII:submitted";
  log(`step6: submission confirmed (id=${submissionId}), dialog closed`);

  // ── Step 7: reload periodically until similarity score appears ────────────
  log("step7: waiting for similarity score (reloading page)…");
  const scoreResult = await waitForSimilarity(page, SCORE_TIMEOUT_MS, POLL_MS, log);

  return { submissionId: scoreResult.submissionId ?? submissionId, similarityPercent: scoreResult.similarityPercent };
}

async function waitForSimilarity(
  page: Page,
  timeoutMs: number,
  pollMs: number,
  log: (m: string) => void,
): Promise<{ submissionId: string | null; similarityPercent: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    const url = page.url();
    const m = url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
    if (m) submissionId = m[1];
    if (!submissionId) submissionId = await extractSubmissionIdFromPage(page);

    const text = await page.locator(SEL.similarityCell).first().innerText({ timeout: 5_000 }).catch(() => "");
    const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      const pct = Number(pctMatch[1]);
      log(`step7: similarity ready — "${text.trim()}" (${pct}%)`);
      return { submissionId, similarityPercent: Number.isFinite(pct) ? pct : null };
    }

    log(`step7: not ready yet, sleeping ${Math.round(pollMs / 1000)}s`);
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for similarity score");
}

// ── Click helpers for interactive loop ────────────────────────────────────────

async function clickText(page: Page, needle: string): Promise<{ ok: boolean; note: string }> {
  for (const frame of page.frames()) {
    try {
      const loc = frame.getByText(needle, { exact: false }).filter({ visible: true }).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(200);
        await page.mouse.click(cx, cy);
      } else {
        await loc.click({ timeout: 5_000 });
      }
      return { ok: true, note: `clicked text="${needle}" in frame ${frame.url().slice(0, 60)}` };
    } catch { /* try next frame */ }
  }
  return { ok: false, note: `text="${needle}" not found in any frame` };
}

async function clickSelector(page: Page, sel: string): Promise<{ ok: boolean; note: string }> {
  for (const frame of page.frames()) {
    try {
      const loc = frame.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(200);
        await page.mouse.click(cx, cy);
      } else {
        await loc.click({ timeout: 5_000 });
      }
      return { ok: true, note: `clicked selector="${sel}" in frame ${frame.url().slice(0, 60)}` };
    } catch { /* try next frame */ }
  }
  return { ok: false, note: `selector="${sel}" not found in any frame` };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const slotId  = process.env.SLOT_ID;
  const jobId   = process.env.JOB_ID;
  const filePath = process.env.FILE_PATH;

  if (!slotId) {
    console.error("Error: SLOT_ID env var is required.");
    console.error("Usage: SLOT_ID=<id> [JOB_ID=<uuid>|FILE_PATH=<path>] npx tsx src/teach-download.ts");
    process.exit(1);
  }

  console.log(`\nFetching slot ${slotId}…`);
  const slot = await getSlotInfo(slotId);
  console.log(`  account  : ${slot.account_label} (${slot.email})`);
  console.log(`  slot     : ${slot.slot_label}`);
  console.log(`  dashboard: ${slot.submit_url ?? "(none — will stop after login)"}`);

  // Use the actual job ID for diag screenshots when available
  if (jobId) diagJobId = jobId;

  // ── Resolve file to submit (if any) ───────────────────────────────────────
  let fileBytes: Buffer | null = null;
  let originalName = "document.pdf";

  if (jobId) {
    console.log(`\nFetching job ${jobId} from Supabase…`);
    const { data: job, error } = await supabase
      .from("jobs")
      .select("source_path, original_name")
      .eq("id", jobId)
      .single();
    if (error || !job) throw new Error(`Job not found: ${jobId} — ${error?.message ?? "no data"}`);
    const row = job as { source_path: string; original_name: string };
    originalName = row.original_name;
    fileBytes = await downloadSource(row.source_path);
    console.log(`  file: "${originalName}" (${(fileBytes.length / 1024).toFixed(0)} KB)`);
  } else if (filePath) {
    console.log(`\nReading file ${filePath}…`);
    fileBytes = await readFile(filePath);
    originalName = filePath.split("/").pop() ?? "document.pdf";
    console.log(`  file: "${originalName}" (${(fileBytes.length / 1024).toFixed(0)} KB)`);
  } else {
    console.log("\nNo JOB_ID or FILE_PATH provided — skipping submission, going straight to download teaching.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const steps: RecordedStep[] = [];
  let capturedDownload: Download | null = null;
  let activePage: Page;
  let browser: Browser | null = null;
  let tmpDir: string | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    });

    const ctx: BrowserContext = await browser.newContext({
      acceptDownloads: true,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });

    const onDownload = (d: Download) => {
      capturedDownload = d;
      console.log(`\n✓ Download captured: "${d.suggestedFilename()}"`);
    };
    ctx.on("page", (p) => p.on("download", onDownload));

    activePage = await ctx.newPage();
    activePage.on("download", onDownload);

    // ── Login ──────────────────────────────────────────────────────────────────
    console.log(`\nOpening login page: ${slot.login_url}`);
    await activePage.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await activePage.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    for (const frame of activePage.frames()) {
      const email = await frame.$(SEL.emailInput).catch(() => null);
      if (!email) continue;
      await email.fill(slot.email);
      const pwd = await frame.$(SEL.passwordInput).catch(() => null);
      if (pwd) await pwd.fill(slot.password);
      const btn = await frame.$(SEL.loginButton).catch(() => null);
      if (btn) {
        await Promise.all([
          activePage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {}),
          btn.click().catch(() => {}),
        ]);
      } else {
        await activePage.keyboard.press("Enter").catch(() => {});
      }
      break;
    }

    await activePage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    console.log(`Logged in. URL: ${activePage.url()}`);

    // Check login succeeded
    const stillOnLogin = await activePage.frames().reduce(async (acc, frame) => {
      if (await acc) return true;
      return !!(await frame.$(SEL.emailInput).catch(() => null));
    }, Promise.resolve(false));
    if (stillOnLogin) {
      const shotUrl = await snap(activePage, "login-failed");
      console.error(`\n✗ Still on login page after submitting credentials.`);
      console.error(`  Screenshot: ${shotUrl ?? "(upload failed)"}`);
      console.error(`  Check the slot's email/password in the DB and try again.`);
      process.exit(1);
    }

    // ── Navigate to assignment dashboard ──────────────────────────────────────
    if (slot.submit_url) {
      console.log(`\nNavigating to assignment dashboard: ${slot.submit_url}`);
      await activePage.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await activePage.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      console.log(`Dashboard loaded. URL: ${activePage.url()}`);
    } else {
      console.warn("Warning: slot has no submit_url — staying on post-login page.");
    }

    // ── Steps 1–7: full submission flow (only when a file is provided) ────────
    if (fileBytes) {
      tmpDir = await mkdtemp(join(tmpdir(), "teach-dl-"));
      const safeName = originalName.replace(/[/\\]/g, "_");
      const tmpFile = join(tmpDir, safeName);
      await writeFile(tmpFile, fileBytes);

      console.log(`\n${"─".repeat(62)}`);
      console.log("  RUNNING SUBMISSION FLOW (steps 1–7)…");
      console.log(`${"─".repeat(62)}`);
      const shotBefore = await snap(activePage, "before-submission");
      console.log(`  Dashboard screenshot: ${shotBefore ?? "(failed)"}`);

      const { submissionId, similarityPercent } = await runSubmission(
        activePage, tmpFile, originalName,
        (m) => console.log(`  [sub] ${m}`),
      );

      const shotAfter = await snap(activePage, "after-submission");
      console.log(`\n${"─".repeat(62)}`);
      console.log(`  Submission complete!`);
      console.log(`  submission id   : ${submissionId ?? "n/a"}`);
      console.log(`  similarity score: ${similarityPercent != null ? `${similarityPercent}%` : "n/a"}`);
      console.log(`  Screenshot      : ${shotAfter ?? "(failed)"}`);
      console.log(`  Now teaching download flow — navigate to the viewer below.`);
      console.log(`${"─".repeat(62)}`);

    } else {
      // No file provided — poll for an existing similarity score on the dashboard
      console.log("\nChecking for existing similarity score on dashboard (up to 20 s)…");
      let simFound = false;
      const simDeadline = Date.now() + 20_000;
      while (Date.now() < simDeadline) {
        if (await locateInAnyFrame(activePage, SEL.similarityCell)) { simFound = true; break; }
        await sleep(1_500);
      }
      console.log(simFound
        ? "✓ Similarity score visible — dashboard ready for download teaching."
        : "⚠ No similarity score found yet. Navigate manually then type your first action.");
    }

    // ── Initial screenshot ─────────────────────────────────────────────────────
    const initUrl = await snap(activePage, "initial");
    console.log(`\n┌─── STARTING STATE ──────────────────────────────────────────┐`);
    console.log(`│ page : ${activePage.url()}`);
    console.log(`│ shot : ${initUrl ?? "(upload failed)"}`);
    console.log(`└─────────────────────────────────────────────────────────────┘`);

    // ── Interactive loop ───────────────────────────────────────────────────────
    printHelp();

    while (true) {
      const input = (await rl.question("\n> action: ")).trim();
      if (!input) continue;

      const urlBefore = activePage.url();
      let note = "";

      // ── tab ─────────────────────────────────────────────────────────────────
      if (input === "tab") {
        const pages = ctx.pages().filter((p) => !p.isClosed());
        if (pages.length > 1) {
          activePage = pages[pages.length - 1];
          note = `switched to newest tab: ${activePage.url()}`;
        } else {
          note = "only one tab open";
        }
        console.log(note);
        const shotUrl = await snap(activePage, "tab-switch");
        steps.push({ n: steps.length + 1, action: input, urlBefore, urlAfter: activePage.url(), screenshotUrl: shotUrl, note });
        printShot(activePage, shotUrl);
        continue;
      }

      // ── screenshot ──────────────────────────────────────────────────────────
      if (input === "screenshot") {
        const shotUrl = await snap(activePage, "manual");
        printShot(activePage, shotUrl);
        steps.push({ n: steps.length + 1, action: input, urlBefore, urlAfter: activePage.url(), screenshotUrl: shotUrl, note: "manual screenshot" });
        continue;
      }

      // ── done ────────────────────────────────────────────────────────────────
      if (input === "done") {
        steps.push({ n: steps.length + 1, action: "done", urlBefore, urlAfter: activePage.url(), screenshotUrl: null, note: "session ended by operator" });
        break;
      }

      // ── wait ────────────────────────────────────────────────────────────────
      if (input.startsWith("wait=")) {
        const ms = Math.max(0, Number(input.slice(5)) || 0);
        await sleep(ms);
        note = `waited ${ms} ms`;
        console.log(note);
        const shotUrl = await snap(activePage, `wait-${ms}ms`);
        steps.push({ n: steps.length + 1, action: input, urlBefore, urlAfter: activePage.url(), screenshotUrl: shotUrl, note });
        printShot(activePage, shotUrl);
        continue;
      }

      // ── hover ────────────────────────────────────────────────────────────────
      if (input.startsWith("hover=")) {
        const [x, y] = input.slice(6).split(",").map(Number);
        await activePage.mouse.move(x, y);
        await sleep(800);
        note = `hovered at (${x},${y})`;
        console.log(note);
        const shotUrl = await snap(activePage, `hover-${x}-${y}`);
        steps.push({ n: steps.length + 1, action: input, urlBefore, urlAfter: activePage.url(), screenshotUrl: shotUrl, note });
        printShot(activePage, shotUrl);
        continue;
      }

      // ── text= ────────────────────────────────────────────────────────────────
      if (input.startsWith("text=")) {
        const result = await clickText(activePage, input.slice(5));
        note = result.note;
        if (!result.ok) console.warn(`[warn] ${note}`);
        else console.log(note);
      }

      // ── selector= ────────────────────────────────────────────────────────────
      else if (input.startsWith("selector=")) {
        const result = await clickSelector(activePage, input.slice(9));
        note = result.note;
        if (!result.ok) console.warn(`[warn] ${note}`);
        else console.log(note);
      }

      // ── coords= ──────────────────────────────────────────────────────────────
      else if (input.startsWith("coords=")) {
        const [x, y] = input.slice(7).split(",").map(Number);
        await activePage.mouse.move(x, y);
        await activePage.waitForTimeout(200);
        await activePage.mouse.click(x, y);
        note = `clicked at (${x},${y})`;
        console.log(note);
      }

      else {
        console.log(`Unknown action. Type "done" to finish, or see the header for valid actions.`);
        continue;
      }

      // After any click-type action: wait for page to settle, take screenshot.
      await sleep(2_500);
      const urlAfter = activePage.url();
      const label = input.replace(/[^a-z0-9]/gi, "_").slice(0, 35);
      const shotUrl = await snap(activePage, label);
      steps.push({ n: steps.length + 1, action: input, urlBefore, urlAfter, screenshotUrl: shotUrl, note });
      printShot(activePage, shotUrl);

      if (capturedDownload) {
        console.log("\n✓ Download was triggered — ending session automatically.");
        break;
      }
    }

    // ── Save flow ──────────────────────────────────────────────────────────────
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outFile = `download-flow-${ts}.json`;
    const flow = {
      recordedAt: new Date().toISOString(),
      slotId,
      jobId: jobId ?? null,
      slotLabel: slot.slot_label,
      accountLabel: slot.account_label,
      downloadCaptured: capturedDownload !== null,
      downloadFilename: (capturedDownload as Download | null)?.suggestedFilename() ?? null,
      steps,
    };
    await writeFile(outFile, JSON.stringify(flow, null, 2));

    console.log("\n══════════════════════════════════════════════════════════════");
    console.log(`  Session complete.  Steps: ${steps.length}  Download: ${capturedDownload ? "YES ✓" : "NO ✗"}`);
    console.log(`  Flow saved to: ${outFile}`);
    console.log("══════════════════════════════════════════════════════════════");

  } finally {
    rl.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function printShot(page: Page, url: string | null) {
  console.log(`  page : ${page.url()}`);
  console.log(`  shot : ${url ?? "(upload failed)"}`);
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           DOWNLOAD FLOW TEACHING SESSION                     ║
╠══════════════════════════════════════════════════════════════╣
║  text=<substring>    click visible element with this text    ║
║  selector=<css>      click element matching CSS selector     ║
║  coords=<x>,<y>      real mouse click at viewport coords     ║
║  hover=<x>,<y>       move mouse (reveals hidden toolbars)    ║
║  wait=<ms>           pause N milliseconds                    ║
║  tab                 switch to the newest open tab           ║
║  screenshot          take a screenshot without clicking      ║
║  done                end session and save                    ║
║                                                              ║
║  After each action a screenshot is uploaded and the          ║
║  signed URL is printed so you can see what the worker sees.  ║
╚══════════════════════════════════════════════════════════════╝`);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
