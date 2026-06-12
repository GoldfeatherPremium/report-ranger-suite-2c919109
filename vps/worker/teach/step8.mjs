// Step 8 — extends step 7. After clicking "Upload and Review", the dialog
// shows either:
//   (A) Review page with "Submit to Turnitin" blue button, OR
//   (B) "You must click confirm to complete your upload." with "Confirm" blue button.
// Click whichever appears, then screenshot the Complete state.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import ws from "ws";

dotenv.config();

const EMAIL = process.env.TT_EMAIL;
const PASSWORD = process.env.TT_PASSWORD;
const SUBMIT_URL = process.env.TT_SUBMIT_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let SAMPLE = process.env.TT_SAMPLE_FILE;

if (!EMAIL || !PASSWORD || !SUBMIT_URL) { console.error("Set TT_EMAIL, TT_PASSWORD, TT_SUBMIT_URL"); process.exit(2); }
if (!SUPABASE_URL || !SR_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(2); }

if (!SAMPLE) {
  SAMPLE = "/tmp/sample.pdf";
  const pdf = Buffer.from(
    "%PDF-1.1\n%\xE2\xE3\xCF\xD3\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 70>>stream\nBT /F1 24 Tf 72 720 Td (Sample document for Turnitin test.) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
    "xref\n0 6\n0000000000 65535 f \n0000000018 00000 n \n0000000061 00000 n \n0000000108 00000 n \n0000000206 00000 n \n0000000326 00000 n \n" +
    "trailer<</Size 6/Root 1 0 R>>\nstartxref\n388\n%%EOF\n",
    "binary"
  );
  await fs.writeFile(SAMPLE, pdf);
}
console.log(`[info] sample file: ${SAMPLE}`);

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

// Detect fresh vs used
const detect = await p.evaluate(() => {
  const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
  const uploadBtn = els.find((el) => {
    if (el.offsetParent === null) return false;
    const t = (el.innerText || el.value || "").trim().toLowerCase();
    return t === "upload submission" || t.startsWith("upload submission");
  });
  const resubmitBtn = document.querySelector("button.paper-upload-modal, a.paper-upload-modal");
  return { hasUploadSubmission: !!uploadBtn, hasResubmit: !!resubmitBtn };
});
console.log("[diag] detect:", JSON.stringify(detect));

let flow;
if (detect.hasUploadSubmission) {
  flow = "fresh";
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
  await p.locator('button.paper-upload-modal, a.paper-upload-modal').first().click({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2000));
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
await new Promise((r) => setTimeout(r, 3000));

// Find file input (main or iframe)
async function findFileInputCtx() {
  const main = p.locator('input[type="file"]').first();
  if (await main.count().catch(() => 0)) return { ctx: p, loc: main, where: "main" };
  for (const f of p.frames()) {
    try {
      const loc = f.locator('input[type="file"]').first();
      if (await loc.count().catch(() => 0)) return { ctx: f, loc, where: `frame:${f.url()}` };
    } catch {}
  }
  return null;
}

let fileInput = null;
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  fileInput = await findFileInputCtx();
  if (fileInput) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!fileInput) { console.error("[err] no file input"); await b.close(); process.exit(1); }
console.log(`[diag] file input: ${fileInput.where}`);
await fileInput.loc.setInputFiles(SAMPLE);
await new Promise((r) => setTimeout(r, 3000));
await shot(p, "file-attached");

// Click "Upload and Review"
const ctx2 = fileInput.ctx;
const r1 = await ctx2.evaluate(() => {
  const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const btn = els.find((el) => {
    if (el.offsetParent === null || el.disabled) return false;
    const t = norm(el.innerText || el.value || el.getAttribute("aria-label") || "");
    return t.includes("upload and review") || t.includes("upload & review");
  });
  if (!btn) return { ok: false };
  btn.scrollIntoView(); btn.click();
  return { ok: true, text: (btn.innerText || btn.value || "").trim() };
});
console.log("[diag] upload-and-review:", JSON.stringify(r1));
await new Promise((r) => setTimeout(r, 8000));
await shot(p, "review-or-confirm");

// Now click the blue confirm button: "Submit to Turnitin" OR "Confirm".
// Poll up to 30s; the dialog may switch from one to the other.
async function clickFinal() {
  return await ctx2.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const els = Array.from(document.querySelectorAll("button, a, input[type=button], input[type=submit]"));
    const visible = els.filter((el) => el.offsetParent !== null && !el.disabled);
    // Priority 1: "Submit to Turnitin"
    let btn = visible.find((el) => {
      const t = norm(el.innerText || el.value || el.getAttribute("aria-label") || "");
      return t === "submit to turnitin" || t.includes("submit to turnitin");
    });
    let kind = "submit";
    // Priority 2: "Confirm" (the hourglass / preview-pending dialog)
    if (!btn) {
      btn = visible.find((el) => {
        const t = norm(el.innerText || el.value || el.getAttribute("aria-label") || "");
        return t === "confirm";
      });
      kind = "confirm";
    }
    if (!btn) {
      return { ok: false, candidates: visible.slice(0, 20).map((e) => norm(e.innerText || e.value || "")).filter(Boolean) };
    }
    btn.scrollIntoView(); btn.click();
    return { ok: true, kind, text: (btn.innerText || btn.value || "").trim() };
  });
}

let final = null;
const dl2 = Date.now() + 30000;
while (Date.now() < dl2) {
  final = await clickFinal();
  if (final.ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log("[diag] final click:", JSON.stringify(final));

await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
await shot(p, "after-final-click");

// If a "Confirm" dialog appears AFTER "Submit to Turnitin" (rare), click it too.
const followup = await clickFinal();
if (followup.ok) {
  console.log("[diag] followup click:", JSON.stringify(followup));
  await new Promise((r) => setTimeout(r, 5000));
  await shot(p, "after-followup");
}

// Dump final state
const post = await ctx2.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a.btn, a[role=button]")).slice(0, 40).map((el) => ({
    text: (el.innerText || el.value || "").trim().slice(0, 80),
    visible: el.offsetParent !== null,
  }));
  return { url: location.href, title: document.title, buttons };
});
console.log(JSON.stringify({ step: 8, flow, session: SESSION, final, post }, null, 2));

await b.close();
