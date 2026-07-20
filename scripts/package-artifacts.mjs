import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const builtPath = resolve(projectRoot, "dist/index.html");
const built = readFileSync(builtPath, "utf8");
const scriptMatch = built.match(/<script[^>]*>([\s\S]*?)<\/script>/u);
const styleMatch = built.match(/<style[^>]*>([\s\S]*?)<\/style>/u);
const bodyMatch = built.match(/<body>([\s\S]*?)<\/body>/u);
if (!scriptMatch?.[1] || !styleMatch?.[1] || !bodyMatch?.[1]) {
  throw new Error("Der Single-File-Build konnte nicht in ein Fragment umgewandelt werden.");
}
if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/u.test(scriptMatch[1])) {
  throw new Error("Das Fragment enthält einen nicht erlaubten Netzwerkaufruf.");
}
// Syntax-only pass. The bundle contains no imports or top-level await.
new Function(scriptMatch[1]);

const scopedStyle = styleMatch[1]
  .replace(/^:root\{/u, "#whatsapp-replay-root{")
  .replace(/body\{/gu, "#whatsapp-replay-root{");
const fragment = `<div id="whatsapp-replay-root">\n${bodyMatch[1].trim()}\n</div>\n<style>\n${scopedStyle}\n</style>\n<script type="module">\nconst whatsappReplayRoot = document.getElementById("whatsapp-replay-root");\nif (!whatsappReplayRoot) throw new Error("WhatsApp Replay Studio konnte nicht geladen werden.");\n${scriptMatch[1]}\n</script>\n`;
if (/\\["n]/u.test(fragment.slice(0, 300))) {
  throw new Error("Das Fragment beginnt mit escaped statt literal markup.");
}

writeFileSync("/workspace/whatsapp-replay-studio.html", fragment);
copyFileSync(builtPath, "/workspace/WhatsApp-Replay-Studio.html");
