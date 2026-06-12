// Step 6 — login → slot dashboard → branch:
//   (A) Fresh unused slot: click blue "Upload Submission" button.
//   (B) Used slot (resubmit): click upward-arrow upload icon, then "Confirm".
// Then dump the next page (file upload form).
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

// Slot dashboard
console.log(`[info] goto ${SUBMIT_URL}`);
await p.goto(SUBMIT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await shot(p, "dashboard");

// Detect: is there a visible "Upload Submission" blue button? (fresh slot)
const detect = await p.evaluate(() => {
  const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
  const uploadBtn = els.find((el) => {
    if (el.offsetParent === null) return false;
    const t = (el.innerText || el.value || "").trim().toLowerCase();
    return t === "upload submission" || t.startsWith("upload submission");
  });
  const resubmitBtn = document.querySelector("button.paper-upload-modal, a.paper-upload-modal");
  return {
    hasUploadSubmission: !!uploadBtn,
    hasResubmit: !!resubmitBtn,
    uploadText: uploadBtn ? (uploadBtn.innerText || uploadBtn.value || "").trim() : null,
  };
});
console.log("[diag] detect:", JSON.stringify(detect));

let flow;
if (detect.hasUploadSubmission) {
  flow = "fresh";
  console.log("[info] FRESH slot → clicking 'Upload Submission'");
  await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
    const btn = els.find((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || el.value || "").trim().toLowerCase();
      return t === "upload submission" || t.startsWith("upload submission");
    });
    btn?.click();
  });
} else {
  flow = "resubmit";
  console.log("[info] USED slot → clicking resubmit (upward arrow) + Confirm");
  await p.locator('button.paper-upload-modal, a.paper-upload-modal').first().click({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2000));
  await shot(p, "confirm-modal");
  await p.evaluate(() => {
    const all = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
    const target = all.find((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || el.value || "").trim().toLowerCase();
      return t === "confirm";
    });
    target?.click();
  });
}

await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
await shot(p, `after-${flow}`);

// Dump what came next: file inputs, selects, buttons, url
const post = await p.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll("input, select, textarea")).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.type, id: el.id, name: el.name,
    accept: el.accept, visible: el.offsetParent !== null,
    placeholder: el.placeholder,
  }));
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a.btn, a[role=button]")).slice(0, 40).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || "").trim().slice(0, 80),
    cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 100),
    visible: el.offsetParent !== null,
  }));
  return { url: location.href, title: document.title, inputs, buttons };
});
console.log(JSON.stringify({ step: 6, flow, session: SESSION, detect, post }, null, 2));

await b.close();
