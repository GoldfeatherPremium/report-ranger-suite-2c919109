import { chromium } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Fill these in ─────────────────────────────────────────────────────────────
const EMAIL    = process.env.TII_EMAIL    ?? "YOUR_EMAIL_HERE";
const PASSWORD = process.env.TII_PASSWORD ?? "YOUR_PASSWORD_HERE";
const LOGIN_URL    = "https://www.turnitin.com/login_page.asp";
const DASHBOARD_URL = "https://www.turnitin.com/assignment/type/paper/dashboard/167064674?lang=en_us";
const OUT_FILE = join(process.cwd(), "test-download-output.pdf");
// ─────────────────────────────────────────────────────────────────────────────

const SEL_SIMILARITY = [
  '.or-link', '[data-similarity]', '.similarity-score',
  'a[href*="viewer"]', 'a[href*="ev.turnitin"]',
  'a:has-text("%")', 'div[class*="similarity" i]',
].join(", ");

const SEL_DOWNLOAD = [
  'button[aria-label="Download"]', 'button[aria-label*="download" i]',
  'button[title*="Download" i]', 'button[data-testid*="download" i]',
  'button[class*="download" i]', '[aria-label="Download report"]',
  'a[aria-label*="download" i]',
].join(", ");

const SEL_CURRENT_VIEW = [
  'button:has-text("Current View")', 'a:has-text("Current View")',
  'li:has-text("Current View")', 'span:has-text("Current View")',
  '[data-testid*="current-view" i]',
].join(", ");

function log(msg: string) { console.log(`[${new Date().toTimeString().slice(0,8)}] ${msg}`); }

async function dump(page: import("playwright").Page) {
  log(`[diag] url=${page.url()}  frames=${page.frames().length}`);
  for (const f of page.frames()) {
    const items = await f.$$eval(
      "input, button, a[href], [role=button]",
      (els) => els.slice(0, 80).map((el) => {
        const e = el as HTMLInputElement;
        return [
          e.tagName.toLowerCase(),
          e.type ? `type=${e.type}` : "",
          e.name ? `name=${e.name}` : "",
          e.id   ? `id=${e.id}` : "",
          e.getAttribute("aria-label") ? `aria=${e.getAttribute("aria-label")}` : "",
          e.getAttribute("href") ? `href=${(e.getAttribute("href") ?? "").slice(0,60)}` : "",
          (e.textContent ?? "").trim().slice(0, 40) ? `txt=${(e.textContent ?? "").trim().slice(0,40)}` : "",
        ].filter(Boolean).join("  ");
      }),
    ).catch(() => [] as string[]);
    if (items.length) {
      log(`[diag] frame: ${f.url().slice(0, 90)}`);
      items.forEach(i => log(`[diag]   <${i}>`));
    }
  }
}

async function clickAnywhere(page: import("playwright").Page, sel: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const n = await f.locator(sel).count().catch(() => 0);
      if (n > 0) {
        try { await f.locator(sel).first().click({ timeout: 5_000 }); return true; } catch { /* retry */ }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function main() {
  if (EMAIL === "YOUR_EMAIL_HERE") {
    console.error("Set TII_EMAIL and TII_PASSWORD env vars:\n  TII_EMAIL=x TII_PASSWORD=y npx tsx src/test-download.ts");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
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
    // ── 1. Login ──────────────────────────────────────────────────────────────
    log(`logging in at ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});

    const emailSel = 'input[name="email"], input#email, input[type="email"], input[autocomplete="username"]';
    const pwdSel   = 'input[name="password"], input#password, input[name="user_password"], input[type="password"]';
    const btnSel   = 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"]';

    // fill email
    let filled = false;
    const emailDeadline = Date.now() + 30_000;
    while (Date.now() < emailDeadline && !filled) {
      for (const f of page.frames()) {
        const n = await f.locator(emailSel).count().catch(() => 0);
        if (n > 0) { try { await f.locator(emailSel).first().fill(EMAIL, { timeout: 5_000 }); filled = true; break; } catch { /* */ } }
      }
      if (!filled) await page.waitForTimeout(500);
    }
    if (!filled) { await dump(page); throw new Error("email field not found"); }
    log("email filled");

    // fill password
    filled = false;
    const pwdDeadline = Date.now() + 15_000;
    while (Date.now() < pwdDeadline && !filled) {
      for (const f of page.frames()) {
        const n = await f.locator(pwdSel).count().catch(() => 0);
        if (n > 0) { try { await f.locator(pwdSel).first().fill(PASSWORD, { timeout: 5_000 }); filled = true; break; } catch { /* */ } }
      }
      if (!filled) await page.waitForTimeout(500);
    }
    if (!filled) { await dump(page); throw new Error("password field not found"); }
    log("password filled");

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {}),
      clickAnywhere(page, btnSel, 10_000).catch(async () => { await page.keyboard.press("Enter"); }),
    ]);
    log(`logged in — url: ${page.url()}`);

    // ── 2. Go to dashboard ────────────────────────────────────────────────────
    log(`opening dashboard: ${DASHBOARD_URL}`);
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    log(`dashboard url: ${page.url()}`);

    // ── 3. Find similarity % ──────────────────────────────────────────────────
    log("looking for similarity % …");
    let simText = "";
    for (const f of page.frames()) {
      const txt = await f.locator(SEL_SIMILARITY).first().innerText({ timeout: 3_000 }).catch(() => "");
      if (/\d+\s*%/.test(txt)) { simText = txt; break; }
    }
    if (!simText) {
      log("similarity % not found — dumping page:");
      await dump(page);
      throw new Error("Similarity % not visible — share the [diag] output above");
    }
    log(`similarity found: "${simText.trim()}"`);

    // ── 4. Click % → open viewer tab ─────────────────────────────────────────
    log("clicking similarity % link …");
    const newTabPromise = ctx.waitForEvent("page", { timeout: 60_000 }).catch(() => null);
    await page.locator(SEL_SIMILARITY).first().click({ timeout: 15_000 }).catch(async (e: unknown) => {
      await dump(page);
      throw new Error(`click failed: ${e instanceof Error ? e.message : String(e)}`);
    });

    let viewer = await newTabPromise;
    if (!viewer) {
      log("no new tab — waiting for same-tab navigation to ev.turnitin.com …");
      await page.waitForURL(/ev\.turnitin\.com/, { timeout: 30_000 }).catch(() => {});
      viewer = page;
    }
    await viewer.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    log(`viewer tab: ${viewer.url()}`);

    // SPA needs time to render controls
    log("waiting 4 s for viewer SPA to render …");
    await viewer.waitForTimeout(4_000);

    // ── 5. Click download icon ────────────────────────────────────────────────
    log("clicking download icon …");
    if (!(await clickAnywhere(viewer, SEL_DOWNLOAD, 30_000))) {
      await dump(viewer);
      throw new Error("Download icon not found — share the [diag] output above");
    }
    log("download popup open");
    await viewer.waitForTimeout(1_000);

    // ── 6. Click "Current View" ───────────────────────────────────────────────
    log("clicking 'Current View' …");
    const dlEvent = viewer.waitForEvent("download", { timeout: 60_000 });
    if (!(await clickAnywhere(viewer, SEL_CURRENT_VIEW, 15_000))) {
      await dump(viewer);
      throw new Error("'Current View' not found — share the [diag] output above");
    }

    const dl = await dlEvent;
    const dlPath = await dl.path();
    if (!dlPath) throw new Error("download event fired but no file path");

    const bytes = await readFile(dlPath);
    await writeFile(OUT_FILE, bytes);

    log("─".repeat(60));
    log(`SUCCESS — ${OUT_FILE}`);
    log(`          ${(bytes.length / 1024).toFixed(1)} KB`);

  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
