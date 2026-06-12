// Step 4 — log in, go to slot submit_url, click the upload (upward arrow)
// icon on the existing paper row to start a resubmission. Then dump what
// appears next (file input / modal / new page).
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
await p.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

// Navigate to slot
console.log(`[info] goto ${SUBMIT_URL}`);
await p.goto(SUBMIT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "submit-page");

// Inspect all action buttons/icons in the paper row(s)
const rowIcons = await p.evaluate(() => {
  const out = [];
  const candidates = document.querySelectorAll("button, a, [role=button], svg, img, i");
  candidates.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    // narrow to right-side of the table area (icons sit near similarity cell)
    if (rect.top < 350 || rect.top > 520) return;
    out.push({
      i,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 80),
      aria: el.getAttribute("aria-label"),
      title: el.getAttribute("title"),
      cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 100),
      x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height),
    });
  });
  return out;
});
console.log("[diag] row-area elements:", JSON.stringify(rowIcons, null, 2));

// Try clicking the upload (upward arrow) icon. Strategy: aria-label / title
// containing "upload" or "resubmit", else the leftmost of 3 icons on the row.
const clicked = await p.evaluate(() => {
  const tryClick = (el) => {
    const btn = el.closest("button, a, [role=button]") || el;
    btn.click();
    return {
      tag: btn.tagName.toLowerCase(),
      aria: btn.getAttribute("aria-label"),
      title: btn.getAttribute("title"),
      cls: (btn.className?.baseVal ?? btn.className ?? "").toString().slice(0, 120),
    };
  };
  const all = Array.from(document.querySelectorAll("button, a, [role=button]"));
  // 1) aria-label / title mentions upload / resubmit / submit
  const labeled = all.find((el) => {
    const t = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "")).toLowerCase();
    return /upload|resubmit|submit/.test(t);
  });
  if (labeled) return { how: "label", ...tryClick(labeled) };
  return null;
});
console.log("[diag] clicked:", JSON.stringify(clicked));

await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
await shot(p, "after-upload-click");

// Dump file inputs / modal content
const post = await p.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll("input[type=file]")).map((el) => ({
    id: el.id, name: el.name, accept: el.accept, visible: el.offsetParent !== null,
  }));
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit]")).slice(0, 30).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || "").trim().slice(0, 80),
    cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 80),
  }));
  return { url: location.href, title: document.title, inputs, buttons };
});
console.log(JSON.stringify({ step: 4, session: SESSION, post }, null, 2));

await b.close();
