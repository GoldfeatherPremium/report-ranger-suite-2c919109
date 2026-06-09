import "./load-env.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getInstructorAccount, createSession, finishSession, uploadScreenshot,
  recordStep, saveFlow, log, type FlowAction,
} from "./supabase.js";
import {
  launch, login, screenshot, extractElements, metaOf, disposeAll, clickInRow, clickByText, hardClick, setFileInput,
  isLoggedIn, saveSession, homeUrlFor, type DetectedElement,
} from "./browser.js";
import type { Page } from "playwright";

// Where the reusable per-account session (cookies) is stored on disk.
function sessionFile(accountId: string): string {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${accountId}.json`);
}

const WORKER_ID = process.env.WORKER_ID ?? `instructor-teach-${process.pid}`;
const HEADLESS = (process.env.HEADLESS ?? "true") === "true";
const SAMPLE_FILE = process.env.TEACH_SAMPLE_FILE ?? "./sample.docx";
const ACCOUNT_LABEL = process.env.TEACH_ACCOUNT_LABEL;
// Set TEACH_FRESH=1 to ignore any saved session and always log in live.
const FRESH = /^(1|true|yes)$/i.test(process.env.TEACH_FRESH ?? "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELP = `
Commands (act on the numbered elements shown above):
  click <i>              click element #i
  clickclass <i>         click class link #i, recorded as the configured class name
  clickassign <i>        click assignment link #i, recorded as the configured assignment name
  clicktext <text...>    click the element whose visible text matches
  clickany <a> | <b>...  click the first option present (e.g. Resubmit | Submit)
  clickif <text...>      click if present, else skip (optional step, e.g. Confirm)
  attach [path]          attach a document to the file input (default sample; recorded as the job file)
  viewassign <name...>   click "View" in the assignment row named <name>, recorded
                         as the configured assignment (dynamic)
  rowclick <action> | <row...>   click <action> in the row labelled <row>
  menulane <i>           click the 3-dots "Display actions menu" in lane #i (0-based),
                         recorded as the worker's assigned lane (dynamic)
  clicknth <i> <needle...>   click the i-th element whose label contains <needle>
  fill <i> <value...>    type a value into element #i
  upload <i> [path]      attach a file to file-input #i (default: TEACH_SAMPLE_FILE)
  press <Key>            press a keyboard key (e.g. press Enter)
  goto <url>             navigate to a URL
  waittext <text...>     wait until some text appears on the page
  wait <ms>              pause N milliseconds, then re-capture
  scroll <px>            scroll vertically by px (e.g. scroll 600)
  shot                   re-capture the current screen (no action recorded)
  reload                 reload the current page, then re-capture (recovery)
  relogin                re-run the whole login flow, then re-capture (recovery)
  done [name...]         save the recorded sequence as a flow and exit
  abort                  discard and exit
  help                   show this help
`.trim();

async function main() {
  const account = await getInstructorAccount(ACCOUNT_LABEL);
  console.log(`\n=== Turnitin Instructor — TEACH mode ===`);
  console.log(`account : ${account.label} <${account.email}>`);
  console.log(`headless: ${HEADLESS}\n`);

  const sessionPath = sessionFile(account.id);
  const haveSession = existsSync(sessionPath) && !FRESH;
  const { browser, context, page } = await launch(HEADLESS, haveSession ? sessionPath : undefined);
  const sessionId = await createSession(account.id, WORKER_ID, `teach ${account.label}`);
  await log(WORKER_ID, "info", `teaching session ${sessionId} for ${account.label}`);

  // Reuse a saved session only if it's REALLY still logged in; otherwise log in
  // live with the configured credentials and save a fresh session.
  let loggedIn = false;
  if (haveSession) {
    try {
      await page.goto(homeUrlFor(account.login_url), { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      loggedIn = await isLoggedIn(page);
      console.log(loggedIn ? "  · reused saved session — login skipped" : "  · saved session expired — logging in live");
    } catch { /* fall through to a fresh login */ }
  } else if (FRESH) {
    console.log("  · TEACH_FRESH set — ignoring any saved session, logging in live");
  }
  if (!loggedIn) {
    try {
      await login(page, account, (m) => console.log(`  · ${m}`));
      loggedIn = await isLoggedIn(page);
      if (!loggedIn) console.warn("  ⚠️  login submitted but no logged-in marker found — check the screen / credentials (try 'relogin').");
    } catch (e) {
      console.error(`login failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error("Continuing anyway — use 'relogin' or 'goto'.");
    }
  }
  if (loggedIn) {
    try { await saveSession(context, sessionPath); console.log("  · session saved (login will be skipped next time while valid)"); }
    catch (e) { console.log(`  ⚠️  could not save session: ${e instanceof Error ? e.message : e}`); }
  }

  const rl = readline.createInterface({ input, output });
  const recorded: FlowAction[] = [];
  let idx = 0;

  try {
    // Outer loop: capture → show → act → repeat
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      const png = await screenshot(page);
      const { path, signedUrl } = await uploadScreenshot(sessionId, idx, png);
      const els = await extractElements(page);
      const title = await page.title().catch(() => "");

      printScreen(idx, page, title, signedUrl, els);

      const line = (await rl.question("\naction> ")).trim();
      const [cmd, ...rest] = line.split(/\s+/);

      if (cmd === "help" || cmd === "?") { console.log(HELP); await disposeAll(els); continue; }
      if (cmd === "shot" || cmd === "") { await disposeAll(els); continue; }

      // Recovery commands — not recorded into the flow, just re-capture.
      if (cmd === "reload") {
        console.log("  · reloading…");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => console.log(`  ⚠️  reload: ${e instanceof Error ? e.message : e}`));
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await disposeAll(els);
        continue;
      }
      if (cmd === "relogin") {
        try {
          await login(page, account, (m) => console.log(`  · ${m}`));
          await saveSession(context, sessionPath).catch(() => {});
          console.log("  · session saved");
        } catch (e) { console.log(`  ⚠️  relogin failed: ${e instanceof Error ? e.message : String(e)}`); }
        await disposeAll(els);
        continue;
      }

      if (cmd === "abort") {
        await recordStep({ sessionId, idx, pageUrl: page.url(), pageTitle: title, screenshotPath: path, elements: metaOf(els), action: null, status: "captured" });
        await disposeAll(els);
        await finishSession(sessionId, "aborted");
        console.log("aborted — nothing saved as a flow.");
        break;
      }

      if (cmd === "done") {
        await recordStep({ sessionId, idx, pageUrl: page.url(), pageTitle: title, screenshotPath: path, elements: metaOf(els), action: null, status: "captured" });
        await disposeAll(els);
        const name = rest.join(" ") || `${account.label} flow`;
        const flowId = await saveFlow(account.id, name, recorded);
        await finishSession(sessionId, "finished");
        console.log(`\n✅ saved flow "${name}" (${recorded.length} actions) → id ${flowId}`);
        console.log(`   activate it later with: update turnitin_instructor_flows set status='active' where id='${flowId}';`);
        break;
      }

      const { action, error } = await execute(page, els, cmd, rest);
      if (error) {
        console.log(`  ⚠️  ${error}`);
        await disposeAll(els);
        continue; // re-capture same idx; nothing recorded
      }

      await recordStep({
        sessionId, idx, pageUrl: page.url(), pageTitle: title, screenshotPath: path,
        elements: metaOf(els), action, status: "executed",
        result: describe(action),
      });
      if (action) recorded.push(action);
      await disposeAll(els);
      idx++;
      await sleep(1200);
    }
  } finally {
    rl.close();
    await browser.close().catch(() => {});
  }
}

function printScreen(idx: number, page: Page, title: string, signedUrl: string | null, els: DetectedElement[]) {
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`STEP ${idx}`);
  console.log(`url   : ${page.url()}`);
  console.log(`title : ${title}`);
  console.log(`shot  : ${signedUrl ?? "(upload failed)"}`);
  console.log(`elements (${els.length}):`);
  for (const e of els) {
    const label = e.text ? `"${e.text}"` : "(no text)";
    const sel = e.selector ? `  ${e.selector}` : "";
    const fr = e.frame > 0 ? ` frame#${e.frame}` : "";
    console.log(`  [${e.i}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${label}${sel}${fr}`);
  }
  console.log(`(type 'help' for commands)`);
}

// Find the N-th element (0-based, top-to-bottom then left-to-right) whose text
// contains `needle`, using the live Playwright handles — which pierce shadow DOM
// (Turnitin's Feedback Studio renders the submission list inside web components,
// invisible to an in-page querySelectorAll).
async function nthMatching(els: DetectedElement[], needle: string, n: number): Promise<DetectedElement | null> {
  const nd = needle.toLowerCase();
  const cands = els.filter((e) => e.text.toLowerCase().includes(nd));
  if (!cands.length || n < 0) return null;
  const boxed = await Promise.all(cands.map(async (e) => ({ e, box: await e.handle.boundingBox().catch(() => null) })));
  boxed.sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
  return n < boxed.length ? boxed[n].e : null;
}

async function execute(
  page: Page, els: DetectedElement[], cmd: string, rest: string[],
): Promise<{ action: FlowAction | null; error?: string }> {
  const pick = (n: string): DetectedElement | null => {
    const i = Number(n);
    return Number.isInteger(i) && i >= 0 && i < els.length ? els[i] : null;
  };

  try {
    switch (cmd) {
      case "click": {
        const el = pick(rest[0]);
        if (!el) return { action: null, error: `no element #${rest[0]}` };
        await el.handle.click({ timeout: 15_000 });
        return { action: { type: "click", selector: el.selector, frame: el.frame, text: el.text } };
      }
      case "clickclass":
      case "clickassign": {
        const el = pick(rest[0]);
        if (!el) return { action: null, error: `no element #${rest[0]}` };
        await el.handle.click({ timeout: 15_000 });
        // Click concretely while teaching, but record a dynamic placeholder so
        // replay clicks whatever class/assignment the admin configured.
        const value = cmd === "clickclass" ? "<<CLASS_LABEL>>" : "<<ASSIGNMENT_LABEL>>";
        return { action: { type: "clicktext", value, frame: el.frame, text: el.text } };
      }
      case "clicktext": {
        const text = rest.join(" ");
        if (!text) return { action: null, error: "clicktext needs some text" };
        const needle = text.toLowerCase();
        const el = els.find((e) => e.text.toLowerCase() === needle)
          ?? els.find((e) => e.text.toLowerCase().includes(needle));
        if (el) {
          await hardClick(page, el.handle);
          return { action: { type: "clicktext", value: text, selector: el.selector, frame: el.frame, text: el.text } };
        }
        // Fall back to Playwright's text engine for non-standard elements (menu <div>s).
        const r = await clickByText(page, text);
        if (r.status === "ok") return { action: { type: "clicktext", value: text, frame: r.frame, text } };
        return { action: null, error: `no visible element with text "${text}"` };
      }
      case "clickif": {
        // Optional click: click if present, otherwise skip without failing.
        // Used for the Resubmit "Confirm" dialog, which is absent on the Submit path.
        const text = rest.join(" ");
        if (!text) return { action: null, error: "clickif needs some text" };
        const needle = text.toLowerCase();
        const el = els.find((e) => e.text.toLowerCase() === needle)
          ?? els.find((e) => e.text.toLowerCase().includes(needle));
        let clicked = false;
        if (el) { await hardClick(page, el.handle); clicked = true; }
        else { clicked = (await clickByText(page, text)).status === "ok"; }
        console.log(`  · clickif "${text}": ${clicked ? "clicked" : "not present — skipped"}`);
        return { action: { type: "clickif", value: text, text } };
      }
      case "attach": {
        const file = rest[0] || SAMPLE_FILE;
        const r = await setFileInput(page, file);
        if (!r.ok) return { action: null, error: "no <input type=file> found on this screen" };
        // Replay substitutes the real job document for this placeholder.
        return { action: { type: "upload", value: "<<JOB_FILE>>", frame: r.frame, text: `attach ${file}` } };
      }
      case "clickany": {
        // clickany A | B | C  → click the first option present (most specific first)
        const alts = rest.join(" ").split("|").map((s) => s.trim()).filter(Boolean);
        if (!alts.length) return { action: null, error: "usage: clickany <a> | <b> ...  (e.g. clickany Resubmit | Submit)" };
        for (const alt of alts) {
          const needle = alt.toLowerCase();
          const el = els.find((e) => e.text.toLowerCase() === needle)
            ?? els.find((e) => e.text.toLowerCase().includes(needle));
          if (el) {
            await hardClick(page, el.handle);
            return { action: { type: "clickany", value: alts.join(" | "), frame: el.frame, text: el.text } };
          }
          const r = await clickByText(page, alt);
          if (r.status === "ok") return { action: { type: "clickany", value: alts.join(" | "), frame: r.frame, text: alt } };
        }
        return { action: null, error: `none of [${alts.join(", ")}] found on screen` };
      }
      case "viewassign": {
        const name = rest.join(" ");
        if (!name) return { action: null, error: "viewassign needs the assignment name, e.g. viewassign Research" };
        const r = await clickInRow(page, name, "View");
        if (r.status !== "ok") return { action: null, error: `could not click View for "${name}" (${r.status})` };
        // Click concretely now; record dynamically so replay uses the configured assignment.
        return { action: { type: "clickrow", value: "<<ASSIGNMENT_LABEL>>", actionText: "View", frame: r.frame, text: name } };
      }
      case "rowclick": {
        // rowclick <action> | <row text...>
        const raw = rest.join(" ");
        const [actionText, rowText] = raw.split("|").map((s) => s.trim());
        if (!actionText || !rowText) return { action: null, error: 'usage: rowclick <action> | <row text>  (e.g. rowclick View | Research)' };
        const r = await clickInRow(page, rowText, actionText);
        if (r.status !== "ok") return { action: null, error: `could not click "${actionText}" in row "${rowText}" (${r.status})` };
        return { action: { type: "clickrow", value: rowText, actionText, frame: r.frame, text: rowText } };
      }
      case "menulane": {
        const i = Number(rest[0]);
        if (!Number.isInteger(i) || i < 0) return { action: null, error: "usage: menulane <i>  (0 = first lane)" };
        const needle = "Display actions menu";
        const el = await nthMatching(els, needle, i);
        if (!el) {
          const found = els.filter((e) => e.text.toLowerCase().includes(needle.toLowerCase())).length;
          return { action: null, error: `lane #${i} 3-dots not found (matched ${found} "${needle}" buttons)` };
        }
        await el.handle.click({ timeout: 15_000 });
        // Record dynamically: replay clicks the lane assigned to this worker.
        return { action: { type: "clicknth", value: "<<LANE_INDEX>>", actionText: needle, frame: el.frame, text: `lane ${i} actions menu` } };
      }
      case "clicknth": {
        const i = Number(rest[0]);
        const needle = rest.slice(1).join(" ");
        if (!Number.isInteger(i) || i < 0 || !needle) return { action: null, error: "usage: clicknth <i> <needle...>" };
        const el = await nthMatching(els, needle, i);
        if (!el) return { action: null, error: `match #${i} for "${needle}" not found` };
        await el.handle.click({ timeout: 15_000 });
        return { action: { type: "clicknth", value: String(i), actionText: needle, frame: el.frame, text: needle } };
      }
      case "fill": {
        const el = pick(rest[0]);
        if (!el) return { action: null, error: `no element #${rest[0]}` };
        const value = rest.slice(1).join(" ");
        await el.handle.fill(value, { timeout: 15_000 });
        return { action: { type: "fill", selector: el.selector, frame: el.frame, text: el.text, value } };
      }
      case "upload": {
        const el = pick(rest[0]);
        if (!el) return { action: null, error: `no element #${rest[0]}` };
        const file = rest[1] || SAMPLE_FILE;
        await el.handle.setInputFiles(file);
        // Replay substitutes the real job document for this placeholder.
        return { action: { type: "upload", selector: el.selector, frame: el.frame, text: el.text, value: "<<JOB_FILE>>" } };
      }
      case "press": {
        const key = rest[0];
        if (!key) return { action: null, error: "press needs a key, e.g. press Enter" };
        await page.keyboard.press(key);
        return { action: { type: "press", key } };
      }
      case "goto": {
        const url = rest[0];
        if (!url) return { action: null, error: "goto needs a url" };
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return { action: { type: "goto", value: url } };
      }
      case "waittext": {
        const text = rest.join(" ");
        if (!text) return { action: null, error: "waittext needs some text" };
        await page.getByText(text, { exact: false }).first().waitFor({ timeout: 60_000 });
        return { action: { type: "waittext", value: text } };
      }
      case "wait": {
        const ms = Number(rest[0] || "1000");
        await sleep(ms);
        return { action: { type: "wait", value: String(ms) } };
      }
      case "scroll": {
        const px = Number(rest[0] || "600");
        await page.mouse.wheel(0, px);
        return { action: { type: "scroll", value: String(px) } };
      }
      default:
        return { action: null, error: `unknown command "${cmd}" — type 'help'` };
    }
  } catch (e) {
    return { action: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function describe(a: FlowAction | null): string {
  if (!a) return "";
  if (a.type === "click") return `click ${a.text || a.selector || ""}`.trim();
  if (a.type === "fill") return `fill ${a.text || a.selector || ""} = ${a.value}`.trim();
  return `${a.type} ${a.value ?? a.key ?? ""}`.trim();
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
