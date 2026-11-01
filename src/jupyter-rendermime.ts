// Shared JupyterLab render stack for Noema cell outputs.
//
// This is the same rendering pipeline the official VS Code Jupyter extension
// uses: `@jupyterlab/rendermime` + `@jupyterlab/outputarea`. Cell outputs and
// ipywidget-internal Output areas render through one registry so their layout,
// MIME preference, and error/stream formatting match upstream Jupyter exactly.
//
// Noema-specific adaptations layered on top of the stock factories:
//   * a KaTeX LaTeX typesetter (Noema never loads MathJax);
//   * an HTML renderer that routes script-bearing HTML (e.g. Sage's threejs
//     viewer) into a sandboxed auto-sizing iframe, and Sage/SymPy math-only
//     HTML into KaTeX, while plain HTML uses the stock renderer;
//   * a widget-view renderer that mounts against the live kernel widget
//     manager (lazily imported so the heavy manager stays out of the main
//     bundle).

import { FRAME_KEY_RELAY_SCRIPT } from "./frame-key-relay.ts";
import { OutputArea, OutputAreaModel } from "@jupyterlab/outputarea";
import { RenderedMarkdown, RenderMimeRegistry, standardRendererFactories } from "@jupyterlab/rendermime";
import type { IRenderMime } from "@jupyterlab/rendermime";
import { Widget } from "@lumino/widgets";
import { KatexTypesetter, renderKatexInto } from "./jupyter-output-math.ts";

export { renderKatexInto } from "./jupyter-output-math.ts";

import "@jupyterlab/rendermime/style/base.css";
import "@jupyterlab/outputarea/style/base.css";

const WIDGET_VIEW_MIMETYPE = "application/vnd.jupyter.widget-view+json";


export type JupyterWidgetRuntimeRef = {
  id: string;
  name: string;
  generation?: number;
};

export type JupyterMarkdownParser = IRenderMime.IMarkdownParser;

export type WidgetOutputsMap = Record<string, unknown[]>;

export type WidgetMountFn = (
  host: HTMLElement,
  modelId: string,
  runtime: JupyterWidgetRuntimeRef,
  messages: unknown[],
  widgetOutputs?: WidgetOutputsMap,
) => Promise<() => void>;

export type JupyterOutputView = (() => void) & {
  clear(): void;
  setOutput(index: number, output: unknown): void;
};

export type RenderMimeOptions = {
  widgetRuntime?: JupyterWidgetRuntimeRef;
  widgetMessages?: unknown[];
  widgetOutputs?: WidgetOutputsMap;
  mountWidget?: WidgetMountFn;
  markdownParser?: IRenderMime.IMarkdownParser;
  jsonMimeTypes?: string[];
};

function mimeToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item ?? "")).join("");
  return "";
}

// ---------------------------------------------------------------------------
// Sandboxed auto-height iframe for script-bearing HTML output
// ---------------------------------------------------------------------------

const HTML_FRAME_STYLE = `<style>
:root { color-scheme: light dark; }
html, body { margin: 0; }
body { padding: 8px; box-sizing: border-box; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>`;

const HTML_FRAME_AUTOSIZE = `<script>(function(){function p(){try{var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({__noemaCeilFrame:true,height:h},"*");}catch(e){}}window.addEventListener("load",p);try{new ResizeObserver(p).observe(document.documentElement);}catch(e){}setTimeout(p,50);setTimeout(p,400);})();</script>`;

const autoHeightFrames = new Set<HTMLIFrameElement>();
let frameListenerInstalled = false;

function ensureFrameListener(): void {
  if (frameListenerInstalled) return;
  frameListenerInstalled = true;
  window.addEventListener("message", (event) => {
    const data = event.data as { __noemaCeilFrame?: boolean; height?: number } | null;
    if (!data || data.__noemaCeilFrame !== true || typeof data.height !== "number") return;
    for (const frame of Array.from(autoHeightFrames)) {
      if (!frame.isConnected) { autoHeightFrames.delete(frame); continue; }
      if (frame.contentWindow && frame.contentWindow === event.source) {
        frame.style.height = `${Math.min(Math.max(Math.ceil(data.height) + 6, 24), 4000)}px`;
      }
    }
  });
}

function makeScriptHtmlFrame(html: string): HTMLIFrameElement {
  ensureFrameListener();
  const frame = document.createElement("iframe");
  frame.className = "cm-ceil-output-html";
  frame.sandbox.add("allow-scripts");
  const withHead = /<head[\s>]/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${HTML_FRAME_STYLE}`)
    : /<html[\s>]/i.test(html)
      ? html.replace(/<html([^>]*)>/i, `<html$1><head>${HTML_FRAME_STYLE}</head>`)
      : `<!doctype html><html><head>${HTML_FRAME_STYLE}</head><body>${html}</body></html>`;
  // The relay keeps Emacs keys working while an output has focus.
  frame.srcdoc = withHead + HTML_FRAME_AUTOSIZE + FRAME_KEY_RELAY_SCRIPT;
  autoHeightFrames.add(frame);
  return frame;
}

// Sage/SymPy often emit math as MathJax-flavoured text/html. MathJax never
// loads here, so detect a math-only payload and route it to KaTeX.
function htmlMathOnly(html: string): string | null {
  let text = String(html || "").trim();
  const script = /^<script[^>]*\btype=["']?math\/tex(?:;[^"'>]*)?["']?[^>]*>([\s\S]*?)<\/script>$/i.exec(text);
  if (script) return `\\[${(script[1] || "").trim()}\\]`;
  const wrapped = /^<(div|span|p)\b[^>]*>([\s\S]*)<\/\1>$/i.exec(text);
  if (wrapped) text = (wrapped[2] || "").trim();
  if (/<[a-z!/]/i.test(text)) return null;
  if (/^(\\\(|\\\[|\$\$|\$)/.test(text) && /(\\\)|\\\]|\$\$|\$)$/.test(text)) return text;
  return null;
}

// ---------------------------------------------------------------------------
// Custom renderers
// ---------------------------------------------------------------------------

const stockHtmlFactory = standardRendererFactories.find((factory) => factory.mimeTypes.includes("text/html"));

class NoemaMarkdownRenderer extends RenderedMarkdown {
  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    await super.renderModel(model);
    // OutputArea inserts its node directly into the host, so Lumino's
    // after-attach hook does not run for this nested Markdown renderer.
    katexTypesetter().typeset(this.node);
  }
}

class NoemaHtmlRenderer extends Widget implements IRenderMime.IRenderer {
  private readonly options: IRenderMime.IRendererOptions;

  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this.options = options;
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const html = mimeToString(model.data["text/html"]);
    const math = htmlMathOnly(html);
    if (math) {
      renderKatexInto(this.node, math);
      return;
    }
    if (/<script[\s>]/i.test(html)) {
      this.node.replaceChildren(makeScriptHtmlFrame(html));
      return;
    }
    if (stockHtmlFactory) {
      const inner = stockHtmlFactory.createRenderer(this.options);
      await inner.renderModel(model);
      // The stock renderer only runs its typesetter from Lumino's
      // onAfterAttach hook.  It is nested inside this adapter and therefore
      // never receives that hook itself; invoke the same shared KaTeX
      // typesetter explicitly so Sage show()/pretty_print MathJax-style HTML
      // is not left on screen as raw `\(...\)` source.
      katexTypesetter().typeset(inner.node);
      this.node.replaceChildren(inner.node);
      return;
    }
    this.node.innerHTML = html;
  }
}

class NoemaJsonRenderer extends Widget implements IRenderMime.IRenderer {
  private readonly mimeType: string;

  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this.mimeType = options.mimeType;
    this.addClass("jp-RenderedText");
    this.addClass("jp-RenderedJSON");
    this.node.dataset.mimeType = this.mimeType;
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const raw = model.data[this.mimeType];
    let value: unknown = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    let rendered: string;
    try {
      rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      rendered = String(value ?? "");
    }
    const pre = document.createElement("pre");
    pre.textContent = rendered ?? String(value ?? "");
    this.node.replaceChildren(pre);
  }
}



function jsonMimeTypesForOutput(output: unknown): string[] {
  const data = output && typeof output === "object" ? (output as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return [];
  return Object.keys(data).filter(
    (mimeType) => mimeType === "application/json" || /^application\/[\w.+-]+\+json$/i.test(mimeType),
  );
}

function addJsonMimeFactory(registry: RenderMimeRegistry, mimeType: string, rank: number): void {
  if (registry.mimeTypes.includes(mimeType)) return;
  registry.addFactory({
    safe: true,
    mimeTypes: [mimeType],
    createRenderer: (rendererOptions) => new NoemaJsonRenderer(rendererOptions),
  }, rank);
}

class WidgetViewRenderer extends Widget implements IRenderMime.IRenderer {
  private cleanup: (() => void) | null = null;
  private readonly runtime?: JupyterWidgetRuntimeRef;
  private readonly messages: unknown[];
  private readonly widgetOutputs?: WidgetOutputsMap;
  private readonly mountWidget?: WidgetMountFn;
  private token = "";

  constructor(options: RenderMimeOptions) {
    super();
    this.runtime = options.widgetRuntime;
    this.messages = options.widgetMessages ?? [];
    this.widgetOutputs = options.widgetOutputs;
    this.mountWidget = options.mountWidget;
    this.node.className = "cm-ceil-output-widget";
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const view = model.data[WIDGET_VIEW_MIMETYPE] as { model_id?: unknown } | undefined;
    const modelId = view && typeof view === "object" ? String(view.model_id || "") : "";
    const repr = mimeToString(model.data["text/plain"]);
    if (!modelId) {
      this.node.dataset.state = "error";
      this.node.textContent = "Invalid ipywidgets output: missing model_id.";
      return;
    }
    if (!this.runtime?.id || !this.runtime.name || !this.mountWidget) {
      this.node.dataset.state = "stale";
      this.node.textContent = repr
        ? `Interactive widget is no longer live — run the cell to reconnect.\n${repr}`
        : "Interactive widget is no longer live — run the cell to reconnect.";
      return;
    }
    const token = `${this.runtime.id}:${this.runtime.generation || 1}:${modelId}:${Date.now()}`;
    this.token = token;
    this.node.dataset.state = "loading";
    this.node.textContent = "Connecting interactive widget…";
    try {
      const cleanup = await this.mountWidget(this.node, modelId, this.runtime, this.messages, this.widgetOutputs);
      if (this.token !== token || this.isDisposed) {
        cleanup();
        return;
      }
      this.node.dataset.state = "live";
      this.cleanup = cleanup;
    } catch (error) {
      if (this.token !== token) return;
      this.node.dataset.state = "error";
      this.node.textContent = `Widget failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  dispose(): void {
    this.token = "";
    if (this.cleanup) {
      try { this.cleanup(); } catch {}
      this.cleanup = null;
    }
    super.dispose();
  }
}

// ---------------------------------------------------------------------------
// Registry + OutputArea
// ---------------------------------------------------------------------------

let sharedTypesetter: KatexTypesetter | null = null;

function katexTypesetter(): KatexTypesetter {
  sharedTypesetter ??= new KatexTypesetter();
  return sharedTypesetter;
}

// The stock JupyterLab factories with Noema's HTML (iframe/KaTeX) renderer
// and KaTeX LaTeX typesetter swapped in. Used both for cell outputs and inside
// the widget manager (which layers its own nested WidgetRenderer on top).
export function createBaseRenderMime(options: Pick<RenderMimeOptions, "markdownParser"> = {}): RenderMimeRegistry {
  const initialFactories = standardRendererFactories.filter(
    (factory) => !factory.mimeTypes.includes("text/html"),
  );
  const registry = new RenderMimeRegistry({
    initialFactories,
    latexTypesetter: katexTypesetter(),
    ...(options.markdownParser ? { markdownParser: options.markdownParser } : {}),
  });
  registry.addFactory({
    safe: false,
    mimeTypes: ["text/html"],
    createRenderer: (rendererOptions) => new NoemaHtmlRenderer(rendererOptions),
  }, 1);
  registry.addFactory({
    safe: true,
    mimeTypes: ["text/markdown"],
    createRenderer: (rendererOptions) => new NoemaMarkdownRenderer(rendererOptions),
  }, 60);

  registry.addFactory({
    safe: true,
    mimeTypes: ["application/json"],
    createRenderer: (rendererOptions) => new NoemaJsonRenderer(rendererOptions),
  }, 55);
  return registry;
}

export function createNoemaRenderMime(options: RenderMimeOptions = {}): RenderMimeRegistry {
  const registry = createBaseRenderMime(options);
  // Jupyter kernels and extensions frequently emit custom `+json` bundles.
  // JupyterLab only uses a vendor-specific renderer when its extension is
  // installed; otherwise keep text/plain ahead of this readable JSON
  // fallback, while still avoiding a blank output when JSON is the sole MIME.
  for (const mimeType of options.jsonMimeTypes || []) {
    if (mimeType === "application/json" || !/^application\/[\w.+-]+\+json$/i.test(mimeType)) continue;
    addJsonMimeFactory(registry, mimeType, 125);
  }
  registry.addFactory({
    safe: false,
    mimeTypes: [WIDGET_VIEW_MIMETYPE],
    createRenderer: () => new WidgetViewRenderer(options),
  }, 0);
  return registry;
}

// A single-source-of-truth OutputArea render. Returns a disposer that tears
// down the Lumino widget tree (including any mounted ipywidgets).
export function renderJupyterOutputs(
  host: HTMLElement,
  outputs: unknown[],
  options: RenderMimeOptions = {},
): JupyterOutputView {
  const jsonMimeTypes = new Set(options.jsonMimeTypes || []);
  for (const output of outputs) {
    for (const mimeType of jsonMimeTypesForOutput(output)) jsonMimeTypes.add(mimeType);
  }
  const rendermime = createNoemaRenderMime({ ...options, jsonMimeTypes: Array.from(jsonMimeTypes) });
  const model = new OutputAreaModel({ trusted: true });
  const area = new OutputArea({ model, rendermime });
  area.addClass("cm-ceil-output-area");
  host.appendChild(area.node);
  model.fromJSON(outputs as never);
  const dispose = (() => {
    try { area.dispose(); } catch {}
    try { model.dispose(); } catch {}
  }) as JupyterOutputView;
  dispose.clear = () => model.clear();
  dispose.setOutput = (index, output) => {
    if (!Number.isInteger(index) || index < 0) return;
    // A live cell can introduce a vendor +json MIME after its OutputArea was
    // created (for example, after clear_output). Register that readable
    // fallback before updating the model so the first event renders instead
    // of staying blank until a later full snapshot.
    for (const mimeType of jsonMimeTypesForOutput(output)) {
      if (mimeType !== "application/json") addJsonMimeFactory(rendermime, mimeType, 125);
    }
    if (index < model.length) model.set(index, output as never);
    else if (index === model.length) model.add(output as never);
  };
  return dispose;
}
