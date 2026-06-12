// Step 2 — login with a real slot account, screenshot every screen,
// upload each shot to the `training` bucket and print a signed URL.
//
// Env required: TT_EMAIL, TT_PASSWORD (creds), plus SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (already in the worker's .env — loaded via dotenv).
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";

dotenv.config(); // loads ./worker/.env when run from $WD

const EMAIL = process.env.TT_EMAIL;
const PASSWORD = process.env.TT_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!EMAIL || !PASSWORD) { console.error("Set TT_EMAIL and TT_PASSWORD"); process.exit(2); }
if (!SUPABASE_URL || !SR_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env"); process.exit(2); }

const sb = createClient(SUPABASE_URL, SR_KEY, { auth: { persistSession: false } });
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
  const signed = await sb.storage.from("training").createSignedUrl(key, 60 * 60 * 24 * 7); // 7 days
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

// Snap every navigation/load automatically too.
p.on("framenavigated", async (f) => { if (f === p.mainFrame()) { try { await shot(p, "nav"); } catch {} } });

await p.goto("https://www.turnitin.com/login_page.asp?lang=en_us", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await shot(p, "login-loaded");

await p.locator(SEL.email).first().fill(EMAIL, { timeout: 15000 });
await p.locator(SEL.password).first().fill(PASSWORD, { timeout: 15000 });
await shot(p, "login-filled");

await p.locator(SEL.submit).first().click({ timeout: 15000 });
await p.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "after-submit");

const url = p.url();
const title = await p.title();
const bodyText = (await p.locator("body").innerText().catch(() => "")).slice(0, 600);
const stillHasPassword = await p.locator('input[type="password"]').count();
const hasLogout = await p.getByText(/log\s*out|sign\s*out/i).count();
const hasError = /invalid|incorrect|wrong|error|locked|disabled|denied/i.test(bodyText);

console.log(JSON.stringify({
  step: 2, session: SESSION, url, title, stillHasPassword, hasLogout, hasError,
  bodySnippet: bodyText.replace(/\s+/g, " ").trim(),
}, null, 2));

await b.close();
