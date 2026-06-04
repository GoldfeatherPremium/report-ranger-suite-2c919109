import { GoogleGenerativeAI } from "@google/generative-ai";

// Shared Gemini client pool for all resolver tiers (vision + agent). Built from
// GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY. Round-robin so concurrent
// lanes spread load across keys; callers rotate again on 429. No keys → null,
// and every tier degrades gracefully (DOM-only) rather than crashing.
const keys = (process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean)
  .map((k) => new GoogleGenerativeAI(k));

let keyIndex = 0;

export function nextGeminiClient(): GoogleGenerativeAI | null {
  if (!keys.length) return null;
  return keys[keyIndex++ % keys.length];
}

export function geminiAvailable(): boolean {
  return keys.length > 0;
}

// Robustly extract a JSON object from a model response. Gemini sometimes wraps
// JSON in ```fences``` or prefaces it with prose ("Here is the JSON: {…}")
// despite responseMimeType, which breaks a naive JSON.parse. We strip fences,
// then fall back to the first balanced {…} slice.
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) as T; } catch { /* fall through */ }
  }
  return null;
}
