/**
 * Standalone download-flow tester.
 *
 * Logs into Turnitin using a slot's credentials, navigates to the given
 * dashboard URL, finds the similarity %, then runs the full 3-step PDF
 * download flow (click % → viewer → download icon → Current View).
 *
 * Usage:
 *   npx tsx src/test-download.ts [slot_id]
 *
 * If slot_id is omitted the first active slot in the DB is used.
 * The downloaded PDF is saved as  test-download-output.pdf  in the worker dir.
 */

import "dotenv/config";
import { chromium, Browser, Page, Frame } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { supabase, getSlotInfo } from "./supabase.js";

// ── Config ────────────────────────────────────────────────────────────────────
const DASHBOARD_URL = "https://www.turnitin.com/assignment/type/paper/dashboard/167064674?lang=en_us";
const HEADLESS = (process.env.HEADLESS ?? "true") === "true";
const OUT_FILE = join(process.cwd(), "test-download-output.pdf");

// ── Selectors (mirrors turnitin.ts SEL block) ─────────────────────────────────
const SEL = {
  emailInput: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  passwordInput: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  loginButton: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',
  similarityCell: [
    '.or-link',
    '[data-similarity]',
    '.similarity-score',
    'a[href*="viewer"]',
    'a[href*="ev.turnitin"]',
    'a:has-text("%")',
    'div[class*="similarity" i]',
  ].join(", "),
  downloadButton: [
    'button[aria-label="Download"]',
    'button[aria-label*="download" i]',
    'button[title*="Download" i]',
    'button[data-testid*="download" i]',
    'button[class*="download" i]',
    '[aria-label="Download report"]',
    'a[aria-label*="download" i]',
  ].join(", "),
  currentViewOption: [
    'button:has-text("Current View")',
    'a:has-text("Current View")',
    'li:has-text("Current View")',
    'span:has-text("Current View")',
    '[data-testid*="current-view" i]',
  ].join(", "),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg: string) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function locateInAnyFrame(page: Page, sel: string): Promise<Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator(sel).count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

async function fillInAnyFrame(page: Page, sel: string, value: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await locateInAnyFrame(page, sel);
    if (f) {
      try { await f.locator(sel).first().fill(value, { timeout: 5_000 }); return true; } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function clickInAnyFrame(page: Page, sel: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = await locateInAnyFrame(page, sel);
    if (f) {
      try { await f.locator(sel).first().click({ timeout: 5_000 }); return true; } catch { /* retry */ }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function dumpPage(page: Page) {
  log(`[diag] url=${page.url()}  frames=${page.frames().length}`);
  for (const f of page.frames()) {
    const items = await f.$$eval(
      "input, button, a[href], select, [role=button]",
      (els) => els.slice(0, 60).map((e) => {
        const a = e as HTMLInputElement;
        return [
          a.tagName.toLowerCase(),
          a.type ? `type=${a.type}` : "",
          a.name ? `name=${a.name}` : "",
          a.id ? `id=${a.id}` : "",
          a.getAttribute("aria-label") ? `aria=${a.getAttribute("aria-label")}` : "",
          a.getAttribute("href") ? `href=${(a.getAttribute("href") ?? "").slice(0, 50)}` : "",
          (a.textContent ?? "").trim() ? `txt=${(a.textContent ?? "").trim().slice(0, 40)}` : "",
        ].filter(Boolean).join("  ");
      }),
    ).catch(() => [] as string[]);
    if (items.length) {
      log(`[diag] frame: ${f.url().slice(0, 80)}`);
      for (const item of items) log(`[diag]   <${item}>`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Resolve slot
  let slotId = process.argv[2] ?? "";
  if (!slotId) {
    const { data, error } = await supabase
      .from("turnitin_slots")
      .select("id, label")
      .eq("is_active", true)
      .limit(1)
      .single();
    if (error || !data) { log(`ERROR: no active slot found: ${error?.message}`); process.exit(1); }
    slotId = data.id as string;
    log(`No slot_id given — using first active slot: ${data.label} (${slotId})`);
  }

  const slot = await getSlotInfo(slotId);
  log(`Slot:       ${slot.slot_label}`);
  log(`Email:      ${slot.email}`);
  log(`Login URL:  ${slot.login_url}`);
  log(`Dashboard:  ${DASHBOARD_URL}`);
  log(`Headless:   ${HEADLESS}`);
  log("─".repeat(60));

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  try {
    // ── Login ───────────────────────────────────────────────────────────────────
    log("step1: loading login page…");
    await page.goto(slot.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {});
    log(`       login page: ${page.url()}`);

    if (!(await fillInAnyFrame(page, SEL.emailInput, slot.email, 30_000))) {
      await dumpPage(page); throw new Error("Email field not found — see [diag] above");
    }
    log("step2: email filled");

    if (!(await fillInAnyFrame(page, SEL.passwordInput, slot.password, 15_000))) {
      await dumpPage(page); throw new Error("Password field not found — see [diag] above");
    }
    log("step3: password filled");

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      clickInAnyFrame(page, SEL.loginButton, 15_000).catch(async () => { await page.keyboard.press("Enter"); }),
    ]);
    log(`step4: login submitted — url: ${page.url()}`);

    // ── Navigate to dashboard ───────────────────────────────────────────────────
    log(`step5: navigating to dashboard: ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    log(`       dashboard loaded — url: ${page.url()}`);

    // ── Find similarity % ───────────────────────────────────────────────────────
    log("step6: looking for similarity % in all frames…");
    let similarityText = "";
    for (const f of page.frames()) {
      const txt = await f.locator(SEL.similarityCell).first().innerText({ timeout: 3_000 }).catch(() => "");
      if (/\d+\s*%/.test(txt)) { similarityText = txt; break; }
    }
    if (!similarityText) {
      log("WARNING: similarity % not found with SEL.similarityCell — dumping page for debugging:");
      await dumpPage(page);
      throw new Error("Similarity % not visible — check [diag] output above");
    }
    log(`       similarity found: "${similarityText.trim()}"`);

    // ── Download flow (3 steps) ─────────────────────────────────────────────────
    log("step7: clicking similarity % link to open viewer…");
    const newPagePromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);

    await page.locator(SEL.similarityCell).first().click({ timeout: 15_000 }).catch(async (e: unknown) => {
      await dumpPage(page);
      throw new Error(`Cannot click similarity cell: ${e instanceof Error ? e.message : String(e)}`);
    });

    let viewer = await newPagePromise;
    if (!viewer) {
      log("       no new tab — assuming same-tab navigation");
      await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
      viewer = page;
    }
    await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    log(`       viewer tab: ${viewer.url()}`);

    // SPA hydration wait
    await viewer.waitForTimeout(4_000);

    log("step8: clicking download icon in viewer right panel…");
    if (!(await clickInAnyFrame(viewer, SEL.downloadButton, 30_000))) {
      await dumpPage(viewer);
      throw new Error("Download icon not found — check [diag] output above");
    }
    log("       download popup opened");

    await viewer.waitForTimeout(1_000);

    log("step9: clicking 'Current View' in download popup…");
    const downloadPromise = viewer.waitForEvent("download", { timeout: 60_000 });

    if (!(await clickInAnyFrame(viewer, SEL.currentViewOption, 15_000))) {
      await dumpPage(viewer);
      throw new Error("'Current View' option not found — check [diag] output above");
    }

    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) throw new Error("Download completed but no file path returned");

    const pdfBytes = await readFile(dlPath);
    await writeFile(OUT_FILE, pdfBytes);
    log("─".repeat(60));
    log(`SUCCESS — PDF saved: ${OUT_FILE}`);
    log(`          Size: ${(pdfBytes.length / 1024).toFixed(1)} KB`);

  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
