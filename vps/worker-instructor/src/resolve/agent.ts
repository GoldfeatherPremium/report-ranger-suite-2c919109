import type { Page } from "playwright";
import { nextGeminiClient, extractJson } from "./gemini.js";

// Tier-3 "computer use" loop on Gemini (free). When DOM (Tier 1) and a single
// vision click (Tier 2) both fail, this drives the page step by step: screenshot
// → ask Gemini for ONE next action → execute it → check the postcondition →
// repeat. Constrained action vocabulary, coordinates map 1:1 to the viewport
// (full-res screenshot), bounded steps. Returns true the moment `succeeded()`
// holds. All errors are swallowed; no keys → returns false.

type Logger = (m: string) => Promise<void>;

type AgentAction = {
  thought?: string;
  action: "click" | "type" | "press" | "scroll" | "wait" | "done" | "fail";
  x?: number; y?: number; text?: string; key?: string;
  direction?: "up" | "down"; amount?: number;
};

export async function visionAgent(
  page: Page,
  goal: string,
  succeeded: () => Promise<boolean>,
  log: Logger,
  maxSteps = 6,
): Promise<boolean> {
  if (await succeeded().catch(() => false)) return true;

  const vp = page.viewportSize() ?? { width: 1366, height: 900 };
  const history: string[] = [];

  for (let step = 1; step <= maxSteps; step++) {
    const client = nextGeminiClient();
    if (!client) return false;

    const shot = await page.screenshot({ fullPage: false }).catch(() => null);
    if (!shot) return false;

    const model = client.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 300 },
    });

    const prompt = `You operate a web browser by looking at a screenshot and choosing ONE next action toward a GOAL.
Image is ${vp.width}x${vp.height} px, origin top-left.
GOAL: ${goal}
ACTIONS SO FAR: ${history.length ? history.join("; ") : "none"}
Reply with ONLY JSON:
{"thought": string, "action": "click"|"type"|"press"|"scroll"|"wait"|"done"|"fail",
 "x": number, "y": number, "text": string, "key": string, "direction": "up"|"down", "amount": number}
- click: x,y = CENTER pixel (in THIS image) of the element to click.
- type: text to type into the focused field.
- press: key = a key name like "Enter" or "Escape".
- scroll: direction up/down, amount in pixels (default 500).
- done: goal looks achieved. fail: stuck/impossible.
Avoid repeating an action that already appears in ACTIONS SO FAR if it had no effect.`;

    let act: AgentAction;
    try {
      const res = await model.generateContent([
        { inlineData: { mimeType: "image/png", data: shot.toString("base64") } },
        { text: prompt },
      ]);
      const parsed = extractJson<AgentAction>(res.response.text());
      if (!parsed || !parsed.action) { await log(`[agent] step ${step}: unparseable response`); await page.waitForTimeout(600); continue; }
      act = parsed;
    } catch (e) {
      await log(`[agent] step ${step} error: ${(e as Error).message.split("\n")[0]}`);
      await page.waitForTimeout(600);
      continue;
    }

    await log(`[agent] step ${step}: ${act.action}${act.thought ? " — " + String(act.thought).slice(0, 90) : ""}`);

    if (act.action === "fail") return false;
    if (act.action === "done") {
      if (await succeeded().catch(() => false)) { await log(`[agent] goal satisfied (done) at step ${step}`); return true; }
      history.push("done(not satisfied)");
      continue;
    }

    if (act.action === "click" && typeof act.x === "number" && typeof act.y === "number") {
      const x = Math.max(0, Math.min(vp.width - 1, Math.round(act.x)));
      const y = Math.max(0, Math.min(vp.height - 1, Math.round(act.y)));
      await page.mouse.move(x, y); await page.waitForTimeout(100); await page.mouse.click(x, y);
      history.push(`click(${x},${y})`);
    } else if (act.action === "type" && typeof act.text === "string") {
      await page.keyboard.type(act.text);
      history.push(`type(${act.text.slice(0, 20)})`);
    } else if (act.action === "press" && typeof act.key === "string") {
      await page.keyboard.press(act.key).catch(() => {});
      history.push(`press(${act.key})`);
    } else if (act.action === "scroll") {
      const amount = typeof act.amount === "number" ? act.amount : 500;
      await page.mouse.wheel(0, act.direction === "up" ? -amount : amount);
      history.push(`scroll(${act.direction ?? "down"})`);
    } else if (act.action === "wait") {
      history.push("wait");
    } else {
      history.push(`unknown(${act.action})`);
    }

    await page.waitForTimeout(900);
    if (await succeeded().catch(() => false)) { await log(`[agent] goal satisfied after step ${step}`); return true; }
  }

  await log(`[agent] exhausted ${maxSteps} steps without success`);
  return false;
}
