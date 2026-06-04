import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Page } from "playwright";

// Tier-2 element resolver: locate a target on screen by VISION when DOM
// automation fails. Reuses the existing Gemini key pool (GEMINI_API_KEYS or
// GEMINI_API_KEY) with round-robin rotation. All errors are swallowed — a
// missing/broken key must never crash a job; it just means "no vision result".

type Logger = (m: string) => Promise<void>;
export type VisionPoint = { x: number; y: number; confidence: number };

const keys = (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean)
  .map((k) => new GoogleGenerativeAI(k));

let keyIndex = 0;
function nextClient(): GoogleGenerativeAI | null {
  if (!keys.length) return null;
  return keys[keyIndex++ % keys.length];
}

export function visionAvailable(): boolean {
  return keys.length > 0;
}

/**
 * Find `intent` on the current screen and return a click point in VIEWPORT
 * pixels (1:1 with page.mouse — we screenshot the viewport at full resolution
 * so no scaling is required). Returns null if no key, low confidence, or error.
 */
export async function locateByVision(page: Page, intent: string, log: Logger): Promise<VisionPoint | null> {
  const genai = nextClient();
  if (!genai) return null;

  const vp = page.viewportSize() ?? { width: 1366, height: 900 };
  const shot = await page.screenshot({ fullPage: false }).catch(() => null);
  if (!shot) return null;

  const model = genai.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 200 },
  });

  const prompt = `This screenshot is ${vp.width}x${vp.height} pixels (origin top-left).
Locate: "${intent}".
Respond with ONLY JSON: {"found": boolean, "x": number, "y": number, "confidence": number}
where (x, y) is the CENTER of the target element in PIXELS of THIS image and
confidence is 0..1. If the element is not visible, respond {"found": false}.`;

  async function ask(client: GoogleGenerativeAI): Promise<VisionPoint | null> {
    const m = client.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 200 },
    });
    const res = await m.generateContent([
      { inlineData: { mimeType: "image/png", data: shot!.toString("base64") } },
      { text: prompt },
    ]);
    const j = JSON.parse(res.response.text()) as { found?: boolean; x?: number; y?: number; confidence?: number };
    if (!j.found || typeof j.x !== "number" || typeof j.y !== "number") return null;
    const confidence = typeof j.confidence === "number" ? j.confidence : 0.5;
    if (confidence < 0.4) return null;
    // Clamp into the viewport so a hallucinated coordinate can't click off-screen.
    const x = Math.max(0, Math.min(vp.width - 1, Math.round(j.x)));
    const y = Math.max(0, Math.min(vp.height - 1, Math.round(j.y)));
    return { x, y, confidence };
  }

  try {
    await log(`[vision] locating: ${intent}`);
    const hit = await ask(genai);
    if (!hit) { await log("[vision] not found / low confidence"); return null; }
    await log(`[vision] hit (${hit.x},${hit.y}) conf=${hit.confidence}`);
    return hit;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // On rate-limit, try one other key before giving up.
    if (msg.includes("429") || msg.toLowerCase().includes("quota")) {
      const fallback = nextClient();
      if (fallback) {
        try {
          const hit = await ask(fallback);
          if (hit) { await log(`[vision] hit via fallback key (${hit.x},${hit.y})`); return hit; }
        } catch { /* swallow */ }
      }
    }
    await log(`[vision] error: ${msg.split("\n")[0]}`);
    return null;
  }
}
