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
