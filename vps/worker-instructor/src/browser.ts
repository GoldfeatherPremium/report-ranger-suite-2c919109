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

export async function launch(headless: boolean): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { browser, context, page };
}

// Best-effort login. Tries the main frame then any child frame for each field.
export async function login(page: Page, account: InstructorAccount, log: (m: string) => Promise<void> | void): Promise<void> {
  await log(`opening login: ${account.login_url}`);
  await page.goto(account.login_url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const email = await locateInAnyFrame(page, LOGIN.email);
  if (!email) throw new Error("Could not find the email/username field on the login page (selectors may need updating).");
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

export async function disposeAll(els: DetectedElement[]): Promise<void> {
  await Promise.all(els.map((e) => e.handle.dispose().catch(() => {})));
}
