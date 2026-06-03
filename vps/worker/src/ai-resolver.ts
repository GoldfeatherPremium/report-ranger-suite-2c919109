import { GoogleGenerativeAI } from "@google/generative-ai";

// Only active when GEMINI_API_KEY is set. All errors are swallowed so a bad
// key or quota issue never takes down an otherwise healthy submission run.
const apiKey = process.env.GEMINI_API_KEY;
const genai = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export type AiPageState =
  | "captcha"
  | "login"
  | "dashboard"
  | "error_page"
  | "unknown";

/**
 * Given the raw [diag] lines from dumpPageControls, ask Gemini which CSS
 * selector matches the element needed for `task`.
 *
 * Returns a selector string to try, or null when:
 *  - no API key configured
 *  - AI can't identify the element
 *  - the returned selector is invalid / matches nothing on the page
 */
export async function aiResolveSelector(
  diagLines: string[],
  task: string,
  onProgress: (m: string) => Promise<void>,
): Promise<string | null> {
  if (!genai) return null;

  const pageText = diagLines.join("\n");
  const prompt = `You are helping automate a Turnitin student submission workflow.

Below is a diagnostic dump of every interactive element on the current page.
Each line is one element in the format:
  <tagname [type=...] [name=...] [id=...] [aria=...] [cls=...] [txt=...]>

TASK: ${task}

PAGE ELEMENTS:
${pageText}

Reply with ONLY a valid CSS selector that targets the element for this task.
Rules:
- Return a single CSS selector, nothing else.
- Prefer id, name, aria-label, title, or value attributes over class-based selectors.
- If the element cannot be identified, reply with exactly: null`;

  try {
    await onProgress("[ai] sending page to Gemini for selector resolution");
    const model = genai.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { maxOutputTokens: 128, temperature: 0 },
    });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().replace(/^```[a-z]*\n?|```$/g, "").trim();

    if (!raw || raw === "null") {
      await onProgress("[ai] Gemini could not identify the element");
      return null;
    }

    await onProgress(`[ai] Gemini suggested selector: ${raw}`);
    return raw;
  } catch (err) {
    await onProgress(`[ai] Gemini call failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Classify what kind of page the browser is on.
 * Useful to detect CAPTCHAs, error pages, or unexpected redirects.
 */
export async function aiDetectPageState(
  diagLines: string[],
  pageUrl: string,
  pageTitle: string,
  onProgress: (m: string) => Promise<void>,
): Promise<AiPageState> {
  if (!genai) return "unknown";

  const pageText = diagLines.slice(0, 40).join("\n"); // keep prompt short
  const prompt = `Classify this web page. Reply with exactly one word.

URL: ${pageUrl}
TITLE: ${pageTitle}
ELEMENTS (first 40):
${pageText}

Possible classes:
- captcha    → page shows a CAPTCHA or bot challenge
- login      → page is a login form
- dashboard  → Turnitin assignment or submission dashboard
- error_page → server error, access denied, or "something went wrong"
- unknown    → none of the above

Reply with exactly one of those words, nothing else.`;

  try {
    const model = genai.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: { maxOutputTokens: 16, temperature: 0 },
    });
    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim().toLowerCase() as AiPageState;
    const valid: AiPageState[] = ["captcha", "login", "dashboard", "error_page", "unknown"];
    return valid.includes(raw) ? raw : "unknown";
  } catch {
    return "unknown";
  }
}
