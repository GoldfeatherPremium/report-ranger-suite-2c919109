import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from "playwright";
import type { InstructorAccount, ElementMeta } from "./supabase.js";

// A detected element keeps both the persisted metadata and a LIVE Playwright
// handle. Teaching clicks the live handle (reliable, no selector guessing); the
// metadata's `selector` is what gets saved for unattended replay later.
export type DetectedElement = ElementMeta & { handle: ElementHandle };

const LOGIN = {
  email: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  password: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',
};

// Interactive elements worth surfacing to the operator.
const INTERACTIVE = "a, button, input, textarea, select, [role=button], [role=link], [role=menuitem], [onclick], [tabindex]";
const MAX_ELEMENTS = 160;

// Present as a normal desktop Chrome. Playwright's default headless UA contains
// "HeadlessChrome", which Turnitin's CloudFront WAF blocks with a 403 "Request
// blocked" page (no login form → looks like a broken selector). A realistic UA +
// viewport + locale is what the student worker uses to get through.
const REAL_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function launch(
  headless: boolean,
  storageStatePath?: string,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: REAL_UA,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { browser, context, page };
}

// True if a login form is visible (i.e. we are NOT logged in).
export async function isLoginFormPresent(page: Page): Promise<boolean> {
  return (await locateInAnyFrame(page, LOGIN.email)) != null;
}

// Persist cookies/localStorage so the next run can skip login.
export async function saveSession(context: BrowserContext, path: string): Promise<void> {
  await context.storageState({ path });
}

// The logged-in instructor home page for a given login URL's host.
export function homeUrlFor(loginUrl: string): string {
  try { return new URL(loginUrl).origin + "/t_home.asp?lang=en_us"; } catch { return loginUrl; }
}

// Best-effort login with retries. Turnitin often serves a transient error /
// interstitial page on the first hit, so we re-navigate a few times before
// giving up. Tries the main frame then any child frame for each field.
export async function login(
  page: Page,
  account: InstructorAccount,
  log: (m: string) => Promise<void> | void,
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      await log(`opening login (attempt ${a}/${attempts}): ${account.login_url}`);
      await page.goto(account.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

      const email = await locateInAnyFrame(page, LOGIN.email);
      if (!email) {
        const why = (await pageLooksLikeError(page)) ? " (looks like an error/interstitial page)" : "";
        if (a < attempts) {
          await log(`no login form yet${why} — retrying in ${3 * a}s`);
          await page.waitForTimeout(3000 * a);
          continue;
        }
        throw new Error(`Could not find the email/username field on the login page${why}.`);
      }
      await email.fill(account.email);

      const pwd = await locateInAnyFrame(page, LOGIN.password);
      if (!pwd) throw new Error("Found the email field but not the password field on the login page.");
      await pwd.fill(account.password);

      const submit = await locateInAnyFrame(page, LOGIN.submit);
      if (submit) await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {}),
        submit.click().catch(() => {}),
      ]);
      else await pwd.press("Enter").catch(() => {});

      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await log(`after login: url=${page.url()} title=${await page.title().catch(() => "?")}`);
      return;
    } catch (e) {
      lastErr = e;
      await log(`login attempt ${a} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (a < attempts) await page.waitForTimeout(3000 * a);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Heuristic: does the current page look like a Turnitin/Cloudflare error or
// interstitial rather than the real login form?
async function pageLooksLikeError(page: Page): Promise<boolean> {
  try {
    const blob = (
      (await page.title().catch(() => "")) + " " +
      (await page.locator("body").innerText({ timeout: 2000 }).catch(() => ""))
    ).toLowerCase();
    return /\b(error|denied|forbidden|unavailable|attention required|cloudflare|just a moment|429|403|404|503|too many requests|try again)\b/.test(blob);
  } catch {
    return false;
  }
}

async function locateInAnyFrame(page: Page, selector: string): Promise<ElementHandle | null> {
  for (const frame of page.frames()) {
    try {
      const h = await frame.waitForSelector(selector, { timeout: 1500, state: "visible" });
      if (h) return h;
    } catch { /* not in this frame */ }
  }
  return null;
}

export async function screenshot(page: Page): Promise<Buffer> {
  try {
    return await page.screenshot({ fullPage: true, timeout: 20_000 });
  } catch {
    // Some Turnitin pages never settle for a full-page shot — fall back to viewport.
    return await page.screenshot({ fullPage: false, timeout: 20_000 });
  }
}

// Extract clickable/fillable elements across the main frame and every iframe,
// returning live handles plus persistable metadata (including a durable selector).
export async function extractElements(page: Page): Promise<DetectedElement[]> {
  const out: DetectedElement[] = [];
  const frames = page.frames();

  for (let fi = 0; fi < frames.length && out.length < MAX_ELEMENTS; fi++) {
    let handles: ElementHandle[] = [];
    try { handles = await frames[fi].$$(INTERACTIVE); } catch { continue; }

    for (const h of handles) {
      if (out.length >= MAX_ELEMENTS) { await h.dispose().catch(() => {}); continue; }
      const meta = await h.evaluate((el: Element) => {
        const he = el as HTMLElement;
        const style = window.getComputedStyle(he);
        const rect = he.getBoundingClientRect();
        const visible = rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
        const tag = he.tagName.toLowerCase();
        const attr = (n: string) => he.getAttribute(n) ?? "";
        const inputVal = (he as HTMLInputElement).value ?? "";
        const text = (he.innerText || inputVal || attr("aria-label") || attr("placeholder") || attr("value") || attr("title") || "")
          .replace(/\s+/g, " ").trim().slice(0, 90);
        let selector = "";
        if (he.id) selector = `#${CSS.escape(he.id)}`;
        else if (attr("name")) selector = `${tag}[name="${attr("name")}"]`;
        else if (attr("aria-label")) selector = `${tag}[aria-label="${attr("aria-label")}"]`;
        else if (attr("data-testid")) selector = `${tag}[data-testid="${attr("data-testid")}"]`;
        return { tag, type: attr("type"), text, id: he.id || "", name: attr("name"), selector, visible };
      }).catch(() => null);

      if (!meta || !meta.visible) { await h.dispose().catch(() => {}); continue; }
      out.push({
        i: out.length, frame: fi, tag: meta.tag, type: meta.type, text: meta.text,
        id: meta.id, name: meta.name, selector: meta.selector, handle: h,
      });
    }
  }
  return out;
}

export function metaOf(els: DetectedElement[]): ElementMeta[] {
  return els.map(({ handle: _h, ...m }) => m);
}

// Click an in-row action link (e.g. "View") that sits on the same visual row as
// a label (e.g. an assignment name). Turnitin lists every assignment with an
// identical "View" link, so we match by geometry: pick the action element whose
// top edge is the first at/below the label's top. Robust across iframes.
export async function clickInRow(
  page: Page, rowText: string, actionText: string,
): Promise<{ status: string; frame: number }> {
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    let result: string;
    try {
      result = await frame.evaluate(({ rowText, actionText }) => {
        const norm = (s: string | null) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const want = norm(rowText);
        const act = norm(actionText);
        const all = Array.from(document.querySelectorAll("body *"));

        const exact = all.filter((e) => norm(e.textContent) === want);
        const partial = all.filter((e) => norm(e.textContent).includes(want));
        const pool = (exact.length ? exact : partial).sort(
          (a, b) => (a.textContent || "").length - (b.textContent || "").length,
        );
        const label = pool[0];
        if (!label) return "no-label";
        const labelTop = label.getBoundingClientRect().top;

        const actions = all.filter(
          (e) => (e.tagName === "A" || e.tagName === "BUTTON" || e.getAttribute("role") === "button")
            && norm(e.textContent) === act,
        );
        if (!actions.length) return "no-action";

        const withTop = actions.map((e) => ({ e, top: e.getBoundingClientRect().top }));
        const below = withTop.filter((x) => x.top >= labelTop - 12).sort((a, b) => a.top - b.top);
        const chosen = (below[0]
          ?? withTop.sort((a, b) => Math.abs(a.top - labelTop) - Math.abs(b.top - labelTop))[0]).e;

        document.querySelectorAll("[data-teach-target]").forEach((x) => x.removeAttribute("data-teach-target"));
        chosen.setAttribute("data-teach-target", "1");
        return "ok";
      }, { rowText, actionText });
    } catch { continue; }

    if (result === "ok") {
      try { await frame.click('[data-teach-target="1"]', { timeout: 15_000 }); }
      finally { await frame.evaluate(() => document.querySelectorAll("[data-teach-target]").forEach((x) => x.removeAttribute("data-teach-target"))).catch(() => {}); }
      return { status: "ok", frame: fi };
    }
  }
  return { status: "not-found", frame: -1 };
}

export async function disposeAll(els: DetectedElement[]): Promise<void> {
  await Promise.all(els.map((e) => e.handle.dispose().catch(() => {})));
}
