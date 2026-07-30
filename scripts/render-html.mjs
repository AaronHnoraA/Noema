#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { loadKatexMacros } from "../server/lib/katex-macros.mjs";

// Stub CSS imports (e.g. "katex/dist/katex.min.css?url") so Node.js ESM doesn't
// try to load them as modules. Vite handles ?url imports at build time; Node doesn't.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/\.css(\?.*)?$/.test(specifier)) {
      return { shortCircuit: true, url: "data:text/javascript,export default '';" };
    }
    return nextResolve(specifier, context);
  },
});

const window = new Window({ url: "http://localhost/" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(window.document, "compatMode", {
  value: "CSS1Compat",
  configurable: true,
});

for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLImageElement: window.HTMLImageElement,
  Image: window.Image,
  Element: window.Element,
  Node: window.Node,
  Text: window.Text,
  DOMParser: window.DOMParser,
  XMLSerializer: window.XMLSerializer,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  performance: window.performance,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true });
}

// Install the global KaTeX macros before rendering so exported/published HTML
// matches the live editor. The publish engine may not forward the env var, so
// fall back to the repo's etc/katex-macros relative to this script.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const macrosDir = resolve(
  process.env.AARONNOTE_KATEX_MACROS_DIR
    || (process.env.AARONNOTE_WORKSPACE_ROOT
      ? join(process.env.AARONNOTE_WORKSPACE_ROOT, "etc", "katex-macros")
      : join(scriptDir, "..", "..", "..", "..", "etc", "katex-macros")),
);
const { setKatexMacros } = await import("../src/katex-macros.ts");
setKatexMacros(loadKatexMacros(macrosDir).macros);

const { renderMarkdownHTML, renderPublishedNoteHTML } = await import("../src/render-html.ts");

function renderOne(input) {
  return input.mode === "published-note"
    ? renderPublishedNoteHTML(String(input.markdown ?? ""), input.note ?? {})
    : renderMarkdownHTML(String(input.markdown ?? ""), { leanRegions: input.leanRegions ?? undefined });
}

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const html = Array.isArray(input.batch)
  ? input.batch.map((item) => renderOne(item ?? {}))
  : renderOne(input);
process.stdout.write(JSON.stringify({ html }));
