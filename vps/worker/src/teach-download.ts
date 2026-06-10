/**
 * teach-download.ts — interactive download-flow teaching session
 *
 * Runs a screenshot-guided loop so you can teach the worker exactly how to
 * navigate the Turnitin download flow on a real account.
 *
 * Usage:
 *   SLOT_ID=<supabase-slot-id> npx tsx src/teach-download.ts
 *
 * What it does:
 *   1. Logs in to Turnitin using the slot's credentials.
 *   2. Navigates to the assignment dashboard (slot.submit_url).
 *   3. Takes a screenshot, uploads it, prints the signed URL.
 *   4. Prompts you for an action (see below) and executes it.
 *   5. Waits 2 s, takes another screenshot, prints the URL.
 *   6. Repeats until you type "done" or a file download is captured.
 *   7. Saves all steps to  download-flow-<timestamp>.json  in the cwd.
 *
 * Actions:
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
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright";
import { getSlotInfo, uploadDiag } from "./supabase.js";

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

// ── Screenshot helper ─────────────────────────────────────────────────────────

let shotSeq = 0;

async function snap(page: Page, label: string): Promise<string | null> {
  try {
    await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
    const buf = await page.screenshot({ fullPage: false, animations: "disabled", timeout: 15_000 });
    const key = `${String(++shotSeq).padStart(3, "0")}-${label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40)}`;
    const url = await uploadDiag("teach-download", key, buf);
    return url;
  } catch (e) {
    console.warn(`[warn] screenshot/upload failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ── Click helpers ─────────────────────────────────────────────────────────────

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
  const slotId = process.env.SLOT_ID;
  if (!slotId) {
    console.error("Error: SLOT_ID env var is required.");
    console.error("Usage: SLOT_ID=<id> npx tsx src/teach-download.ts");
    process.exit(1);
  }

  console.log(`\nFetching slot ${slotId}…`);
  const slot = await getSlotInfo(slotId);
  console.log(`  account : ${slot.account_label} (${slot.email})`);
  console.log(`  slot    : ${slot.slot_label}`);
  console.log(`  dashboard: ${slot.submit_url ?? "(none — will stop after login)"}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const steps: RecordedStep[] = [];
  let capturedDownload: Download | null = null;
  let activePage: Page;
  let browser: Browser | null = null;

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

    // Capture downloads on any tab.
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

    const LOGIN_EMAIL = 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]';
    const LOGIN_PWD   = 'input[name="password"], input[name="user_password"], input#password, input[type="password"]';
    const LOGIN_BTN   = 'button[type="submit"], input[type="submit"], button:has-text("Log in")';

    for (const frame of activePage.frames()) {
      const email = await frame.$(LOGIN_EMAIL).catch(() => null);
      if (!email) continue;
      await email.fill(slot.email);
      const pwd = await frame.$(LOGIN_PWD).catch(() => null);
      if (pwd) await pwd.fill(slot.password);
      const btn = await frame.$(LOGIN_BTN).catch(() => null);
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

    // Check login succeeded (no email field still present).
    const stillOnLogin = await activePage.frames().reduce(async (acc, frame) => {
      if (await acc) return true;
      return !!(await frame.$(LOGIN_EMAIL).catch(() => null));
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

    // ── Wait for a similarity score to appear on the dashboard ─────────────────
    // The slot should already have a submitted paper so there's a clickable %.
    // We poll for up to 20 s; if nothing appears we show a screenshot and let
    // the operator navigate manually before typing their first action.
    console.log("\nWaiting for similarity score on dashboard (up to 20 s)…");
    const SIM_SEL = [
      '.or-link', '[data-similarity]', '.similarity-score',
      'a[href*="viewer"]', 'a[href*="ev.turnitin"]',
      'a:has-text("%")', 'div[class*="similarity" i]',
    ].join(", ");
    let simFound = false;
    const simDeadline = Date.now() + 20_000;
    while (Date.now() < simDeadline) {
      for (const frame of activePage.frames()) {
        const n = await frame.locator(SIM_SEL).count().catch(() => 0);
        if (n > 0) { simFound = true; break; }
      }
      if (simFound) break;
      await sleep(1_500);
    }

    // ── Initial screenshot ─────────────────────────────────────────────────────
    console.log(simFound
      ? "✓ Similarity score visible — dashboard ready for download teaching."
      : "⚠ No similarity score found yet. Navigate manually then type your first action.");
    const initUrl = await snap(activePage, "initial");
    console.log(`\n┌─── STARTING STATE ──────────────────────────────────────────┐`);
    console.log(`│ page  : ${activePage.url()}`);
    console.log(`│ score : ${simFound ? "VISIBLE ✓" : "not found ✗"}`);
    console.log(`│ shot  : ${initUrl ?? "(upload failed)"}`);
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
    await browser?.close().catch(() => {});
  }
}

function printShot(page: Page, url: string | null) {
  console.log(`  page  : ${page.url()}`);
  console.log(`  shot  : ${url ?? "(upload failed)"}`);
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
