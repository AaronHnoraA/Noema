#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Window } from "happy-dom";
import { loadKatexMacros } from "../server/lib/katex-macros.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const items = Array.isArray(input.batch) ? input.batch : [input];
const hasTikz = items.some((item) => /#\+\s*begin\s+tikz(?:\s|$)/im.test(String(item?.markdown ?? "")));
// Initialize MathJax before the HTML shim installs window/document so the
// upstream core chooses its local Node runtime, never its CDN browser loader.
const tikzCore = hasTikz ? await import("@tikz-editor/core/dist/render/index.js") : null;
const tikzTextEngine = hasTikz
  ? await (await import("@tikz-editor/core/dist/text/mathjax-engine.js"))
    .createMathJaxNodeTextEngine().catch(() => null)
  : null;
// A batch may contain the same figure in several notes. Cache the in-flight
// render too, so concurrent notes do not compile it repeatedly.
const tikzCache = new Map();

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
const drawioCacheDir = resolve(
  process.env.NOEMA_DRAWIO_CACHE_DIR
    || join(process.env.AARONNOTE_STATE_DIR
      || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "noema"), "drawio-svg"),
);
const { setKatexMacros } = await import("../src/katex-macros.ts");
setKatexMacros(loadKatexMacros(macrosDir).macros);

const { renderMarkdownHTML, renderPublishedNoteHTML } = await import("../src/render-html.ts");
const { normalizeTikzSource } = await import("../src/tikz-render.ts");
const { sanitizedTikzSvg } = await import("../src/tikz-browser.ts");

function renderOne(input) {
  return input.mode === "published-note"
    ? renderPublishedNoteHTML(String(input.markdown ?? ""), input.note ?? {})
    : renderMarkdownHTML(String(input.markdown ?? ""), {
      leanRegions: input.leanRegions ?? undefined,
      noteFile: input.noteFile ?? undefined,
    });
}

/**
 * Inline every draw.io diagram.
 *
 * The live editor fetches the export through the host, which a standalone or
 * published file cannot reach, so the SVG is put straight into the document —
 * the same treatment TikZ gets below.
 */
async function inlineDrawio(html, noteFile) {
  if (!html.includes("data-aaronnote-drawio-src")) return html;
  const { drawioExportSVG } = await import("../server/lib/drawio-export.mjs");
  const { sanitizeDiagramSvg } = await import("../src/diagram-sanitize.ts");
  const fullDocument = /^\s*<!doctype|^\s*<html\b/i.test(html);
  const root = fullDocument
    ? new window.DOMParser().parseFromString(html, "text/html")
    : window.document.createElement("div");
  if (!fullDocument) root.innerHTML = html;
  const baseDir = noteFile ? dirname(resolve(String(noteFile))) : process.cwd();
  for (const image of root.querySelectorAll("[data-aaronnote-drawio-src]")) {
    const source = image.getAttribute("data-aaronnote-drawio-src") || "";
    const page = Number(image.getAttribute("data-aaronnote-drawio-page") || 0) || 0;
    const file = isAbsolute(source) ? source : resolve(baseDir, source);
    const result = await drawioExportSVG(file, { page, cacheDir: drawioCacheDir });
    const figure = window.document.createElement("span");
    figure.className = image.className;
    // A failed export still says so in the page rather than leaving a dead URL.
    figure.innerHTML = sanitizeDiagramSvg(result.svg);
    image.replaceWith(figure);
  }
  return fullDocument ? `<!DOCTYPE html>\n${root.documentElement.outerHTML}` : root.innerHTML;
}

async function inlineTikz(html) {
  if (!tikzCore || !html.includes("<noema-tikz")) return html;
  const fullDocument = /^\s*<!doctype|^\s*<html\b/i.test(html);
  const root = fullDocument
    ? new window.DOMParser().parseFromString(html, "text/html")
    : window.document.createElement("div");
  if (!fullDocument) root.innerHTML = html;
  for (const element of root.querySelectorAll("noema-tikz[data-source]")) {
    const source = element.getAttribute("data-source") || "";
    try {
      let render = tikzCache.get(source);
      if (!render) {
        render = tikzCore.renderTikzToSvgAsync(normalizeTikzSource(source), {
          textEngine: tikzTextEngine,
        }).then((result) => {
          const error = [...result.parse.diagnostics, ...result.semantic.diagnostics, ...result.svg.diagnostics]
            .find((diagnostic) => diagnostic.severity === "error");
          if (error) throw new Error(error.message);
          return result.svg.svg;
        });
        tikzCache.set(source, render);
      }
      const svg = await render;
      element.innerHTML = sanitizedTikzSvg(svg);
      element.querySelector("svg")?.classList.add("aaronnote-tikz-image");
      element.removeAttribute("data-source");
    } catch (error) {
      // One unsupported diagram must not abort the rest of an export batch.
      element.textContent = error instanceof Error ? error.message : String(error);
      element.classList.add("is-tikz-error");
    }
  }
  return fullDocument ? `<!DOCTYPE html>\n${root.documentElement.outerHTML}` : root.innerHTML;
}

async function inlineDiagrams(item) {
  return inlineTikz(await inlineDrawio(renderOne(item), item?.noteFile));
}

const html = Array.isArray(input.batch)
  ? await Promise.all(input.batch.map((item) => inlineDiagrams(item ?? {})))
  : await inlineDiagrams(input);
process.stdout.write(JSON.stringify({ html }));
