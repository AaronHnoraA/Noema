import { renderTikzToSvgAsync } from "@tikz-editor/core/dist/render/index.js";
import { createMathJaxNodeTextEngine, setWorkerFontLoader } from "@tikz-editor/core/dist/text/mathjax-engine.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";
import { DefaultFont } from "@mathjax/src/js/output/svg/DefaultFont.js";

// MathJax's font subsets must be bundled with Noema. The upstream browser
// entrypoint loads a CDN script; the worker runtime and these imports stay
// offline and keep TeX layout away from the editor's main thread.
const FONT_CHUNKS: Record<string, () => Promise<unknown>> = {
  "PUA": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js"),
  "accents": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js"),
  "accents-b-i": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js"),
  "arabic": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js"),
  "arrows": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js"),
  "braille": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js"),
  "braille-d": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js"),
  "calligraphic": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js"),
  "cherokee": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js"),
  "cyrillic": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js"),
  "cyrillic-ss": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js"),
  "devanagari": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js"),
  "double-struck": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js"),
  "fraktur": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js"),
  "greek": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js"),
  "greek-ss": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js"),
  "hebrew": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js"),
  "latin": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js"),
  "latin-b": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js"),
  "latin-bi": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js"),
  "latin-i": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js"),
  "marrows": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js"),
  "math": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js"),
  "monospace": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js"),
  "monospace-ex": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js"),
  "monospace-l": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js"),
  "mshapes": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js"),
  "phonetics": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js"),
  "phonetics-ss": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js"),
  "sans-serif": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js"),
  "sans-serif-b": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js"),
  "sans-serif-bi": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js"),
  "sans-serif-ex": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js"),
  "sans-serif-i": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js"),
  "sans-serif-r": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js"),
  "script": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js"),
  "shapes": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js"),
  "symbols": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js"),
  "symbols-b-i": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js"),
  "variants": () => import("@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js"),
};

type DynamicFont = { dynamicFiles: Record<string, { setup: (font: unknown) => void }> };

setWorkerFontLoader(async (name) => {
  const key = name.match(/\/svg\/dynamic\/(.+?)\.js$/)?.[1];
  const loader = key ? FONT_CHUNKS[key] : undefined;
  if (!loader || !key) throw new Error(`Unavailable MathJax font: ${name}`);
  const loaded = await loader();
  // Vite resolves MathJax's #default-font alias and the subset module's
  // package import as separate class instances. The subset registers its
  // setup callback on the latter; pass it to the font used by the output Jax.
  if (MathJaxNewcmFont !== DefaultFont) {
    const source = (MathJaxNewcmFont as unknown as DynamicFont).dynamicFiles[key];
    const target = (DefaultFont as unknown as DynamicFont).dynamicFiles[key];
    if (source && target) target.setup = source.setup;
  }
  return loaded;
});

type RenderRequest = { id: number; source: string };
type RenderReply = { id: number; svg?: string; error?: string };

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const { id, source } = event.data;
  let reply: RenderReply;
  try {
    const engine = await createMathJaxNodeTextEngine();
    // MathJax can discover several font subsets in one expression. Prime its
    // control sequences separately so scene layout sees real glyph metrics.
    const commands = new Set<string>();
    for (const match of source.matchAll(/(?<!\\)\$(?:\\.|[^\\$])*\$/g)) {
      for (const command of match[0].matchAll(/\\[A-Za-z]+(?:\s*\{[^{}]*\})?/g)) {
        commands.add(`$${command[0]}$`);
        if (commands.size >= 64) break;
      }
      if (commands.size >= 64) break;
    }
    for (const math of commands) {
      const request = {
        text: math, textWidthPt: null, fontStyle: "normal" as const,
        fontWeight: "normal" as const, fontFamily: "serif" as const, fontSizePt: 10,
      };
      if (engine.validate(math)) continue;
      for (let attempt = 0; attempt < 4 && !engine.measure(request); attempt++) {
        if (!(await engine.flushPending?.())?.length) break;
      }
    }
    const result = await renderTikzToSvgAsync(source, { textEngine: engine });
    const error = [...result.parse.diagnostics, ...result.semantic.diagnostics, ...result.svg.diagnostics]
      .find((diagnostic) => "severity" in diagnostic && diagnostic.severity === "error");
    reply = error
      ? { id, error: error.message }
      : { id, svg: result.svg.svg };
  } catch (error) {
    reply = { id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
