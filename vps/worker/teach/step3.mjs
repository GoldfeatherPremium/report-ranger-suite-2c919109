// Step 3 — log in, then navigate directly to the slot's configured
// submit_url (set by admin) and dump every clickable element on that page.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import ws from "ws";

dotenv.config();

const EMAIL = process.env.TT_EMAIL;
const PASSWORD = process.env.TT_PASSWORD;
const SUBMIT_URL = process.env.TT_SUBMIT_URL || "https://www.turnitin.com/submit_page.asp?lang=en_us";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!EMAIL || !PASSWORD) { console.error("Set TT_EMAIL and TT_PASSWORD"); process.exit(2); }
if (!SUPABASE_URL || !SR_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

const sb = createClient(SUPABASE_URL, SR_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});
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
  email: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  password: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',
};

const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await b.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "en-US",
});
const p = await ctx.newPage();
p.on("framenavigated", async (f) => { if (f === p.mainFrame()) { try { await shot(p, "nav"); } catch {} } });

// ── Login ────────────────────────────────────────────────────────────────────
await p.goto("https://www.turnitin.com/login_page.asp?lang=en_us", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await p.locator(SEL.email).first().fill(EMAIL, { timeout: 15000 });
await p.locator(SEL.password).first().fill(PASSWORD, { timeout: 15000 });
await shot(p, "login-filled");
await p.locator(SEL.submit).first().click({ timeout: 15000 });
await p.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "home");

// ── Click the class link ─────────────────────────────────────────────────────
const classLink = p.locator(`a:has-text("${CLASS_NAME}")`).first();
const classCount = await classLink.count();
console.log(`[info] class link "${CLASS_NAME}" found: ${classCount}`);
if (classCount === 0) {
  // Fallback: list every link on the homepage so we can pick by hand.
  const links = await p.$$eval("a", (as) =>
    as.slice(0, 50).map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
      .filter((x) => x.text && x.href));
  console.log("[debug] homepage links:", JSON.stringify(links, null, 2));
  await b.close();
  process.exit(3);
}
await classLink.click({ timeout: 15000 });
await p.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "class-page");

// ── Dump clickable elements on the class page ────────────────────────────────
const elements = await p.evaluate(() => {
  const out = [];
  const nodes = document.querySelectorAll("a, button, input[type=submit], input[type=button]");
  nodes.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    out.push({
      i,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || "").trim().slice(0, 100),
      href: el.href || null,
      id: el.id || null,
      cls: (el.className || "").toString().slice(0, 80),
    });
  });
  return out.slice(0, 60);
});

console.log(JSON.stringify({
  step: 3,
  session: SESSION,
  url: p.url(),
  title: await p.title(),
  classCount,
  elements,
}, null, 2));

await b.close();
