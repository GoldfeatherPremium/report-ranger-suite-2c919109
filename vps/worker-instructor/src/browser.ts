import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle, type Locator } from "playwright";
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

// True if we are POSITIVELY logged in (a "Logout" control is present). This is
// more reliable than "no login form": an expired session can land on a page
// that has neither a login form nor real content, which the negative check
// would wrongly treat as logged in.
export async function isLoggedIn(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const el = await frame.$('a:has-text("Logout"), button:has-text("Logout"), a[href*="logout"]');
      if (el && await el.isVisible().catch(() => false)) return true;
    } catch { /* frame detached / cross-origin timing */ }
  }
  return false;
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
  // Let the page settle and actually paint before capturing — heavy SPA/iframe
  // transitions (Feedback Studio) otherwise yield a blank white frame.
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
  await page.evaluate(() => new Promise<void>((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res()));
  })).catch(() => {});
  await page.waitForTimeout(700);
  try {
    return await page.screenshot({ fullPage: true, animations: "disabled", timeout: 20_000 });
  } catch {
    // Some Turnitin pages never settle for a full-page shot — fall back to viewport.
    return await page.screenshot({ fullPage: false, animations: "disabled", timeout: 20_000 });
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

// Attach a file to the first <input type=file> found in any frame, even if it's
// visually hidden (Turnitin's "Browse Files" button hides the real input).
// setInputFiles does not require the input to be visible.
export async function setFileInput(page: Page, filePath: string): Promise<{ ok: boolean; frame: number }> {
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    try {
      const input = await frames[fi].$('input[type="file"]');
      if (input) {
        await input.setInputFiles(filePath);
        await input.dispose().catch(() => {});
        return { ok: true, frame: fi };
      }
    } catch { /* try next frame */ }
  }
  return { ok: false, frame: -1 };
}

export function metaOf(els: DetectedElement[]): ElementMeta[] {
  return els.map(({ handle: _h, ...m }) => m);
}

// Click a real <button> by its accessible name with a hard mouse click. Targets
// the button via role (so it never matches a same-text heading like the "Submit
// file" dialog title), WAITS until the button is enabled (e.g. while Turnitin
// builds the file preview), then issues a genuine mouse.move + mouse.click at the
// button's centre. This is the reliable way to hit Turnitin's blue Submit button.
export async function clickButtonByName(
  page: Page, name: string, waitEnabledMs = 60_000,
): Promise<{ status: string; frame: number }> {
  const deadline = Date.now() + waitEnabledMs;
  let sawButton = false;
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi];
      try {
        let btn = frame.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
        if ((await btn.count()) === 0) {
          btn = frame.getByRole("button", { name, exact: false }).filter({ visible: true }).first();
          if ((await btn.count()) === 0) continue;
        }
        sawButton = true;
        if (!(await btn.isEnabled().catch(() => false))) continue; // still disabled — keep polling
        const box = await btn.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          await page.mouse.move(cx, cy);
          await page.mouse.click(cx, cy, { delay: 60 });
        } else {
          await btn.click({ force: true, timeout: 8_000 });
        }
        return { status: "ok", frame: fi };
      } catch { /* try next frame */ }
    }
    await page.waitForTimeout(1000);
  }
  return { status: sawButton ? "stayed-disabled" : "not-found", frame: -1 };
}

// A "hard" click for elements that Stencil web components guard with pointer-
// event interception (which makes a normal Playwright click time out). Primary
// path is a forced click on the element itself — Playwright clicks the element's
// own centre and resolves iframe offsets internally, while `force` skips the
// interception/actionability assertions. Falls back to a raw coordinate click.
export async function hardClick(page: Page, target: ElementHandle | Locator): Promise<void> {
  try {
    await (target as unknown as { click: (o: object) => Promise<void> }).click({ force: true, timeout: 6_000 });
    return;
  } catch { /* fall back to a raw coordinate click */ }
  const box = await target.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
  }
}

// Click any element whose visible text contains `needle`, using Playwright's
// text engine (case-insensitive substring). Unlike the captured-element list,
// this finds plain <div>/<span> items too — e.g. Feedback Studio's dropdown
// menu items ("Resubmit file", "Submit") which aren't standard controls.
export async function clickByText(page: Page, needle: string): Promise<{ status: string; frame: number }> {
  const frames = page.frames();
  for (let fi = 0; fi < frames.length; fi++) {
    try {
      const loc = frames[fi].getByText(needle, { exact: false }).filter({ visible: true }).first();
      if ((await loc.count()) === 0) continue;
      await hardClick(page, loc);
      return { status: "ok", frame: fi };
    } catch { /* try next frame */ }
  }
  return { status: "not-found", frame: -1 };
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

// ── Replay helpers (used by the RUN engine) ──────────────────────────────────

// Hard-click the n-th element (top→bottom, left→right) whose text contains
// `needle`. Mirrors the teach-mode lane click, but extracts fresh each call.
export async function clickNthByText(page: Page, needle: string, n: number): Promise<boolean> {
  const els = await extractElements(page);
  try {
    const nd = needle.toLowerCase();
    const boxed = await Promise.all(
      els.filter((e) => e.text.toLowerCase().includes(nd))
        .map(async (e) => ({ e, box: await e.handle.boundingBox().catch(() => null) })),
    );
    boxed.sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
    if (n < 0 || n >= boxed.length) return false;
    await hardClick(page, boxed[n].e.handle);
    return true;
  } finally { await disposeAll(els); }
}

// The text of the n-th element matching `needle` (e.g. the lane's "Similarity:" cell).
export async function readNthText(page: Page, needle: string, n: number): Promise<string | null> {
  const els = await extractElements(page);
  try {
    const nd = needle.toLowerCase();
    const boxed = await Promise.all(
      els.filter((e) => e.text.toLowerCase().includes(nd))
        .map(async (e) => ({ e, box: await e.handle.boundingBox().catch(() => null) })),
    );
    boxed.sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
    return (n >= 0 && n < boxed.length) ? boxed[n].e.text : null;
  } finally { await disposeAll(els); }
}

// Read the lane's Similarity and AI Writing scores from the submissions list.
// Returns the parsed values, or null for a score that hasn't arrived yet.
// Similarity: a number 0–100. AI: "0", "*", or a number 20–100 (arrived); null = "--"/processing.
// aiTerminal: true when the AI cell shows content other than the "--" processing placeholder,
// meaning AI is in a final non-score state (excluded, unsupported, error) — stop waiting.
export async function readLaneScores(page: Page, lane: number): Promise<{ sim: string | null; ai: string | null; aiTerminal: boolean }> {
  const simText = await readNthText(page, "Similarity:", lane);
  const aiText = await readNthText(page, "AI Writing:", lane);
  const sim = simText?.match(/similarity:\s*(\d{1,3})\s*%/i)?.[1] ?? null;
  const ai = aiText?.match(/ai writing:\s*(\*|\d{1,3})\s*%/i)?.[1] ?? null;
  const aiIsProcessing = !aiText || aiText.includes("--");
  return { sim, ai, aiTerminal: !ai && !aiIsProcessing };
}

// ── Identity-based row matching ──────────────────────────────────────────────
// Turnitin's submission cells carry the document title in their accessible name
// (e.g. "Similarity: 64%. View submission for X titled <TITLE>"). Since the list
// re-sorts after a submit, we locate the worker's OWN row by the unique title it
// uploaded (the filename contains the job id) instead of by lane position.

// Read the Similarity + AI scores for the row whose title contains `titleNeedle`.
// aiTerminal: true when the AI cell has content other than the "--" processing
// placeholder, meaning AI detection is not available for this document (e.g.
// excluded, unsupported language, error icon) — stop waiting, don't expect a score.
export async function readScoresForTitle(page: Page, titleNeedle: string): Promise<{ sim: string | null; ai: string | null; aiTerminal: boolean }> {
  const els = await extractElements(page);
  try {
    const t = titleNeedle.toLowerCase();
    const simEl = els.find((e) => { const x = e.text.toLowerCase(); return x.includes("similarity:") && x.includes(t); });
    const aiEl = els.find((e) => { const x = e.text.toLowerCase(); return x.includes("ai writing:") && x.includes(t); });
    const ai = aiEl?.text.match(/ai writing:\s*(\*|\d{1,3})\s*%/i)?.[1] ?? null;
    const aiIsProcessing = !aiEl || aiEl.text.includes("--");
    return {
      sim: simEl?.text.match(/similarity:\s*(\d{1,3})\s*%/i)?.[1] ?? null,
      ai,
      aiTerminal: !ai && !aiIsProcessing,
    };
  } finally { await disposeAll(els); }
}

// Hard-click the Similarity cell of the row whose title contains `titleNeedle`.
export async function clickSimilarityForTitle(page: Page, titleNeedle: string): Promise<boolean> {
  const els = await extractElements(page);
  try {
    const t = titleNeedle.toLowerCase();
    const el = els.find((e) => { const x = e.text.toLowerCase(); return x.includes("similarity:") && x.includes(t); });
    if (!el) return false;
    await hardClick(page, el.handle);
    return true;
  } finally { await disposeAll(els); }
}

// Wait until the worker's own row (title contains `titleNeedle`) is visible.
export async function waitForTitleRow(page: Page, titleNeedle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const t = titleNeedle.toLowerCase();
  while (Date.now() < deadline) {
    const els = await extractElements(page);
    const found = els.some((e) => e.text.toLowerCase().includes(t));
    await disposeAll(els);
    if (found) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

// Poll until at least `minCount` elements contain `needle` (i.e. the list/rows
// have rendered), returning the count, or -1 on timeout. Lets replay wait for a
// slow Feedback Studio table instead of racing it with a fixed sleep.
export async function waitForCountByText(page: Page, needle: string, minCount: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const nd = needle.toLowerCase();
  while (Date.now() < deadline) {
    const els = await extractElements(page);
    const c = els.filter((e) => e.text.toLowerCase().includes(nd)).length;
    await disposeAll(els);
    if (c >= minCount) return c;
    await page.waitForTimeout(1500);
  }
  return -1;
}

// Wait until some visible element contains `needle` (any frame), up to timeoutMs.
export async function waitForText(page: Page, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const loc = frame.getByText(needle, { exact: false }).filter({ visible: true }).first();
        if ((await loc.count()) > 0) return true;
      } catch { /* frame busy */ }
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// Click the first present of several texts (e.g. ["Resubmit", "Submit"]).
export async function clickAnyText(page: Page, alts: string[]): Promise<boolean> {
  for (const t of alts) if ((await clickByText(page, t)).status === "ok") return true;
  return false;
}

// Click `text` if it's present; returns whether it clicked. Never throws.
export async function clickIfText(page: Page, text: string): Promise<boolean> {
  return (await clickByText(page, text).catch(() => ({ status: "err" as const }))).status === "ok";
}
