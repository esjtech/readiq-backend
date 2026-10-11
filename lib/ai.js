const { ApiError } = require("./errors");

const MODEL = process.env.AI_MODEL || "claude-sonnet-4-5";

/** Calls Claude. The API key exists only in Render's environment. */
async function claude({ system, messages, maxTokens = 1000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new ApiError(503, "AI_NOT_CONFIGURED", "AI is not set up on the server yet.");

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(85_000),
    });
  } catch (e) {
    console.error("AI network error:", e.message);
    throw new ApiError(504, "AI_TIMEOUT", "The AI took too long to respond. Please try again.");
  }
  if (!res.ok) {
    console.error("AI provider error", res.status, (await res.text()).slice(0, 400));
    throw new ApiError(502, "AI_PROVIDER_ERROR", "The AI service is busy right now. Please try again in a moment.");
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

/** Pulls a JSON object out of a model reply, tolerating code fences or chatter. */
function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON found");
  return JSON.parse(text.slice(start, end + 1));
}

/** Tutor SVGs render inside the app's WebView, so strip anything active. */
function sanitizeSvgBlocks(text) {
  return text.replace(/\[SVG\]([\s\S]*?)\[\/SVG\]/gi, (_m, svg) => {
    let s = svg.trim()
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
      .replace(/javascript:/gi, "");
    return /^<svg[\s>]/i.test(s) ? `[SVG]${s}[/SVG]` : "";
  });
}

const clip = (s, n) => String(s ?? "").slice(0, n);

module.exports = { claude, parseJsonObject, sanitizeSvgBlocks, clip };
