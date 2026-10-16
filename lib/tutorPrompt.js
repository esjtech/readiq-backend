// Builds the AI Tutor's system prompt: a short persona + the ReadIQ app guide (cached) + this chat's extras.
const fs = require("fs");
const path = require("path");

let GUIDE = "";
try {
  GUIDE = fs.readFileSync(path.join(__dirname, "..", "knowledge", "readiq-app-guide.md"), "utf8");
  console.log(`Tutor guide loaded (${GUIDE.length} characters)`);
} catch (e) {
  console.error("Tutor guide missing:", e.message);
}

const PERSONA =
  "You are ReadIQ's friendly AI tutor and in-app guide for students. " +
  "For study questions, explain clearly step by step at the student's level, in short paragraphs. " +
  "For questions about the ReadIQ app, answer from the ReadIQ app guide below and follow its rules exactly.";

/**
 * Returns system blocks. The persona and guide never change between chats, so the guide block is
 * marked cacheable (cheaper and faster after the first message); per-chat details come last.
 */
function buildTutorSystem({ illustration, context }) {
  const svgRule = illustration
    ? "When a diagram would genuinely help, add ONE simple illustration as a self-contained SVG wrapped in [SVG]...[/SVG] after your explanation (use a viewBox, plain shapes and text, no scripts, no external images). Skip it when it wouldn't help."
    : "Do not include SVG.";
  const extra = `${svgRule}${context ? `\n\nThe student is reading this material:\n${context}` : ""}`;

  const blocks = [{ type: "text", text: PERSONA }];
  if (GUIDE) blocks.push({ type: "text", text: GUIDE, cache_control: { type: "ephemeral" } });
  blocks.push({ type: "text", text: extra });
  return blocks;
}

module.exports = { buildTutorSystem };
