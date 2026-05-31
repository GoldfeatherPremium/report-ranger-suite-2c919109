import { chromium, Browser, Page, Frame } from "playwright";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlotInfo } from "./supabase.js";

// === Selectors — adjust here if Turnitin UI shifts ===
const SEL = {
  // ── Login page ──────────────────────────────────────────────────────────────
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',

  // ── Assignment submit page ───────────────────────────────────────────────────
  submitFileButton: 'a:has-text("Submit"), button:has-text("Submit")',
  fileInput: 'input[type="file"]',
  confirmSubmit: 'button:has-text("Confirm"), input[value="Confirm"]',

  // ── Assignment dashboard — the clickable similarity-score link ───────────────
  // Turnitin renders the score as an <a class="or-link"> or a data-similarity cell.
  // Clicking it opens the viewer in a new tab (ev.turnitin.com/app/carta/e).
  similarityCell: '.or-link, [data-similarity], .similarity-score, a[href*="viewer"], a[href*="ev.turnitin"]',

  // ── Viewer (ev.turnitin.com/app/carta/e) — download icon in right panel ──────
  // Step 2: the downward-arrow icon button.  Multiple aria-label / title / class
  // fallbacks cover different Turnitin skin versions.
  downloadButton: [
    'button[aria-label="Download"]',
    'button[aria-label*="download" i]',
    'button[title*="Download" i]',
    'button[data-testid*="download" i]',
    'button[class*="download" i]',
    '[aria-label="Download report"]',
    'a[aria-label*="download" i]',
  ].join(", "),

  // ── Download popup — "Current View" option ──────────────────────────────────
  // Step 3: after the popup opens, click this to receive the PDF.
  currentViewOption: [
    'button:has-text("Current View")',
    'a:has-text("Current View")',
    'li:has-text("Current View")',
    'span:has-text("Current View")',
    '[data-testid*="current-view" i]',
  ].join(", "),
};

export type SubmissionResult = {
  pdf: Buffer;
  submissionId: string | null;
};

export async function submitToTurnitin(opts: {
  slot: SlotInfo;
  fileBytes: Buffer;
  originalName: string;
  headless: boolean;
  submissionTimeoutMs: number;
  pollIntervalMs: number;
  onProgress: (msg: string) => Promise<void>;
}): Promise<SubmissionResult> {
  const { slot, fileBytes, originalName, headless, submissionTimeoutMs, pollIntervalMs, onProgress } = opts;

  const tmp = await mkdtemp(join(tmpdir(), "tii-"));
  const filePath = join(tmp, originalName);
  await writeFile(filePath, fileBytes);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    // Present as a normal desktop Chrome. Playwright's default headless UA
    // contains "HeadlessChrome", which Turnitin and similar sites often block
    // with a challenge page that has no login form (which then looks like a
    // missing selector). A realistic UA + viewport avoids that.
    const ctx = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();

    await onProgress(`opening login: ${slot.login_url}`);
    await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});

    await onProgress(`login page loaded: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // Find and fill the email field anywhere on the page (including iframes).
    const emailOk = await fillInAnyFrame(page, SEL.emailInput, slot.email, 30_000);
    if (!emailOk) {
      await dumpPageControls(page, onProgress);
      throw new Error(
        "Could not find the Turnitin email field. The [diag] lines above list every input/button on the page — share them and I'll set the exact selectors. (The login URL may also be wrong for these accounts.)",
      );
    }
    const passwordOk = await fillInAnyFrame(page, SEL.passwordInput, slot.password, 15_000);
    if (!passwordOk) {
      await dumpPageControls(page, onProgress);
      throw new Error("Found the email field but not the password field — see the [diag] lines above.");
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      clickInAnyFrame(page, SEL.loginButton, 15_000).catch(() => page.keyboard.press("Enter")),
    ]);
    await onProgress(`after login submit: url=${page.url()} title=${await page.title().catch(() => "?")}`);

    // If the email field is still present, the login almost certainly failed
    // (wrong credentials, captcha, or an unexpected page) — surface it clearly.
    if (await locateInAnyFrame(page, SEL.emailInput)) {
      await dumpPageControls(page, onProgress);
      throw new Error("Still on a login form after submitting — login likely failed (check credentials/captcha; see [diag] lines).");
    }
    await onProgress("logged in");

    // Navigate to the slot's submit URL if provided, otherwise rely on the
    // default class list view.
    if (slot.submit_url) {
      await page.goto(slot.submit_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    await onProgress("opening submit form");
    await clickWhenVisible(page, SEL.submitFileButton, 30_000);

    await onProgress("uploading file");
    const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 30_000 }).catch(() => null);
    const directInput = await page.$(SEL.fileInput);
    if (directInput) {
      await directInput.setInputFiles(filePath);
    } else {
      const chooser = await fileChooserPromise;
      if (!chooser) throw new Error("No file chooser appeared");
      await chooser.setFiles(filePath);
    }
    await clickWhenVisible(page, SEL.confirmSubmit, 60_000).catch(() => {});

    await onProgress("waiting for similarity score");
    const submissionId = await waitForSimilarity(page, submissionTimeoutMs, pollIntervalMs, onProgress);

    await onProgress("downloading similarity PDF");
    const pdf = await downloadSimilarityPdf(page, onProgress);

    return { pdf, submissionId };
  } finally {
    await browser?.close().catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function clickWhenVisible(page: Page, selector: string, timeoutMs: number) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
  await page.locator(selector).first().click();
}

// Return the first frame (main page or any iframe) that currently contains the
// selector, or null. Turnitin sometimes renders the login inside an iframe.
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
      } catch { /* element appeared then detached; retry */ }
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
      await frame.locator(selector).first().click({ timeout: 5_000 });
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`No element matched ${selector} within ${timeoutMs}ms`);
}

// Log every input/button/link on the page (and in each iframe) so we can see
// the real DOM and pick correct selectors without a browser on the VPS.
async function dumpPageControls(page: Page, onProgress: (m: string) => Promise<void>) {
  try {
    await onProgress(`[diag] url=${page.url()} title=${await page.title().catch(() => "?")} frames=${page.frames().length}`);
    for (const f of page.frames()) {
      const controls = await f
        .$$eval("input, button, a[href], select, textarea", (els) =>
          els.slice(0, 50).map((e) => {
            const a = e as HTMLInputElement;
            return [
              a.tagName.toLowerCase(),
              a.type ? `type=${a.type}` : "",
              a.name ? `name=${a.name}` : "",
              a.id ? `id=${a.id}` : "",
              a.placeholder ? `ph=${a.placeholder}` : "",
              (a.textContent || "").trim() ? `txt=${(a.textContent || "").trim().slice(0, 25)}` : "",
            ]
              .filter(Boolean)
              .join(" ");
          }),
        )
        .catch(() => [] as string[]);
      if (controls.length) {
        await onProgress(`[diag] frame(${f.url().slice(0, 70)}):`);
        for (const c of controls) await onProgress(`[diag]   <${c}>`);
      }
    }
  } catch (e) {
    await onProgress(`[diag] dump failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function waitForSimilarity(page: Page, timeoutMs: number, pollMs: number, onProgress: (m: string) => Promise<void>): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let submissionId: string | null = null;

  while (Date.now() < deadline) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { /* ignore */ }

    // Try to extract submission id from URL or a hidden field
    const url = page.url();
    const m = url.match(/oid=(\d+)/) ?? url.match(/submission[_-]?id=(\d+)/i);
    if (m) submissionId = m[1];

    // Look for a percentage on the similarity cell
    const text = await page.locator(SEL.similarityCell).first().innerText({ timeout: 5_000 }).catch(() => "");
    if (/\d+\s*%/.test(text)) {
      await onProgress(`similarity ready: ${text.trim()}`);
      return submissionId;
    }

    await onProgress(`not ready yet, sleeping ${Math.round(pollMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Timed out waiting for similarity score");
}

// ─────────────────────────────────────────────────────────────────────────────
// Download flow (3 steps matching the Turnitin viewer UI):
//
//  Step 1 — Assignment dashboard: click the similarity-score link (e.g. "20%").
//            Turnitin opens ev.turnitin.com/app/carta/e in a new browser tab.
//
//  Step 2 — Viewer right panel: click the downward-arrow (Download) icon button.
//            A "Download" popup/modal appears.
//
//  Step 3 — Download popup: click "Current View".
//            The browser triggers a file download; capture and return the bytes.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadSimilarityPdf(
  page: Page,
  onProgress: (m: string) => Promise<void>,
): Promise<Buffer> {
  const ctx = page.context();

  // ── Step 1: open the similarity viewer ──────────────────────────────────────
  await onProgress("step1: clicking similarity score link to open viewer");
  const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

  await page.locator(SEL.similarityCell).first().click({ timeout: 15_000 }).catch(async (e: unknown) => {
    await onProgress(`similarity cell click failed (${e instanceof Error ? e.message : String(e)}), dumping page`);
    await dumpPageControls(page, onProgress);
    throw new Error("Cannot click similarity cell — check [diag] lines above for correct selector");
  });

  // Viewer may open in a new tab (most common) or navigate in the same tab.
  let viewer = await newPagePromise;
  if (!viewer) {
    await onProgress("no new tab detected — assuming same-tab navigation");
    await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
    viewer = page;
  }

  await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
  await onProgress(`step1 done: viewer url=${viewer.url()}`);

  // The viewer is a React SPA; give it time to hydrate and render controls.
  await viewer.waitForTimeout(4_000);

  // ── Step 2: click the download icon in the viewer's right panel ─────────────
  await onProgress("step2: clicking download icon button in viewer right panel");
  const downloadBtnClicked = await tryClickInAnyFrame(viewer, SEL.downloadButton, 30_000);
  if (!downloadBtnClicked) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(
      "Cannot find the download icon button in the Turnitin viewer. " +
      "See [diag] lines above — share them to tune SEL.downloadButton.",
    );
  }

  // Give the Download popup a moment to animate in.
  await viewer.waitForTimeout(1_000);

  // ── Step 3: click "Current View" in the Download popup ──────────────────────
  await onProgress("step3: clicking Current View in download popup");

  // Register the download listener BEFORE clicking so we never miss the event.
  const downloadPromise = viewer.waitForEvent("download", { timeout: 60_000 });

  const currentViewClicked = await tryClickInAnyFrame(viewer, SEL.currentViewOption, 15_000);
  if (!currentViewClicked) {
    await dumpPageControls(viewer, onProgress);
    throw new Error(
      "Cannot find the 'Current View' option in the Download popup. " +
      "See [diag] lines above — share them to tune SEL.currentViewOption.",
    );
  }

  const download = await downloadPromise;
  const filePath = await download.path();
  if (!filePath) throw new Error("Turnitin download completed but no file path was returned");

  await onProgress("download received, reading file");
  const { readFile } = await import("node:fs/promises");
  return await readFile(filePath);
}

// Like clickInAnyFrame but returns false instead of throwing when nothing is found.
async function tryClickInAnyFrame(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await clickInAnyFrame(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
