// Step 9 — poll the assignment dashboard for the similarity % after submission.
// Logs in, navigates to TT_SUBMIT_URL, then every 60s reloads and reads the
// Similarity column. If a percentage (0-100%) appears, click it. Repeats up to
// 20 minutes.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import ws from "ws";

dotenv.config();

const EMAIL = process.env.TT_EMAIL;
const PASSWORD = process.env.TT_PASSWORD;
const SUBMIT_URL = process.env.TT_SUBMIT_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!EMAIL || !PASSWORD || !SUBMIT_URL) { console.error("Set TT_EMAIL, TT_PASSWORD, TT_SUBMIT_URL"); process.exit(2); }
if (!SUPABASE_URL || !SR_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

const sb = createClient(SUPABASE_URL, SR_KEY, { auth: { persistSession: false }, realtime: { transport: ws } });
const SESSION = `teach/${new Date().toISOString().replace(/[:.]/g, "-")}`;
let n = 0;
async function shot(page, label) {
  n += 1;
  const name = `${String(n).padStart(2, "0")}-${label}.png`;
  const local = `/tmp/${name}`;
  await page.screenshot({ path: local, fullPage: true });
  const buf = await fs.readFile(local);
  const key = `${SESSION}/${name}`;
  const up = await sb.storage.from("training").upload(key, buf, { contentType: "image/png", upsert: true });
  if (up.error) { console.error("upload failed", up.error.message); return; }
  const signed = await sb.storage.from("training").createSignedUrl(key, 60 * 60 * 24 * 7);
  console.log(`[shot] ${label} → ${signed.data?.signedUrl ?? "(no url)"}`);
}

const SEL = {
  email: 'input[name="email"], input#email, input[type="email"]',
  password: 'input[name="password"], input#password, input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], #login',
};

const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await b.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "en-US",
  acceptDownloads: true,
});
const p = await ctx.newPage();

// Login
await p.goto("https://www.turnitin.com/login_page.asp?lang=en_us", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await p.locator(SEL.email).first().fill(EMAIL, { timeout: 15000 });
await p.locator(SEL.password).first().fill(PASSWORD, { timeout: 15000 });
await p.locator(SEL.submit).first().click({ timeout: 15000 });
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

console.log("[info] step9 version v3-diag");
console.log(`[info] goto ${SUBMIT_URL}`);
await p.goto(SUBMIT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "dashboard-initial");

// Scan all frames (main + iframes) for a similarity %. Match on element
// textContent (so "24" + "%" split across nodes still matches) and recurse
// into shadow roots.
async function scanForSimilarity() {
  const contexts = [p, ...p.frames()];
  for (const c of contexts) {
    try {
      const res = await c.evaluate(() => {
        const pctRe = /^\s*(\d{1,3})\s*%\s*$/;
        const hits = [];
        const visit = (root) => {
          const els = root.querySelectorAll("*");
          for (const el of els) {
            if (el.shadowRoot) visit(el.shadowRoot);
            const t = (el.textContent || "").trim();
            const m = t.match(pctRe);
            if (!m) continue;
            const n = parseInt(m[1], 10);
            if (n < 0 || n > 100) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            // keep only the innermost matching element
            let inner = false;
            for (const ch of el.querySelectorAll("*")) {
              if (pctRe.test((ch.textContent || "").trim())) { inner = true; break; }
            }
            if (inner) continue;
            hits.push({ pct: n, tag: el.tagName, text: t.slice(0, 40), cls: el.className?.toString?.().slice(0, 60) || "" });
          }
        };
        visit(document);
        return { url: location.href, hits };
      });
      if (res.hits && res.hits.length) return { ctx: c, ...res };
    } catch {}
  }
  // Diagnostic: dump every short text containing "%" so we can see what's on the page.
  for (const c of contexts) {
    try {
      const diag = await c.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("*")) {
          if (el.children.length) continue;
          const t = (el.textContent || "").trim();
          if (t.includes("%") && t.length <= 30) out.push({ tag: el.tagName, text: t });
        }
        return { url: location.href, pctTexts: out.slice(0, 20), frames: document.querySelectorAll("iframe").length };
      });
      console.log("[diag-scan]", JSON.stringify(diag));
    } catch {}
  }
  return null;
}

async function clickSimilarity(c) {
  return await c.evaluate(() => {
    const pctRe = /^\s*(\d{1,3})\s*%\s*$/;
    let match = null;
    const visit = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (match) return;
        if (el.shadowRoot) visit(el.shadowRoot);
        const t = (el.textContent || "").trim();
        if (!pctRe.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        let inner = false;
        for (const ch of el.querySelectorAll("*")) {
          if (pctRe.test((ch.textContent || "").trim())) { inner = true; break; }
        }
        if (inner) continue;
        match = el;
      }
    };
    visit(document);
    if (!match) return { ok: false };
    const text = (match.textContent || "").trim();
    // Walk up to find a clickable ancestor (A/BUTTON/onclick), max 5 hops.
    let target = match;
    for (let i = 0; i < 5; i++) {
      if (target.tagName === "A" || target.tagName === "BUTTON" || target.onclick) break;
      if (target.parentElement) target = target.parentElement; else break;
    }
    target.scrollIntoView();
    target.click();
    return { ok: true, text, tag: target.tagName };
  });
}

const startedAt = Date.now();
const MAX_MS = 20 * 60_000;
let attempt = 0;
let found = null;

// Immediate scan — the % may already be visible on first load.
found = await scanForSimilarity();
if (found) console.log("[poll 0] similarity found immediately:", JSON.stringify(found.hits));

while (!found && Date.now() - startedAt < MAX_MS) {
  attempt += 1;
  console.log(`[poll ${attempt}] sleeping 60s…`);
  await new Promise((r) => setTimeout(r, 60_000));
  console.log(`[poll ${attempt}] reloading`);
  await p.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch((e) => console.log("[warn] reload:", e.message));
  await p.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  await shot(p, `poll-${String(attempt).padStart(2, "0")}`);
  const scan = await scanForSimilarity();
  if (scan && scan.hits.length) {
    console.log(`[poll ${attempt}] similarity found:`, JSON.stringify(scan.hits));
    found = scan;
    break;
  } else {
    console.log(`[poll ${attempt}] no similarity % yet`);
  }
}

if (!found) {
  console.log("[done] similarity did not arrive within 20 min");
  await shot(p, "timeout");
  await b.close();
  process.exit(0);
}

const click = await clickSimilarity(found.ctx);
console.log("[diag] click similarity:", JSON.stringify(click));
// Report may open in new tab
await new Promise((r) => setTimeout(r, 6000));
const pages = ctx.pages().filter((pg) => !pg.isClosed());
const report = pages[pages.length - 1];
await report.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
await report.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));
await shot(report, "similarity-report");

console.log(JSON.stringify({ step: 9, session: SESSION, hits: found.hits, click }, null, 2));
await b.close();
