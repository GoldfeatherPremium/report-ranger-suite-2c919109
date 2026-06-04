import type { Page } from "playwright";
import { locateByVision } from "./vision.js";

// Three-tier element resolver. Tier 1 (DOM) is supplied by the caller; on
// failure we fall back to Tier 2 (vision → coordinate click), and Tier 3 is
// "log + screenshot + give up" so the caller can escalate/retry. Every tier is
// gated behind a postcondition: a click that doesn't change page state is
// treated as a failure and escalates. This is what turns ~90% into ~99%.

type Logger = (m: string) => Promise<void>;

/** Poll `ok` until it returns true or `ms` elapses. */
export async function settle(page: Page, ok: () => Promise<boolean>, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Resolve + click `intent`:
 *   1. DOM   — run caller's domClick(), verify postcondition
 *   2. VISION — screenshot → coordinates → mouse click, verify postcondition
 *   3. FAIL  — screenshot + log, return false (caller decides retry/escalate)
 */
export async function resolveAndClick(
  page: Page,
  intent: string,
  domClick: () => Promise<boolean>,
  succeeded: () => Promise<boolean>,
  log: Logger,
  visionRetries = 2,
): Promise<boolean> {
  // ── Tier 1: DOM ──────────────────────────────────────────────────────────
  try {
    if (await domClick() && await settle(page, succeeded)) {
      await log(`[resolve] "${intent}": DOM ✓`);
      return true;
    }
  } catch (e) {
    await log(`[resolve] "${intent}": DOM threw: ${(e as Error).message.split("\n")[0]}`);
  }

  // ── Tier 2: VISION ───────────────────────────────────────────────────────
  for (let attempt = 1; attempt <= visionRetries; attempt++) {
    const p = await locateByVision(page, intent, log);
    if (p) {
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(120);
      await page.mouse.click(p.x, p.y);
      if (await settle(page, succeeded)) {
        await log(`[resolve] "${intent}": VISION ✓ (try ${attempt})`);
        return true;
      }
    }
    await page.waitForTimeout(700);
  }

  // ── Tier 3: FAIL ─────────────────────────────────────────────────────────
  const path = `/tmp/resolve-fail-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => {});
  await log(`[resolve] "${intent}": FAILED all tiers — screenshot ${path}`);
  return false;
}
