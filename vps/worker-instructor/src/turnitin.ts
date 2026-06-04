import { chromium, Browser, Page, Frame, type Locator } from "playwright";
import { writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssignmentInfo } from "./supabase.js";
import { aiDetectPageState } from "./ai-resolver.js";
import { findElementWithAI } from "./ai-helper.js";

// Thrown when Turnitin explicitly refuses a resubmission on the current assignment.
// The worker catches this, frees the assignment, and tries the next available one.
export class ResubmitDeniedError extends Error {
  constructor(assignmentLabel: string) {
    super(`Turnitin refused resubmission on assignment "${assignmentLabel}" — trying next assignment`);
    this.name = "ResubmitDeniedError";
  }
}

// Per-account Playwright storageState cache. Keyed by account_id so all
// assignments belonging to the same Turnitin account share one session.
type StorageStateObj = Awaited<ReturnType<import("playwright").BrowserContext["storageState"]>>;
const sessionCache = new Map<string, StorageStateObj>();

// ── Selectors ─────────────────────────────────────────────────────────────────
// Instructor (class-owner) view of Turnitin. The submit flow differs
// significantly from the student flow:
//   1. Assignment page shows a student-row table
//   2. Each empty row has a ⋮ "More" button → "Submit file" dropdown item
//   3. "Upload and Preview" (not "Upload and Review")
//   4. "Submit" button on the "Submit without preview" screen (not "Submit to Turnitin")
//   5. Viewer download uses a top-right "Download" text button with a popup menu
const SEL = {
  // ── Login ─────────────────────────────────────────────────────────────────────
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  // ── Assignment page: ⋮ button in the "More" column ────────────────────────────
  // Each student row has a three-dot button; clicking it reveals "Submit file"
  // (empty row) or "Resubmit" (used row) in the dropdown.
  moreDotsButton: [
    '[aria-label="More"]',
    '[aria-label*="more options" i]',
    '[aria-label*="more actions" i]',
    'button[title*="more" i]',
    '[data-testid*="more-actions" i]',
    '[data-testid*="more-options" i]',
    'button.p-menu-toggle',
    'button.more-actions',
    'i.p-menuitem-icon',
  ].join(", "),

  // ── "Submit file" item in the ⋮ dropdown ──────────────────────────────────────
  submitFileMenuItem: [
    'a:has-text("Submit file")',
    'button:has-text("Submit file")',
    'li:has-text("Submit file")',
    '[role="menuitem"]:has-text("Submit file")',
    'span:has-text("Submit file")',
  ].join(", "),

  // ── Submit File dialog: file area and Browse Files button ─────────────────────
  fileInput: 'input[type="file"]',
  browseFilesButton: [
    'button:has-text("Browse Files")',
    'button:has-text("Browse")',
  ].join(", "),
  // "Your device" option in the Browse Files dropdown
  yourDeviceOption: [
    'a:has-text("Your device")',
    'button:has-text("Your device")',
    'li:has-text("Your device")',
    '[role="menuitem"]:has-text("Your device")',
  ].join(", "),

  // ── Submit File dialog: title and upload button ───────────────────────────────
  submissionTitleInput: [
    'input[name="title"]',
    'input#submission_title',
    'input[placeholder*="title" i]',
    'input[aria-label*="title" i]',
    'input[name*="title" i]',
    'input[placeholder="File name"]',
    'input[placeholder*="name" i]',
  ].join(", "),

  // "Upload and Preview" — the instructor dialog uses this label (not "Upload and Review")
  uploadAndPreviewButton: [
    'button:has-text("Upload and Preview")',
    'input[value="Upload and Preview"]',
    'button:has-text("Upload and review")',
    'input[value="Upload and review"]',
  ].join(", "),

  // ── "Submit without preview" screen: blue Submit button ──────────────────────
  submitButton: [
    'button:has-text("Submit")',
    'input[value="Submit"]',
  ].join(", "),

  // ── "Submit to Turnitin" (alternative path if preview loads) ─────────────────
  submitToTurnitinButton: [
    'button:has-text("Submit to Turnitin")',
    'input[value="Submit to Turnitin"]',
    'a:has-text("Submit to Turnitin")',
  ].join(", "),

  // ── Slow-preview confirmation ─────────────────────────────────────────────────
  slowPreviewText: 'text=click confirm to complete your upload',
  confirmSlowPreview: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
  ].join(", "),

  // ── Close success/processing toasts or modals ─────────────────────────────────
  closeToastButton: [
    'button[aria-label="Close" i]',
    'button[title="Close" i]',
    '.p-toast-icon-close',
    'button.close',
    '[data-dismiss="modal"]',
    'button:has-text("×")',
    '.toast-close',
    '.notification-close',
  ].join(", "),

  // ── Resubmit-related (used rows) ──────────────────────────────────────────────
  // The used-row ⋮ dropdown shows "Resubmit file" (not just "Resubmit").
  // Clicking it opens a "Resubmit file" dialog → Confirm → same upload flow.
  resubmitMenuItem: [
    'a:has-text("Resubmit file")',
    'button:has-text("Resubmit file")',
    'li:has-text("Resubmit file")',
    '[role="menuitem"]:has-text("Resubmit file")',
    'span:has-text("Resubmit file")',
  ].join(", "),
  confirmResubmission: [
    'button:has-text("Confirm")',
    'input[value="Confirm"]',
    'a:has-text("Confirm")',
  ].join(", "),
  resubmitDenied: [
    '[class*="resubmit"][disabled]',
    '[class*="resubmit"][aria-disabled="true"]',
    'button[disabled][class*="resubmit"]',
    'input[disabled][value*="Resubmit" i]',
  ].join(", "),

  // ── Similarity score in the submission list ───────────────────────────────────
  // The score appears as a coloured badge (e.g. "11%") that is clickable and
  // opens the viewer at reports-ap.integrity.turnitin.com
  similarityCell: [
    'a[href*="submission-viewer"]',
    'a[href*="reports-ap"]',
    'a[href*="ev.turnitin"]',
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a:has-text("%")',
    'div[class*="similarity" i]',
    'span[class*="similarity" i]',
  ].join(", "),

  // ── Viewer: "Download" text button (top right of the viewer page) ─────────────
  // This is a text button, NOT a sidebar icon. It opens a popup menu with report types.
  viewerDownloadButton: [
    'button:has-text("Download")',
    'a:has-text("Download")',
    '[data-testid="download-button"]',
    '[data-testid*="download" i]',
    '[aria-label="Download"]',
    '[aria-label*="download" i]',
  ].join(", "),

  // ── Viewer download menu: report type options ─────────────────────────────────
  downloadSimilarityReport: [
    'button:has-text("Similarity Report")',
    'a:has-text("Similarity Report")',
    'li:has-text("Similarity Report")',
    '[role="menuitem"]:has-text("Similarity Report")',
    'span:has-text("Similarity Report")',
  ].join(", "),
  downloadAiWritingReport: [
    'button:has-text("AI Writing Report")',
    'a:has-text("AI Writing Report")',
    'li:has-text("AI Writing Report")',
    '[role="menuitem"]:has-text("AI Writing Report")',
    'span:has-text("AI Writing Report")',
  ].join(", "),
};

const RESUBMIT_DENIED_TEXTS: RegExp[] = [
  /cannot resubmit/i,
  /resubmission is not allowed/i,
  /resubmissions.*not.*enabled/i,
  /not allowed to resubmit/i,
  /resubmit.*not.*available/i,
  /you have \d+ resubmission.* left/i,
  /when you can submit next/i,
  /submission becomes available/i,
  /you have already submitted/i,
  /submission limit/i,
  /paper already exists/i,
];

type Logger = (msg: string) => Promise<void>;

async function smartClick(
  page: Page,
  selector: string,
  intent: string,
  log: Logger,
  timeoutMs = 8_000,
): Promise<boolean> {
  const ok = await tryClickInAnyFrame(page, selector, timeoutMs);
  if (ok) return true;
  const ai = await findElementWithAI(page, intent);
  if (!ai) return false;
  await log(`[warn] [ai-fallback] intent="${intent}" used selector=${ai.selector} — update SEL`);
  return tryClickInAnyFrame(page, ai.selector, 5_000);
}

async function smartFill(
  page: Page,
  selector: string,
  value: string,
  intent: string,
  log: Logger,
  timeoutMs = 5_000,
): Promise<boolean> {
  const ok = await fillInAnyFrame(page, selector, value, timeoutMs);
  if (ok) return true;
  const ai = await findElementWithAI(page, intent);
  if (!ai) return false;
  await log(`[warn] [ai-fallback] intent="${intent}" used selector=${ai.selector} — update SEL`);
  return fillInAnyFrame(page, ai.selector, value, 5_000);
}

async function isResubmitDenied(page: Page, onProgress: Logger): Promise<boolean> {
  if (SEL.resubmitDenied && (await locateInAnyFrame(page, SEL.resubmitDenied))) {
    await onProgress("[warn] resubmit denied detected (disabled button selector matched)");
    return true;
  }
  const body = await page.evaluate(() => document.body.innerText).catch(() => "");
  for (const pat of RESUBMIT_DENIED_TEXTS) {
    if (pat.test(body)) {
      await onProgress(`[warn] resubmit denied detected (text match: ${pat})`);
      return true;
    }
  }
  const ai = await findElementWithAI(page,
    "an error message, alert, or notice saying resubmission is not allowed or the slot is locked for resubmission");
  if (ai) {
    await onProgress(`[warn] resubmit denied detected (AI: ${ai.reasoning})`);
    return true;
  }
  return false;
}

export type InstructorSubmissionResult = {
  similarityPdf: Buffer;
  aiPdf: Buffer | null;
  submissionId: string | null;
};

export async function submitToTurnitin(opts: {
  assignment: AssignmentInfo;
  fileBytes: Buffer;
  originalName: string;
  headless: boolean;
  submissionTimeoutMs: number;
  pollIntervalMs: number;
  uploadTimeoutMs: number;
  existingSubmissionId?: string | null;
  onSubmitted?: (submissionId: string) => Promise<void>;
  onProgress: (msg: string) => Promise<void>;
}): Promise<InstructorSubmissionResult> {
  const { assignment, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs,
          uploadTimeoutMs, existingSubmissionId, onSubmitted, onProgress } = opts;

  const tmp = await mkdtemp(join(tmpdir(), "tii-instr-"));
  const filePath = join(tmp, originalName);
  await writeFile(filePath, fileBytes);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const savedState = sessionCache.get(assignment.account_id);
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      ...(savedState ? { storageState: savedState } : {}),
    });
    const page = await ctx.newPage();

    // ── Login (or reuse cached session) ────────────────────────────────────────
    let usedCachedSession = savedState != null;

    if (usedCachedSession) {
      const targetUrl = assignment.submit_url ?? assignment.login_url;
      await onProgress(`cached session found for account ${assignment.account_label} — navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      if (await locateInAnyFrame(page, SEL.emailInput)) {
        await onProgress(`cached session expired for account ${assignment.account_label} — re-logging in`);
        sessionCache.delete(assignment.account_id);
        usedCachedSession = false;
      } else {
        await onProgress(`session valid — login skipped for account ${assignment.account_label}`);
      }
    }

    if (!usedCachedSession) {
      await onProgress(`opening login: ${assignment.login_url}`);
      await page.goto(assignment.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      await onProgress(`login page: url=${page.url()} title=${await page.title().catch(() => "?")}`);

      const emailOk = await smartFill(page, SEL.emailInput, assignment.email,
        "the email or username input on the Turnitin login page", onProgress, 30_000);
      if (!emailOk) {
        await dumpPageControls(page, onProgress);
        throw new Error("Could not find Turnitin email field — see [diag] lines above.");
      }
      const passwordOk = await smartFill(page, SEL.passwordInput, assignment.password,
        "the password input on the Turnitin login page", onProgress, 15_000);
      if (!passwordOk) {
        await dumpPageControls(page, onProgress);
        throw new Error("Found email field but not password field — see [diag] lines above.");
      }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
        smartClick(page, SEL.loginButton, "the Log in submit button on the login page",
          onProgress, 15_000).catch(() => page.keyboard.press("Enter")),
      ]);
      await onProgress(`after login: url=${page.url()}`);

      if (await locateInAnyFrame(page, SEL.emailInput)) {
        const diagLines = await dumpPageControls(page, onProgress);
        const pageState = await aiDetectPageState(
          diagLines, page.url(), await page.title().catch(() => ""), onProgress,
        );
        if (pageState === "captcha") throw new Error("Login blocked by CAPTCHA — manual intervention required.");
        throw new Error("Still on login form after submitting — check credentials (see [diag] lines).");
      }
      await onProgress("logged in");

      sessionCache.set(assignment.account_id, await ctx.storageState());
      await onProgress(`session cached for account ${assignment.account_label}`);

      if (assignment.submit_url) {
        await onProgress(`navigating to assignment: ${assignment.submit_url}`);
        await page.goto(assignment.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
      }
    }

    // ── RESUME PATH ────────────────────────────────────────────────────────────
    if (existingSubmissionId) {
      await onProgress(`resuming score-wait (already submitted, id=${existingSubmissionId})`);
      const submissionId = await waitForSimilarity(page, originalName, submissionTimeoutMs, pollIntervalMs, onProgress);
      const { similarityPdf, aiPdf } = await downloadBothReports(page, onProgress);
      return { similarityPdf, aiPdf, submissionId: submissionId ?? existingSubmissionId };
    }

    // ── Step 1: find an empty student row and open "Submit file" ───────────────
    // The assignment page shows multiple student rows in a table. Each row has a
    // ⋮ button in the "More" column. For empty rows the dropdown shows "Submit file".
    // For already-used rows it shows "Resubmit". We look for any available row.
    await onProgress("step1: looking for empty student row (⋮ → Submit file)");
    let submitFileOpened = false;
    {
      const step1Deadline = Date.now() + 90_000;
      while (Date.now() < step1Deadline && !submitFileOpened) {
        // Dump controls so we can see the page structure on failure
        const allDots = await page.locator(SEL.moreDotsButton).all().catch(() => [] as Locator[]);

        if (allDots.length === 0) {
          // Try AI fallback to find the more button
          const ai = await findElementWithAI(page, "the three-dot or kebab menu button (⋮) in the More column of the student submission table row");
          if (!ai) {
            await page.waitForTimeout(1_500);
            continue;
          }
          await onProgress(`[warn] [ai-fallback] found ⋮ button via AI: ${ai.selector}`);
          // Try clicking it
          const clicked = await tryClickInAnyFrame(page, ai.selector, 5_000);
          if (!clicked) { await page.waitForTimeout(1_500); continue; }
          await page.waitForTimeout(800);
          const hasSubmitFile = (await locateInAnyFrame(page, SEL.submitFileMenuItem)) !== null;
          if (hasSubmitFile) {
            await smartClick(page, SEL.submitFileMenuItem,
              "the Submit file menu item in the dropdown", onProgress, 5_000);
            submitFileOpened = true;
          } else {
            // Close by pressing Escape
            await page.keyboard.press("Escape");
          }
          continue;
        }

        // Try each ⋮ button until we find one that opens "Submit file"
        for (const dotBtn of allDots) {
          if (submitFileOpened) break;
          try {
            const box = await dotBtn.boundingBox().catch(() => null);
            if (!box) continue;
            const cx = Math.round(box.x + box.width / 2);
            const cy = Math.round(box.y + box.height / 2);
            await page.mouse.move(cx, cy);
            await page.waitForTimeout(200);
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(800);

            const hasSubmitFile = (await locateInAnyFrame(page, SEL.submitFileMenuItem)) !== null;
            const hasResubmit   = (await locateInAnyFrame(page, SEL.resubmitMenuItem))   !== null;

            if (hasSubmitFile) {
              await onProgress("step1: found empty row — clicking 'Submit file'");
              await smartClick(page, SEL.submitFileMenuItem,
                "the Submit file menu item in the dropdown", onProgress, 5_000);
              submitFileOpened = true;
            } else if (hasResubmit) {
              await onProgress("step1: this row has existing submission — clicking 'Resubmit file'");
              if (await isResubmitDenied(page, onProgress)) {
                await onProgress("step1: resubmit denied on this row — trying next");
                await page.keyboard.press("Escape");
                await page.waitForTimeout(400);
              } else {
                await smartClick(page, SEL.resubmitMenuItem,
                  "the 'Resubmit file' menu item in the dropdown (used-row resubmit option)", onProgress, 5_000);
                await page.waitForTimeout(600);
                // "Resubmit file" dialog: "Resubmit on behalf of [student name]" → Confirm
                await onProgress("step1: 'Resubmit file' dialog — clicking Confirm");
                await smartClick(page, SEL.confirmResubmission,
                  "the Confirm button in the 'Resubmit file' confirmation dialog", onProgress, 10_000);
                await page.waitForTimeout(1_000);
                if (await isResubmitDenied(page, onProgress)) {
                  throw new ResubmitDeniedError(assignment.assignment_label);
                }
                // After Confirm, the same "Submit file" upload dialog opens — continue
                submitFileOpened = true;
              }
            } else {
              // Dropdown opened but neither option found — close and try next
              await page.keyboard.press("Escape");
              await page.waitForTimeout(300);
            }
          } catch { /* try next row */ }
        }

        if (!submitFileOpened) await page.waitForTimeout(1_000);
      }

      if (!submitFileOpened) {
        await dumpPageControls(page, onProgress);
        const diagLines = await dumpPageControls(page, onProgress);
        const pageState = await aiDetectPageState(
          diagLines, page.url(), await page.title().catch(() => ""), onProgress,
        );
        if (pageState === "captcha") throw new Error("CAPTCHA detected — manual intervention required.");
        if (pageState === "login") throw new Error("Ended up back on the login page — session may have expired.");
        throw new Error(
          "Could not find any empty student row on the assignment page. " +
          "All rows may be in cooldown or the submit_url may be wrong. See [diag] lines.",
        );
      }
    }

    // ── Step 2: attach file ────────────────────────────────────────────────────
    await onProgress("step2: attaching file to the Submit File dialog");
    // The dialog shows a drag-and-drop area + "Browse Files" button.
    // The file input is typically hidden; try to use it directly first,
    // then fall back to clicking Browse Files → Your device.
    let fileAttached = await setFileInAnyFrame(page, SEL.fileInput, filePath, 10_000);
    if (!fileAttached) {
      // Click "Browse Files" → "Your device" to reveal the file input
      await smartClick(page, SEL.browseFilesButton, "the Browse Files button in the Submit file dialog", onProgress, 10_000);
      await page.waitForTimeout(600);
      await smartClick(page, SEL.yourDeviceOption, "the Your device option in the Browse Files dropdown", onProgress, 5_000);
      await page.waitForTimeout(600);
      fileAttached = await setFileInAnyFrame(page, SEL.fileInput, filePath, 15_000);
    }
    if (!fileAttached) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not attach file to the Submit File dialog — see [diag] lines.");
    }
    await onProgress(`step2: file attached: ${originalName}`);

    // ── Step 3: submission title ───────────────────────────────────────────────
    const titleBase = originalName.replace(/\.[^.]+$/, "");
    await setTitleIfEmpty(page, SEL.submissionTitleInput, titleBase, onProgress);

    // ── Step 4: Upload and Preview ────────────────────────────────────────────
    await onProgress("step4: clicking 'Upload and Preview'");
    if (!(await smartClick(page, SEL.uploadAndPreviewButton,
      "the Upload and Preview button to upload the file and proceed to the review screen", onProgress, 30_000))) {
      await dumpPageControls(page, onProgress);
      throw new Error("Could not find 'Upload and Preview' button — see [diag] lines.");
    }

    // ── Step 5: Submit (plain "Submit" or "Submit to Turnitin" or slow Confirm) ─
    // The instructor flow shows a "Submit without preview" screen (Turnitin generates
    // a preview but it takes a while). The blue "Submit" button appears at the bottom.
    await onProgress(`step5: waiting for Submit button — up to ${Math.round(uploadTimeoutMs / 1000)}s`);
    let submissionConfirmed = false;
    {
      const step5Deadline = Date.now() + uploadTimeoutMs;
      while (Date.now() < step5Deadline && !submissionConfirmed) {
        const hasSubmit        = (await locateInAnyFrame(page, SEL.submitButton))          !== null;
        const hasSubmitTII     = (await locateInAnyFrame(page, SEL.submitToTurnitinButton)) !== null;
        const hasSlowPreview   = (await locateInAnyFrame(page, SEL.slowPreviewText))       !== null;
        const alreadySubmitted = await waitForTextInAnyFrame(page, "File submitted", 500);

        if (alreadySubmitted) {
          await onProgress("step5: detected 'File submitted' toast — submission already went through");
          submissionConfirmed = true;
        } else if (hasSubmit || hasSubmitTII) {
          const sel = hasSubmit ? SEL.submitButton : SEL.submitToTurnitinButton;
          const label = hasSubmit ? "'Submit'" : "'Submit to Turnitin'";
          await onProgress(`step5: ${label} button found — clicking`);
          // Use trusted mouse click to avoid click-jacking guards
          for (const frame of page.frames()) {
            const loc = frame.locator(sel).first();
            if ((await loc.count().catch(() => 0)) === 0) continue;
            const box = await loc.boundingBox().catch(() => null);
            if (box) {
              const cx = Math.round(box.x + box.width / 2);
              const cy = Math.round(box.y + box.height / 2);
              await page.mouse.move(cx, cy);
              await page.waitForTimeout(200);
              await page.mouse.click(cx, cy);
              submissionConfirmed = true;
              break;
            }
          }
          if (!submissionConfirmed) {
            await smartClick(page, sel, `the ${label} button to confirm submission`, onProgress, 5_000);
            submissionConfirmed = true;
          }
        } else if (hasSlowPreview) {
          await onProgress("step5: slow-preview screen — clicking 'Confirm'");
          for (const frame of page.frames()) {
            const loc = frame.locator(SEL.confirmSlowPreview).first();
            if ((await loc.count().catch(() => 0)) === 0) continue;
            const box = await loc.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
              await page.waitForTimeout(200);
              await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
              submissionConfirmed = true;
              break;
            }
          }
        } else {
          await page.waitForTimeout(500);
        }
      }
      if (!submissionConfirmed) {
        await dumpPageControls(page, onProgress);
        throw new Error("Submit button never appeared — see [diag] lines.");
      }
    }

    // ── Step 6: wait for "Your file is processing." + "File submitted successfully." ──
    await onProgress("step6: waiting for submission confirmation");
    const processingToast = await waitForTextInAnyFrame(page, "file is processing", 60_000);
    if (!processingToast) {
      await onProgress("[warn] 'Your file is processing' toast not seen — continuing anyway");
    }
    // The success toast arrives shortly after; close it
    const successToast = await waitForTextInAnyFrame(page, "submitted successfully", 60_000);
    if (successToast) {
      await onProgress("step6: 'File submitted successfully.' — closing toast");
      await tryClickInAnyFrame(page, SEL.closeToastButton, 5_000);
    } else {
      await onProgress("[warn] 'File submitted successfully' toast not seen — continuing");
    }
    await page.waitForTimeout(1_000);

    const sentinelId = await extractSubmissionIdFromPage(page) ?? "TII:submitted";
    await onSubmitted?.(sentinelId);

    // ── Step 7: wait for similarity score ─────────────────────────────────────
    await onProgress("step7: waiting for similarity score");
    const submissionId = await waitForSimilarity(page, originalName, submissionTimeoutMs, pollIntervalMs, onProgress);

    // ── Steps 8 + 9: download both PDFs from the viewer ───────────────────────
    await onProgress("step8+9: opening viewer and downloading both reports");
    const { similarityPdf, aiPdf } = await downloadBothReports(page, onProgress);

    return { similarityPdf, aiPdf, submissionId };

  } finally {
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Download both reports from the Turnitin viewer ────────────────────────────
// The instructor viewer (reports-ap.integrity.turnitin.com) has a top-right
// "Download" text button that opens a popup with:
//   • Similarity Report
//   • AI Writing Report
//   • Grading and Feedback Report
//   • Original File
// We click "Download" twice — once for Similarity, once for AI Writing.
async function downloadBothReports(
  page: Page,
  onProgress: Logger,
): Promise<{ similarityPdf: Buffer; aiPdf: Buffer | null }> {
  // Open the viewer by clicking the similarity score link
  const ctx = page.context();
  await onProgress("viewer: clicking similarity score link");
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  const simClicked = await smartClick(page, SEL.similarityCell,
    "the similarity percentage link or score badge that opens the Turnitin report viewer", onProgress, 15_000);
  if (!simClicked) {
    await dumpPageControls(page, onProgress);
    throw new Error("Cannot click similarity score — check [diag] lines for correct selector.");
  }

  let viewer = await newPagePromise;
  if (!viewer) {
    await onProgress("no new tab — assuming same-tab navigation");
    await page.waitForURL(/reports-ap\.integrity\.turnitin\.com|ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
    viewer = page;
  }

  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  await onProgress(`viewer loaded: ${viewer.url()}`);
  await viewer.waitForTimeout(6_000); // allow the viewer JS to initialise

  // ── Similarity Report ──────────────────────────────────────────────────────
  await onProgress("viewer: downloading Similarity Report");
  const similarityPdf = await downloadFromViewerMenu(viewer, SEL.downloadSimilarityReport,
    "the Similarity Report menu item in the Download popup", onProgress);

  // ── AI Writing Report (best-effort) ───────────────────────────────────────
  // If anything goes wrong, return null rather than failing the job — the
  // similarity result must never be blocked by a missing AI report.
  await onProgress("viewer: downloading AI Writing Report");
  const aiPdf = await downloadAiFromViewerMenu(viewer, onProgress);

  return { similarityPdf, aiPdf };
}

// Download a specific report by:
//  1. Clicking the "Download" text button (top right of viewer)
//  2. Clicking the specified menu item
async function downloadFromViewerMenu(
  viewer: Page,
  reportOptionSelector: string,
  reportOptionIntent: string,
  onProgress: Logger,
): Promise<Buffer> {
  const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
  downloadPromise.catch(() => {});

  // Click the "Download" button to open the popup menu
  const menuOpened = await openViewerDownloadMenu(viewer, onProgress);
  if (!menuOpened) {
    await dumpPageControls(viewer, onProgress);
    throw new Error("Could not open the Turnitin viewer Download menu — see [diag] lines.");
  }

  // Click the specific report option
  const optionClicked = await clickMenuOption(viewer, reportOptionSelector, reportOptionIntent, onProgress);
  if (!optionClicked) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(`Could not click "${reportOptionIntent}" in the Download menu — see [diag] lines.`);
  }

  const download = await downloadPromise;
  const dlPath = await download.path();
  if (!dlPath) throw new Error("Download completed but no file path returned.");
  await onProgress("report downloaded");
  return await readFile(dlPath);
}

async function downloadAiFromViewerMenu(viewer: Page, onProgress: Logger): Promise<Buffer | null> {
  try {
    const downloadPromise = viewer.waitForEvent("download", { timeout: 120_000 });
    downloadPromise.catch(() => {});

    const menuOpened = await openViewerDownloadMenu(viewer, onProgress);
    if (!menuOpened) {
      await onProgress("[warn] ai-dl: could not open Download menu — AI report marked failed");
      return null;
    }

    const optionClicked = await clickMenuOption(
      viewer, SEL.downloadAiWritingReport,
      "the AI Writing Report menu item in the Download popup", onProgress,
    );
    if (!optionClicked) {
      await onProgress("[warn] ai-dl: 'AI Writing Report' option not found — AI report marked failed");
      return null;
    }

    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) {
      await onProgress("[warn] ai-dl: download path null — AI report marked failed");
      return null;
    }
    await onProgress("ai-dl: AI Writing Report downloaded");
    return await readFile(dlPath);

  } catch (err) {
    await onProgress(`[warn] ai-dl: error downloading AI Writing Report (${err instanceof Error ? err.message : String(err)}) — marked failed`);
    return null;
  }
}

// Click the "Download" text button at the top right of the viewer.
// Returns true when the menu (with "Similarity Report" etc.) is visible.
async function openViewerDownloadMenu(viewer: Page, onProgress: Logger): Promise<boolean> {
  const DL_MENU_SENTINEL = /similarity report|ai writing report/i;

  async function menuVisible(): Promise<boolean> {
    for (const fr of viewer.frames()) {
      const txt = await fr.evaluate(() => document.body.innerText).catch(() => "");
      if (DL_MENU_SENTINEL.test(txt)) return true;
    }
    return false;
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await menuVisible()) return true;

    // Try the "Download" text button selectors
    for (const frame of viewer.frames()) {
      const loc = frame.locator(SEL.viewerDownloadButton).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await viewer.mouse.move(cx, cy);
        await viewer.waitForTimeout(300);
        await viewer.mouse.click(cx, cy);
        await viewer.waitForTimeout(1_500);
        if (await menuVisible()) return true;
      }
    }

    // AI fallback
    const ai = await findElementWithAI(viewer, "the Download button at the top right of the Turnitin report viewer page that opens a menu with Similarity Report and AI Writing Report options");
    if (ai) {
      await onProgress(`[warn] [ai-fallback] Download button via AI: ${ai.selector} — update SEL.viewerDownloadButton`);
      await tryClickInAnyFrame(viewer, ai.selector, 5_000);
      await viewer.waitForTimeout(1_500);
      if (await menuVisible()) return true;
    }

    await viewer.waitForTimeout(1_000);
  }
  return false;
}

// Click a specific item in the open Download popup menu.
async function clickMenuOption(
  viewer: Page,
  selector: string,
  intent: string,
  onProgress: Logger,
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const frame of viewer.frames()) {
      const loc = frame.locator(selector).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        await viewer.mouse.move(cx, cy);
        await viewer.waitForTimeout(200);
        await viewer.mouse.click(cx, cy);
        return true;
      }
      // Try regular click if no bounding box
      await loc.click({ timeout: 3_000 }).catch(() => {});
      return true;
    }
    // AI fallback
    const ai = await findElementWithAI(viewer, intent);
    if (ai) {
      await onProgress(`[warn] [ai-fallback] menu option via AI: ${ai.selector} — update SEL`);
      await tryClickInAnyFrame(viewer, ai.selector, 5_000);
      return true;
    }
    await viewer.waitForTimeout(400);
  }
  return false;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function locateInAnyFrame(page: Page, selector: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator(selector).count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

async function fillInAnyFrame(page: Page, selector: string, value: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await locateInAnyFrame(page, selector);
    if (frame) {
      try {
        await frame.locator(selector).first().fill(value, { timeout: 5_000 });
        return true;
      } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await locateInAnyFrame(page, selector);
    if (frame) {
      try {
        await frame.locator(selector).first().click({ timeout: 5_000 });
        return;
      } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await clickInAnyFrame(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function setFileInAnyFrame(page: Page, selector: string, filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const loc = f.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        try {
          await loc.setInputFiles(filePath, { timeout: 5_000 });
          return true;
        } catch { /* retry */ }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function setTitleIfEmpty(page: Page, selector: string, value: string, onProgress: Logger): Promise<void> {
  const frame = await locateInAnyFrame(page, selector);
  if (!frame) {
    await smartFill(page, selector, value,
      "the submission title text input in the Submit file dialog", onProgress, 5_000);
    return;
  }
  try {
    const loc = frame.locator(selector).first();
    const current = (await loc.inputValue({ timeout: 3_000 }).catch(() => "")) ?? "";
    if (!current.trim() || current.trim().toLowerCase() === "untitled" || current.trim().toLowerCase() === "file name") {
      await loc.fill(value, { timeout: 5_000 });
      await onProgress(`set submission title: ${value}`);
    }
  } catch { /* best effort */ }
}

async function waitForTextInAnyFrame(page: Page, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      if ((await f.locator(`text=${text}`).count().catch(() => 0)) > 0) return true;
      // Also check body text for partial matches
      const body = await f.evaluate(() => document.body.innerText).catch(() => "");
      if (body.toLowerCase().includes(text.toLowerCase())) return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function dumpPageControls(page: Page, onProgress: Logger): Promise<string[]> {
  const lines: string[] = [];
  try {
    const header = `[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`;
    await onProgress(header);
    lines.push(header);
    for (const f of page.frames()) {
      const controls = await f
        .$$eval("input, button, a[href], select, textarea, [role=button], [role=menuitem], li", (els) =>
          els.slice(0, 80).map((e) => {
            const a = e as HTMLInputElement;
            return [
              a.tagName.toLowerCase(),
              a.type ? `type=${a.type}` : "",
              a.name ? `name=${a.name}` : "",
              a.id ? `id=${a.id}` : "",
              a.getAttribute("aria-label") ? `aria=${a.getAttribute("aria-label")}` : "",
              a.getAttribute("data-testid") ? `testid=${a.getAttribute("data-testid")}` : "",
              a.placeholder ? `ph=${a.placeholder}` : "",
              a.className ? `cls=${a.className.toString().slice(0, 80)}` : "",
              (a.textContent || "").trim() ? `txt=${(a.textContent || "").trim().slice(0, 40)}` : "",
            ].filter(Boolean).join(" ");
          }),
        )
        .catch(() => [] as string[]);
      if (controls.length) {
        const frameHeader = `[diag] frame(${f.url().slice(0, 80)}):`;
        await onProgress(frameHeader);
        lines.push(frameHeader);
        for (const c of controls) {
          const line = `[diag]   <${c}>`;
          await onProgress(line);
          lines.push(line);
        }
      }
    }
  } catch (e) {
    await onProgress(`[diag] dump failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return lines;
}

async function extractSubmissionIdFromPage(page: Page): Promise<string | null> {
  try {
    for (const f of page.frames()) {
      // instructor viewer URL: trn:oid::3618:141639406
      const url = f.url();
      const m = url.match(/trn:oid::[\d:]+/) ?? url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
      if (m) return m[0];
      const href = await f.locator('a[href*="oid="]').first().getAttribute("href", { timeout: 2_000 }).catch(() => null);
      if (href) {
        const hm = href.match(/oid=(\d+)/);
        if (hm) return hm[1];
      }
    }
  } catch { /* best-effort */ }
  return null;
}

// Wait for a similarity score to appear in the submission list for our document.
// Prefers the row matching originalName (to avoid picking up other submissions),
// falls back to any % link if the name-based search fails.
async function waitForSimilarity(
  page: Page,
  originalName: string,
  timeoutMs: number,
  pollMs: number,
  onProgress: Logger,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;
  const titleBase = originalName.replace(/\.[^.]+$/, "").toLowerCase();

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    submissionId = submissionId ?? await extractSubmissionIdFromPage(page);

    // Look for a similarity % that is in the same row as our submission title
    const found = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("tr, [role=row]"));
      for (const row of rows) {
        const rowText = row.textContent?.toLowerCase() ?? "";
        if (!rowText.includes(title)) continue;
        const simLink = row.querySelector('a[href*="submission-viewer"], a[href*="reports-ap"], a:not([href=""])');
        if (simLink && /\d+\s*%/.test(simLink.textContent ?? "")) {
          return simLink.textContent?.trim() ?? null;
        }
      }
      return null;
    }, titleBase).catch(() => null);

    if (found) {
      await onProgress(`similarity ready: ${found}`);
      return submissionId;
    }

    // Fallback: any visible % link
    const text = await page.locator(SEL.similarityCell).first().innerText({ timeout: 3_000 }).catch(() => "");
    if (/\d+\s*%/.test(text)) {
      await onProgress(`similarity ready (fallback): ${text.trim()}`);
      return submissionId;
    }

    await onProgress(`not ready yet, sleeping ${Math.round(pollMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for similarity score");
}
