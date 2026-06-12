// Step 2 — login with a real slot account.
// Reads TT_EMAIL / TT_PASSWORD from env so credentials never sit on disk.
import { chromium } from "playwright";

const EMAIL = process.env.TT_EMAIL;
const PASSWORD = process.env.TT_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error("Set TT_EMAIL and TT_PASSWORD env vars before running.");
  process.exit(2);
}

const SEL = {
  email: 'input[name="email"], input#email, input[type="email"], input[name="user_email"], input[autocomplete="username"]',
  password: 'input[name="password"], input[name="user_password"], input#password, input#user_password, input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], button:has-text("Log in"), input[value="Log in"], input[value="Login"], #login',
};

const b = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await b.newContext({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1366, height: 900 },
  locale: "en-US",
});
const p = await ctx.newPage();

const log = (o) => console.log(JSON.stringify(o, null, 2));

await p.goto("https://www.turnitin.com/login_page.asp?lang=en_us", { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await p.screenshot({ path: "/tmp/step2-before.png", fullPage: true });

await p.locator(SEL.email).first().fill(EMAIL, { timeout: 15000 });
await p.locator(SEL.password).first().fill(PASSWORD, { timeout: 15000 });
await p.screenshot({ path: "/tmp/step2-filled.png", fullPage: true });

await Promise.all([
  p.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
  p.locator(SEL.submit).first().click({ timeout: 15000 }),
]);
await p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
await p.screenshot({ path: "/tmp/step2-after.png", fullPage: true });

// Detect outcome
const url = p.url();
const title = await p.title();
const bodyText = (await p.locator("body").innerText().catch(() => "")).slice(0, 600);
const stillHasPassword = await p.locator('input[type="password"]').count();
const hasLogout = await p.getByText(/log\s*out|sign\s*out/i).count();
const hasError = /invalid|incorrect|wrong|error|locked|disabled|denied/i.test(bodyText);

log({
  step: 2,
  url,
  title,
  stillHasPassword,
  hasLogout,
  hasError,
  bodySnippet: bodyText.replace(/\s+/g, " ").trim(),
});

await b.close();
